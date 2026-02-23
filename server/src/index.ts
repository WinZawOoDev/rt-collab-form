import { Hono } from 'hono'
import { basicAuth } from 'hono/basic-auth'
import type { PrismaClient } from './generated/prisma/client'
import withPrisma from './lib/prisma'

type ContextWithPrisma = {
  Variables: {
    prisma: PrismaClient
  }
}

const app = new Hono<ContextWithPrisma>()

app.use('/api/*', basicAuth({
  username: 'admin',
  password: 'password'
}))

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

app.get('/api/data', (c) => {
  return c.json({ message: 'This is protected data.' })
});

app.get('/api/users', withPrisma, async (c) => {
  const prisma = c.get("prisma");
  const users = await prisma.user.findMany();
  return c.json({ users })
})

export default app
