import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { sign, verify } from 'hono/jwt'
import { streamSSE, type SSEStreamingApi } from 'hono/streaming'
import type { PrismaClient } from './generated/prisma/client'
import withPrisma from './lib/prisma'

type ContextWithPrisma = {
  Variables: {
    prisma: PrismaClient
    authUser: {
      id: number
      email: string
      name: string | null
    }
  }
}

const app = new Hono<ContextWithPrisma>()
const messageStreams = new Set<SSEStreamingApi>()

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

type EvaluateMessagePayload = {
  id: number
  author: string
  content: string
  timestamp: number
  authorId: number | null
}

type PostWithAuthor = {
  id: number
  content: string | null
  authorId: number | null
  author: { name: string | null; email: string } | null
}

function mapPostToMessage(post: PostWithAuthor): EvaluateMessagePayload {
  return {
    id: post.id,
    author: post.author?.name || post.author?.email || 'Unknown',
    content: post.content || '',
    timestamp: post.id,
    authorId: post.authorId,
  }
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

async function verifyJwtToken(token: string) {
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

async function broadcast(event: string, data: unknown) {
  const payload = JSON.stringify(data)

  await Promise.all(
    [...messageStreams].map(async (stream) => {
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

app.get('/api/data', (c) => {
  return c.json({ message: 'This is protected data.' })
});

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

    messageStreams.add(stream)

    await stream.writeSSE({
      event: 'ready',
      data: 'connected',
    })

    const heartbeatId = setInterval(() => {
      void stream.writeSSE({ event: 'ping', data: 'keepalive' })
    }, 15000)

    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        clearInterval(heartbeatId)
        messageStreams.delete(stream)
        resolve()
      })
    })
  })
})

app.get('/api/users', withPrisma, async (c) => {
  const prisma = c.get("prisma");
  const users = await prisma.user.findMany();
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

  const messages = posts.map(mapPostToMessage)

  return c.json({ messages })
})

app.get('/api/evaluation-state', withPrisma, async (c) => {
  const prisma = c.get('prisma')
  const authUser = c.get('authUser')

  const user = await prisma.user.findUnique({ where: { email: authUser.email } })
  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  const draft = await prisma.evaluateDraft.findUnique({ where: { userId: user.id } })

  return c.json({
    state: {
      content: draft?.content ?? '',
      lexicalJson: draft?.lexicalJson ?? '',
      revision: draft?.revision ?? 0,
    },
  })
})

app.put('/api/evaluation-state', withPrisma, async (c) => {
  const prisma = c.get('prisma')
  const authUser = c.get('authUser')
  const body = await c.req.json<{ content?: string; lexicalJson?: string; baseRevision?: number }>()

  const user = await prisma.user.findUnique({ where: { email: authUser.email } })
  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  const content = body.content ?? ''
  const lexicalJson = body.lexicalJson ?? ''
  const baseRevision = body.baseRevision

  if (baseRevision !== undefined && (!Number.isInteger(baseRevision) || baseRevision < 0)) {
    return c.json({ error: 'Invalid baseRevision' }, 400)
  }

  const result = await prisma.$transaction(async (tx) => {
    const draft = await tx.evaluateDraft.findUnique({ where: { userId: user.id } })
    const currentRevision = draft?.revision ?? 0

    if (baseRevision !== undefined && baseRevision !== currentRevision) {
      return {
        conflict: true,
        state: {
          content: draft?.content ?? '',
          lexicalJson: draft?.lexicalJson ?? '',
          revision: currentRevision,
        },
      }
    }

    const saved = draft
      ? await tx.evaluateDraft.update({
          where: { userId: user.id },
          data: { content, lexicalJson, revision: { increment: 1 } },
        })
      : await tx.evaluateDraft.create({
          data: {
            userId: user.id,
            content,
            lexicalJson,
            revision: 1,
          },
        })

    return {
      conflict: false,
      state: {
        content: saved.content,
        lexicalJson: saved.lexicalJson,
        revision: saved.revision,
      },
    }
  })

  if (result.conflict) {
    return c.json({ error: 'Draft was modified elsewhere', state: result.state }, 409)
  }

  return c.json({ state: result.state })
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
      title: `message-${Date.now()}`,
      content,
      published: true,
      authorId: user.id,
    },
    include: { author: true },
  })

  const payload = mapPostToMessage(message)

  await broadcast('message', payload)

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

  await broadcast('message-update', payload)

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

  await broadcast('message-delete', { id })

  return c.json({ ok: true })
})

app.post('/api/typing', async (c) => {
  const authUser = c.get('authUser')
  const body = await c.req.json<{ isTyping?: boolean }>()

  await broadcast('typing', {
    userId: authUser.id,
    name: authUser.name || authUser.email,
    isTyping: Boolean(body.isTyping),
  })

  return c.json({ ok: true })
})

export default app
