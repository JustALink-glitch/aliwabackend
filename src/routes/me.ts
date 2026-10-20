import { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import { requireAuth, type AuthVariables } from '../middleware/auth.js'

/** GET /v1/me — who is signed in, their organisation and role. */
export function meRoutes(deps: AppDeps) {
  return new Hono<{ Variables: AuthVariables }>()
    .use(requireAuth(deps))
    .get('/', async (c) => {
      const { userId, email, organisationId, role, memberId } = c.var.auth
      const [organisation] = await deps.sql<{ name: string; time_zone: string }[]>`
        select name, time_zone from public.organisations where id = ${organisationId}
      `
      return c.json({
        user: { id: userId, email },
        membership: { id: memberId, organisationId, role },
        organisation: organisation ? { id: organisationId, name: organisation.name, timeZone: organisation.time_zone } : null,
      })
    })
}
