import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { audit, isPg, PG } from '../lib/db.js'
import { AppError, badRequest } from '../lib/errors.js'
import { parseBody, personName, timeZone } from '../lib/validation.js'
import { requireIdentity, type IdentityVariables } from '../middleware/auth.js'

const CreateOrganisation = z.object({
  organisationName: z.string().trim().min(1, 'Required.').max(120),
  firstName: personName,
  lastName: personName,
  timeZone: timeZone.default('Africa/Lagos'),
})

const alreadyMember = () =>
  new AppError(409, 'already_member', 'This account already belongs to an organisation. One email can belong to one organisation.')

/**
 * POST /v1/organisations — admin sign-up (R1): a signed-in person with no organisation
 * creates one and becomes its owner. Organisation and owner are created together or not at all.
 */
export function organisationRoutes(deps: AppDeps) {
  return new Hono<{ Variables: IdentityVariables }>()
    .use(requireIdentity(deps))
    .post('/', async (c) => {
      const body = await parseBody(c, CreateOrganisation)
      const { userId, email } = c.var.identity
      if (!email) throw badRequest('Your account has no email address.')
      const normalisedEmail = email.trim().toLowerCase()

      try {
        const result = await deps.sql.begin(async (tx) => {
          const [existing] = await tx`
            select 1 from public.organisation_members
            where user_id = ${userId} or email = ${normalisedEmail}
          `
          if (existing) throw alreadyMember()

          const [organisation] = await tx<{ id: string; name: string; time_zone: string }[]>`
            insert into public.organisations (name, time_zone)
            values (${body.organisationName}, ${body.timeZone})
            returning id, name, time_zone
          `
          const [member] = await tx<{ id: string }[]>`
            insert into public.organisation_members
              (organisation_id, user_id, email, first_name, last_name, role, status, joined_at)
            values
              (${organisation!.id}, ${userId}, ${normalisedEmail}, ${body.firstName}, ${body.lastName},
               'owner', 'active', now())
            returning id
          `
          await audit(tx, {
            organisationId: organisation!.id,
            actorMemberId: member!.id,
            action: 'organisation.created',
            entityType: 'organisation',
            entityId: organisation!.id,
            requestId: c.var.requestId,
          })
          return { organisation: organisation!, memberId: member!.id }
        })

        return c.json(
          {
            organisation: {
              id: result.organisation.id,
              name: result.organisation.name,
              timeZone: result.organisation.time_zone,
            },
            membership: { id: result.memberId, organisationId: result.organisation.id, role: 'owner' },
          },
          201,
        )
      } catch (error) {
        // Two sign-up requests racing for the same email or user.
        if (isPg(error, PG.uniqueViolation)) throw alreadyMember()
        throw error
      }
    })
}
