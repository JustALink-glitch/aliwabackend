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
      // Name shown in the top bar and account menu (G1.03).
      const [member] = await deps.sql<{ first_name: string; last_name: string }[]>`
        select first_name, last_name from public.organisation_members where id = ${memberId}
      `
      return c.json({
        user: { id: userId, email },
        membership: { id: memberId, organisationId, role, firstName: member?.first_name ?? '', lastName: member?.last_name ?? '' },
        organisation: organisation ? { id: organisationId, name: organisation.name, timeZone: organisation.time_zone } : null,
      })
    })
}
