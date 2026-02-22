import { Hono } from 'hono'
import { basicAuth } from 'hono/basic-auth'

const app = new Hono()

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

export default app
