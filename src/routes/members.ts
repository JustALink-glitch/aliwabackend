import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { audit, isPg, PG } from '../lib/db.js'
import { AppError, notFound } from '../lib/errors.js'
import { invitationLink, issueInvitation, sendInvitationEmail } from '../lib/invitations.js'
import { email, parseBody, personName, uuid } from '../lib/validation.js'
import { requireAuth, requireRole, type AuthVariables } from '../middleware/auth.js'

/** Roles that can be invited. Owners are created at sign-up or by ownership transfer. */
const InvitableRole = z.enum(['admin', 'trainer', 'assistant_trainer', 'participant'])

const InviteMember = z.object({
  email,
  firstName: personName,
  lastName: personName,
  role: InvitableRole,
})

const ListQuery = z.object({
  role: z.enum(['owner', 'admin', 'trainer', 'assistant_trainer', 'participant']).optional(),
  status: z.enum(['invited', 'active', 'deactivated']).optional(),
})

interface MemberRow {
  id: string
  email: string
  first_name: string
  last_name: string
  role: string
  status: string
  invited_at: Date | null
  joined_at: Date | null
  invitation_expires_at: Date | null
}

const toMember = (row: MemberRow) => ({
  id: row.id,
  email: row.email,
  firstName: row.first_name,
  lastName: row.last_name,
  role: row.role,
  status: row.status,
  invitedAt: row.invited_at,
  joinedAt: row.joined_at,
  // Lets the UI show "Invitation pending" vs "Invitation expired" (B2.02i).
  invitationExpiresAt: row.invitation_expires_at,
})

const emailInUse = () =>
  new AppError(409, 'email_in_use', 'This email is already in use on Synqop. One email can belong to one organisation.')

/** /v1/members — people in the caller's organisation. Owners and admins only (§03). */
export function memberRoutes(deps: AppDeps) {
  const now = deps.now ?? (() => new Date())

  return new Hono<{ Variables: AuthVariables }>()
    .use(requireAuth(deps), requireRole('owner', 'admin'))

    .get('/', async (c) => {
      const query = ListQuery.safeParse(c.req.query())
      const filters = query.success ? query.data : {}
      const { organisationId } = c.var.auth
      const rows = await deps.sql<MemberRow[]>`
        select m.id, m.email, m.first_name, m.last_name, m.role, m.status, m.invited_at, m.joined_at,
               i.expires_at as invitation_expires_at
        from public.organisation_members m
        left join public.invitations i
          on i.member_id = m.id and i.accepted_at is null and i.revoked_at is null
        where m.organisation_id = ${organisationId}
          ${filters.role ? deps.sql`and m.role = ${filters.role}` : deps.sql``}
          ${filters.status ? deps.sql`and m.status = ${filters.status}` : deps.sql``}
        order by m.last_name, m.first_name
      `
      return c.json({ members: rows.map(toMember) })
    })

    // Invite a person: creates the member (status "invited") and emails a 72-hour link.
    .post('/', async (c) => {
      const body = await parseBody(c, InviteMember)
      const { organisationId, memberId: actorId } = c.var.auth
      const at = now()

      let created: { member: MemberRow; token: string; organisationName: string }
      try {
        created = await deps.sql.begin(async (tx) => {
          const [member] = await tx<MemberRow[]>`
            insert into public.organisation_members
              (organisation_id, email, first_name, last_name, role, status, invited_by, invited_at)
            values
              (${organisationId}, ${body.email}, ${body.firstName}, ${body.lastName}, ${body.role},
               'invited', ${actorId}, ${at})
            returning id, email, first_name, last_name, role, status, invited_at, joined_at,
                      null::timestamptz as invitation_expires_at
          `
          const { token, expiresAt } = await issueInvitation(tx, {
            organisationId,
            memberId: member!.id,
            invitedBy: actorId,
            now: at,
          })
          const [organisation] = await tx<{ name: string }[]>`
            select name from public.organisations where id = ${organisationId}
          `
          await audit(tx, {
            organisationId,
            actorMemberId: actorId,
            action: 'member.invited',
            entityType: 'member',
            entityId: member!.id,
            data: { role: body.role },
            requestId: c.var.requestId,
          })
          return { member: { ...member!, invitation_expires_at: expiresAt }, token, organisationName: organisation!.name }
        })
      } catch (error) {
        if (isPg(error, PG.uniqueViolation, 'organisation_members_email_key')) throw emailInUse()
        throw error
      }

      const emailSent = await sendInvitationEmail(deps.mailer, {
        to: created.member.email,
        firstName: created.member.first_name,
        organisationName: created.organisationName,
        role: created.member.role,
        link: invitationLink(deps.appUrl, created.token),
      })
      return c.json({ member: toMember(created.member), emailSent }, 201)
    })

    // Resend: cancels the old link and sends a new one.
    .post('/:id/invitation', async (c) => {
      const id = uuid.safeParse(c.req.param('id'))
      if (!id.success) throw notFound('Member not found.')
      const { organisationId, memberId: actorId } = c.var.auth
      const at = now()

      const result = await deps.sql.begin(async (tx) => {
        const [member] = await tx<MemberRow[]>`
          select id, email, first_name, last_name, role, status, invited_at, joined_at,
                 null::timestamptz as invitation_expires_at
          from public.organisation_members
          where id = ${id.data} and organisation_id = ${organisationId}
          for update
        `
        if (!member) throw notFound('Member not found.')
        if (member.status !== 'invited') {
          throw new AppError(409, 'already_joined', 'This person has already set their password.')
        }
        const { token, expiresAt } = await issueInvitation(tx, {
          organisationId,
          memberId: member.id,
          invitedBy: actorId,
          now: at,
        })
        await tx`update public.organisation_members set invited_at = ${at} where id = ${member.id}`
        const [organisation] = await tx<{ name: string }[]>`
          select name from public.organisations where id = ${organisationId}
        `
        await audit(tx, {
          organisationId,
          actorMemberId: actorId,
          action: 'member.invitation_resent',
          entityType: 'member',
          entityId: member.id,
          requestId: c.var.requestId,
        })
        return {
          member: { ...member, invited_at: at, invitation_expires_at: expiresAt },
          token,
          organisationName: organisation!.name,
        }
      })

      const emailSent = await sendInvitationEmail(deps.mailer, {
        to: result.member.email,
        firstName: result.member.first_name,
        organisationName: result.organisationName,
        role: result.member.role,
        link: invitationLink(deps.appUrl, result.token),
      })
      return c.json({ member: toMember(result.member), emailSent })
    })
}
