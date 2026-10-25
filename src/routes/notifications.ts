import { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import { notFound } from '../lib/errors.js'
import { uuid } from '../lib/validation.js'
import { requireAuth, type AuthVariables } from '../middleware/auth.js'

interface Row {
  id: string
  event: string
  title: string
  body: string | null
  link_path: string | null
  read_at: Date | null
  created_at: Date
}

/** /v1/notifications — G1.01 the bell: your own in-app notifications, newest first. */
export function notificationRoutes(deps: AppDeps) {
  const now = () => (deps.now ? deps.now() : new Date())
  return new Hono<{ Variables: AuthVariables }>()
    .use(requireAuth(deps))

    .get('/', async (c) => {
      const { memberId } = c.var.auth
      const limit = Math.min(Math.max(Number(c.req.query('limit')) || 20, 1), 100)
      const [rows, [count]] = await Promise.all([
        deps.sql<Row[]>`
          select id, event, title, body, link_path, read_at, created_at from public.notifications
          where recipient_member_id = ${memberId} order by created_at desc, id desc limit ${limit}
        `,
        deps.sql<{ n: number }[]>`select count(*)::int as n from public.notifications where recipient_member_id = ${memberId} and read_at is null`,
      ])
      return c.json({
        unread: count!.n,
        notifications: rows.map((r) => ({ id: r.id, event: r.event, title: r.title, body: r.body, link: r.link_path, readAt: r.read_at, createdAt: r.created_at })),
      })
    })

    .post('/read-all', async (c) => {
      await deps.sql`update public.notifications set read_at = ${now()} where recipient_member_id = ${c.var.auth.memberId} and read_at is null`
      return c.json({ unread: 0 })
    })

    .post('/:id/read', async (c) => {
      const id = c.req.param('id')
      if (!uuid.safeParse(id).success) throw notFound('Notification not found.')
      const [row] = await deps.sql`
        update public.notifications set read_at = coalesce(read_at, ${now()})
        where id = ${id} and recipient_member_id = ${c.var.auth.memberId} returning id
      `
      if (!row) throw notFound('Notification not found.')
      return c.body(null, 204)
    })
}
