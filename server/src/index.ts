import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { sign, verify } from 'hono/jwt'
import { streamSSE, type SSEStreamingApi } from 'hono/streaming'
import * as Y from 'yjs'
import type { PrismaClient } from './generated/prisma/client'
import type {
  ApiMessage,
  AwarenessState,
  SseAwarenessPayload,
  SseDraftUpdatePayload,
  SseMessageDeletePayload,
  SseTypingPayload,
} from '@shared/index'
import withPrisma from './lib/prisma'

type AuthUser = {
  id: number
  email: string
  name: string | null
}

type ContextWithPrisma = {
  Variables: {
    prisma: PrismaClient
    authUser: AuthUser
  }
}

const app = new Hono<ContextWithPrisma>()
const messageStreams = new Map<SSEStreamingApi, number>()
const awarenessStates = new Map<number, AwarenessState>()

function resolveJwtSecret() {
  const secret = process.env.JWT_SECRET
  const isProduction = process.env.NODE_ENV === 'production'

  if (isProduction) {
    if (!secret) {
      throw new Error('JWT_SECRET environment variable is required in production')
    }
    if (secret.length < 32) {
      throw new Error('JWT_SECRET must be at least 32 characters long in production')
    }
    return secret
  }

  if (!secret) {
    console.warn('JWT_SECRET is not set, falling back to an insecure development secret')
    return 'dev-jwt-secret'
  }

  return secret
}

const jwtSecret = resolveJwtSecret()

type PostWithAuthor = {
  id: number
  content: string | null
  authorId: number | null
  author: { name: string | null; email: string } | null
}

function mapPostToMessage(post: PostWithAuthor): ApiMessage {
  return {
    id: post.id,
    author: post.author?.name || post.author?.email || 'Unknown',
    content: post.content || '',
    timestamp: post.id,
    authorId: post.authorId,
  }
}

async function broadcast(event: string, data: unknown, excludeUserId?: number) {
  const payload = JSON.stringify(data)

  await Promise.all(
    [...messageStreams.entries()].map(async ([stream, userId]) => {
      if (excludeUserId !== undefined && userId === excludeUserId) {
        return
      }

      try {
        await stream.writeSSE({
          event,
          data: payload,
        })
      } catch {
        messageStreams.delete(stream)
      }
    }),
  )
}

const DRAFT_ID = 1

function encodeBase64(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

async function loadDraftDoc(prisma: PrismaClient) {
  const row = await prisma.teamDraft.findUnique({ where: { id: DRAFT_ID } })
  const doc = new Y.Doc()

  if (row?.state) {
    Y.applyUpdate(doc, decodeBase64(row.state))
    return { doc, row }
  }

  doc.get('root', Y.XmlText)
  const state = encodeBase64(Y.encodeStateAsUpdate(doc))

  const saved = row
    ? await prisma.teamDraft.update({ where: { id: DRAFT_ID }, data: { state } })
    : await prisma.teamDraft.create({ data: { id: DRAFT_ID, state, revision: 0 } })

  return { doc, row: saved }
}

async function saveDraftState(prisma: PrismaClient, doc: Y.Doc) {
  return prisma.teamDraft.update({
    where: { id: DRAFT_ID },
    data: { state: encodeBase64(Y.encodeStateAsUpdate(doc)) },
  })
}

function getBearerToken(header?: string | null) {
  if (!header) {
    return null
  }

  const [scheme, token] = header.split(' ')
  if (scheme !== 'Bearer' || !token) {
    return null
  }

  return token
}

async function verifyJwtToken(token: string): Promise<AuthUser | null> {
  try {
    const payload = (await verify(token, jwtSecret, 'HS256')) as {
      userId: number
      email: string
      name: string | null
    }

    if (!payload.userId || !payload.email) {
      return null
    }

    return {
      id: payload.userId,
      email: payload.email,
      name: payload.name ?? null,
    }
  } catch {
    return null
  }
}

app.use(
  '*',
  cors({
    origin: ['http://localhost:3000'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }),
)

app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/auth/login') {
    return next()
  }

  const token = getBearerToken(c.req.header('Authorization'))
  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const authUser = await verifyJwtToken(token)
  if (!authUser) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  c.set('authUser', authUser)
  return next()
})

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

