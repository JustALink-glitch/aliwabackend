import { Hono } from 'hono'
import type { AuthVariables } from '../middleware/auth.js'

/** GET /v1/me — who is signed in, their organisation and role. */
export const meRoutes = new Hono<{ Variables: AuthVariables }>().get('/', (c) => {
  const { userId, email, organisationId, role, memberId } = c.var.auth
  return c.json({ user: { id: userId, email }, membership: { id: memberId, organisationId, role } })
})
