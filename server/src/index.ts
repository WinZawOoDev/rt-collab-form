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
const jwtSecret = process.env.JWT_SECRET ?? 'dev-jwt-secret'

type ChatMessagePayload = {
  id: number
  author: string
  content: string
  timestamp: number
  authorId: number | null
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

async function broadcastMessage(message: ChatMessagePayload) {
  const payload = JSON.stringify(message)

  await Promise.all(
    [...messageStreams].map(async (stream) => {
      try {
        await stream.writeSSE({
          event: 'message',
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
    allowMethods: ['GET', 'POST', 'OPTIONS'],
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

  const messages = posts.map((post) => ({
    id: post.id,
    author: post.author?.name || post.author?.email || 'Unknown',
    content: post.content || '',
    timestamp: post.id,
    authorId: post.authorId,
  }))

  return c.json({ messages })
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

  const payload = {
    id: message.id,
    author: message.author?.name || message.author?.email || 'Unknown',
    content: message.content || '',
    timestamp: message.id,
    authorId: message.authorId,
  }

  await broadcastMessage(payload)

  return c.json({ message: payload })
})

export default app