app.get('/events/messages', (c) => {
  return streamSSE(c, async (stream) => {
    const token = c.req.query('token')
    if (!token) {
      await stream.writeSSE({ event: 'auth-error', data: 'unauthorized' })
      return
    }

    const authUser = await verifyJwtToken(token)
    if (!authUser) {
      await stream.writeSSE({ event: 'auth-error', data: 'unauthorized' })
      return
    }

    messageStreams.set(stream, authUser.id)

    await stream.writeSSE({
      event: 'ready',
      data: 'connected',
    })

    for (const [userId, state] of awarenessStates) {
      if (userId === authUser.id) {
        continue
      }
      const payload: SseAwarenessPayload = { userId, state }
      await stream.writeSSE({
        event: 'awareness',
        data: JSON.stringify(payload),
      })
    }

    const heartbeatId = setInterval(() => {
      void stream.writeSSE({ event: 'ping', data: 'keepalive' })
    }, 15000)

    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        clearInterval(heartbeatId)
        messageStreams.delete(stream)

        const hasOtherStreams = [...messageStreams.values()].some((userId) => userId === authUser.id)
        if (!hasOtherStreams && awarenessStates.has(authUser.id)) {
          awarenessStates.delete(authUser.id)
          const payload: SseAwarenessPayload = { userId: authUser.id, state: null }
          void broadcast('awareness', payload)
        }

        resolve()
      })
    })
  })
})

app.get('/api/users', withPrisma, async (c) => {
  const prisma = c.get('prisma')
  const users = await prisma.user.findMany()
  return c.json({ users })
})

app.post('/api/auth/login', withPrisma, async (c) => {
  const prisma = c.get('prisma')
  const body = await c.req.json<{ email: string; name?: string }>()

  const email = body.email?.trim().toLowerCase()
  const name = body.name?.trim() || null

  if (!email) {
    return c.json({ error: 'Email is required' }, 400)
  }

  const user = await prisma.user.upsert({
    where: { email },
    update: { name },
    create: { email, name },
  })

  const token = await sign(
    {
      userId: user.id,
      email: user.email,
      name: user.name,
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
    },
    jwtSecret,
  )

  return c.json({ user, token })
})

app.get('/api/auth/me', (c) => {
  const authUser = c.get('authUser')
  return c.json({ user: authUser })
})

app.get('/api/messages', withPrisma, async (c) => {
  const prisma = c.get('prisma')

  const posts = await prisma.post.findMany({
    where: { published: true },
    include: { author: true },
    orderBy: { id: 'asc' },
  })

  return c.json({ messages: posts.map(mapPostToMessage) })
})

app.post('/api/messages', withPrisma, async (c) => {
  const prisma = c.get('prisma')
  const body = await c.req.json<{ content: string }>()
  const authUser = c.get('authUser')

  const content = body.content?.trim()

  if (!content) {
    return c.json({ error: 'Content is required' }, 400)
  }

  const user = await prisma.user.findUnique({ where: { email: authUser.email } })
  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  const message = await prisma.post.create({
    data: {
      content,
      published: true,
      authorId: user.id,
    },
    include: { author: true },
  })

  const payload = mapPostToMessage(message)

  await broadcast('message', payload, authUser.id)

  return c.json({ message: payload })
})

app.put('/api/messages/:id', withPrisma, async (c) => {
  const prisma = c.get('prisma')
  const authUser = c.get('authUser')

  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: 'Invalid message id' }, 400)
  }

  const body = await c.req.json<{ content: string }>()
  const content = body.content?.trim()
  if (!content) {
    return c.json({ error: 'Content is required' }, 400)
  }

  const post = await prisma.post.findUnique({ where: { id }, include: { author: true } })
  if (!post || !post.published) {
    return c.json({ error: 'Message not found' }, 404)
  }

  if (post.authorId !== authUser.id) {
    return c.json({ error: 'You can only edit your own messages' }, 403)
  }

  const updated = await prisma.post.update({
    where: { id },
    data: { content },
    include: { author: true },
  })

  const payload = mapPostToMessage(updated)

  await broadcast('message-update', payload, authUser.id)

  return c.json({ message: payload })
})

app.delete('/api/messages/:id', withPrisma, async (c) => {
  const prisma = c.get('prisma')
  const authUser = c.get('authUser')

  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: 'Invalid message id' }, 400)
  }

  const post = await prisma.post.findUnique({ where: { id } })
  if (!post || !post.published) {
    return c.json({ error: 'Message not found' }, 404)
  }

  if (post.authorId !== authUser.id) {
    return c.json({ error: 'You can only delete your own messages' }, 403)
  }

  await prisma.post.delete({ where: { id } })

  const payload: SseMessageDeletePayload = { id }
  await broadcast('message-delete', payload, authUser.id)

  return c.json({ ok: true })
})

app.post('/api/typing', async (c) => {
  const authUser = c.get('authUser')
  const body = await c.req.json<{ isTyping?: boolean }>()

  const payload: SseTypingPayload = {
    userId: authUser.id,
    name: authUser.name || authUser.email,
    isTyping: Boolean(body.isTyping),
  }

  await broadcast('typing', payload, authUser.id)

  return c.json({ ok: true })
})

app.post('/api/awareness', async (c) => {
  const authUser = c.get('authUser')
  const body = await c.req.json<{ state?: AwarenessState | null }>()

  if (body.state === null || body.state === undefined) {
    awarenessStates.delete(authUser.id)
  } else {
    awarenessStates.set(authUser.id, body.state)
  }

  const payload: SseAwarenessPayload = {
    userId: authUser.id,
    state: body.state ?? null,
  }

  await broadcast('awareness', payload, authUser.id)

  return c.json({ ok: true })
})

app.get('/api/team-draft', withPrisma, async (c) => {
  const prisma = c.get('prisma')
  const { doc, row } = await loadDraftDoc(prisma)

  const stateVectorParam = c.req.query('stateVector')
  if (stateVectorParam) {
    try {
      const stateVector = decodeBase64(stateVectorParam)
      const update = Y.encodeStateAsUpdate(doc, stateVector)
      return c.json({ state: encodeBase64(update), revision: row.revision })
    } catch {
      return c.json({ error: 'Invalid stateVector' }, 400)
    }
  }

  return c.json({
    state: encodeBase64(Y.encodeStateAsUpdate(doc)),
    revision: row.revision,
  })
})

app.post('/api/team-draft', withPrisma, async (c) => {
  const prisma = c.get('prisma')
  const authUser = c.get('authUser')
  const body = await c.req.json<{ update?: string; baseRevision?: number }>()

  if (!body.update) {
    return c.json({ error: 'Update is required' }, 400)
  }

  if (body.baseRevision === undefined || !Number.isInteger(body.baseRevision) || body.baseRevision < 0) {
    return c.json({ error: 'Invalid baseRevision' }, 400)
  }

  let update: Uint8Array
  try {
    update = decodeBase64(body.update)
  } catch {
    return c.json({ error: 'Invalid update' }, 400)
  }

  const { doc } = await loadDraftDoc(prisma)

  const claimed = await prisma.teamDraft.updateMany({
    where: { id: DRAFT_ID, revision: body.baseRevision },
    data: { revision: body.baseRevision + 1 },
  })

  if (claimed.count !== 1) {
    const current = await prisma.teamDraft.findUnique({ where: { id: DRAFT_ID } })
    return c.json(
      {
        error: 'Draft was modified elsewhere',
        state: current?.state ?? '',
        revision: current?.revision ?? 0,
      },
      409,
    )
  }

  Y.applyUpdate(doc, update)
  await saveDraftState(prisma, doc)

  const nextRevision = body.baseRevision + 1
  const payload: SseDraftUpdatePayload = {
    update: body.update,
    revision: nextRevision,
    authorId: authUser.id,
  }

  await broadcast('draft-update', payload, authUser.id)

  return c.json({ revision: nextRevision })
})

export default app
