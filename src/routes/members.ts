import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { audit, isPg, PG } from '../lib/db.js'
import { AppError, notFound } from '../lib/errors.js'
import { shortName } from '../lib/names.js'
import { invitationLink, issueInvitation, sendInvitationEmail } from '../lib/invitations.js'
import { email, fullName, parseBody, personName, uuid } from '../lib/validation.js'
import { requireAuth, requireRole, type AuthVariables } from '../middleware/auth.js'

/** Roles that can be invited. Owners are created at sign-up or by ownership transfer. */
const InvitableRole = z.enum(['admin', 'trainer', 'assistant_trainer', 'participant'])

/** Either one "Full name" (F1.02a) or first and last names (B2.03). */
const InviteMember = z
  .object({
    email,
    fullName: fullName.optional(),
    firstName: personName.optional(),
    lastName: personName.optional(),
    role: InvitableRole,
  })
  .superRefine((v, ctx) => {
    if (v.fullName) return
    if (!v.firstName) ctx.addIssue({ code: 'custom', path: ['firstName'], message: 'Required.' })
    if (!v.lastName) ctx.addIssue({ code: 'custom', path: ['lastName'], message: 'Required.' })
  })
  .transform((v) => ({ email: v.email, role: v.role, firstName: v.fullName?.firstName ?? v.firstName!, lastName: v.fullName?.lastName ?? v.lastName! }))

/** Staff roles an Owner or Admin can switch someone between (F1.02b). */
const ChangeRole = z.object({ role: z.enum(['admin', 'trainer', 'assistant_trainer']) })

const Role = z.enum(['owner', 'admin', 'trainer', 'assistant_trainer', 'participant'])

const ListQuery = z.object({
  // One role, or several separated by commas: ?role=trainer,assistant_trainer
  role: z
    .string()
    .transform((value) => value.split(',').filter(Boolean))
    .pipe(z.array(Role).min(1))
    .optional(),
  // "current" = invited or active: everyone except people who were removed.
  status: z.enum(['invited', 'active', 'deactivated', 'current']).optional(),
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
  last_sign_in_at?: Date | null
  /** Live (not archived) cohorts and courses this person teaches. */
  teaching?: { cohorts: { id: string; name: string }[]; courses: { id: string; name: string }[] }
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
  lastActiveAt: row.last_sign_in_at ?? null,
  teaching: row.teaching ?? { cohorts: [], courses: [] },
})

/** Cohorts and courses a member teaches, as JSON, for the B2.01 columns. */
const teachingSql = (sql: AppDeps['sql']) => sql`
  (select json_build_object(
     'cohorts', coalesce(json_agg(distinct jsonb_build_object('id', h.id, 'name', h.name)) filter (where h.id is not null), '[]'),
     'courses', coalesce(json_agg(distinct jsonb_build_object('id', co.id, 'name', co.name)) filter (where co.id is not null), '[]'))
   from public.cohort_course_trainers t
   join public.cohort_courses x on x.id = t.cohort_course_id
   join public.cohorts h on h.id = x.cohort_id and h.archived_at is null
   join public.courses co on co.id = x.course_id
   where t.member_id = m.id) as teaching`

/** History entries shown on the person's page (B2.02i "Invitation history"). */
const HISTORY_ACTIONS = ['member.invited', 'member.invitation_resent', 'member.invitation_renewed', 'member.joined']

interface DetailRow extends MemberRow {
  invited_by_first_name: string | null
  invited_by_last_name: string | null
}

interface HistoryRow {
  action: string
  created_at: Date
  actor_first_name: string | null
  actor_last_name: string | null
}

const emailInUse = () =>
  new AppError(409, 'email_in_use', 'This email is already in use on Synqop. One email can belong to one organisation.')

/** /v1/members — people in the caller's organisation. Owners and admins only (§03). */
export function memberRoutes(deps: AppDeps) {
  const now = deps.now ?? (() => new Date())

  /** Staff someone else can change: not the owner, not yourself, not participants (they're managed under Participants). */
  async function editable(rawId: string, organisationId: string, actorId: string) {
    const id = uuid.safeParse(rawId)
    if (!id.success) throw notFound('Member not found.')
    const [member] = await deps.sql<{ id: string; role: string; status: string; email: string }[]>`
      select id, role, status, email from public.organisation_members
      where id = ${id.data} and organisation_id = ${organisationId} and status <> 'deactivated' and role <> 'participant'
    `
    if (!member) throw notFound('Member not found.')
    if (member.role === 'owner') throw new AppError(409, 'owner', 'The owner’s role can’t be changed here.')
    if (member.id === actorId) throw new AppError(409, 'self', 'Ask another admin or the owner to change your own access.')
    return member
  }

  return new Hono<{ Variables: AuthVariables }>()
    .use(requireAuth(deps), requireRole('owner', 'admin'))

    .get('/', async (c) => {
      const query = ListQuery.safeParse(c.req.query())
      const filters = query.success ? query.data : {}
      const { organisationId } = c.var.auth
      const rows = await deps.sql<MemberRow[]>`
        select m.id, m.email, m.first_name, m.last_name, m.role, m.status, m.invited_at, m.joined_at,
               i.expires_at as invitation_expires_at, u.last_sign_in_at, ${teachingSql(deps.sql)}
        from public.organisation_members m
        left join public.invitations i
          on i.member_id = m.id and i.accepted_at is null and i.revoked_at is null
        left join auth.users u on u.id = m.user_id
        where m.organisation_id = ${organisationId}
          ${filters.role ? deps.sql`and m.role in ${deps.sql(filters.role)}` : deps.sql``}
          ${
            filters.status === 'current'
              ? deps.sql`and m.status <> 'deactivated'`
              : filters.status
                ? deps.sql`and m.status = ${filters.status}`
                : deps.sql``
          }
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
          // Someone removed from this organisation's staff comes back through a new invitation (F1.02c).
          const [removed] = await tx<{ id: string }[]>`
            select id from public.organisation_members
            where email = ${body.email} and organisation_id = ${organisationId} and status = 'deactivated' and role <> 'participant'
            for update
          `
          const [member] = removed
            ? await tx<MemberRow[]>`
                update public.organisation_members
                set first_name = ${body.firstName}, last_name = ${body.lastName}, role = ${body.role}, status = 'invited',
                    deactivated_at = null, invited_by = ${actorId}, invited_at = ${at}, joined_at = null
                where id = ${removed.id}
                returning id, email, first_name, last_name, role, status, invited_at, joined_at,
                          null::timestamptz as invitation_expires_at
              `
            : await tx<MemberRow[]>`
                insert into public.organisation_members
                  (organisation_id, email, first_name, last_name, role, status, invited_by, invited_at)
                values
                  (${organisationId}, ${body.email}, ${body.firstName}, ${body.lastName}, ${body.role},
                   'invited', ${actorId}, ${at})
                returning id, email, first_name, last_name, role, status, invited_at, joined_at,
                          null::timestamptz as invitation_expires_at
              `
          if (removed) await tx`update public.invitations set revoked_at = ${at} where member_id = ${removed.id} and accepted_at is null and revoked_at is null`
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

    // One person, with who invited them and their invitation history (B2.02 / B2.02i).
    .get('/:id', async (c) => {
      const id = uuid.safeParse(c.req.param('id'))
      if (!id.success) throw notFound('Member not found.')
      const { organisationId } = c.var.auth
      const [row] = await deps.sql<DetailRow[]>`
        select m.id, m.email, m.first_name, m.last_name, m.role, m.status, m.invited_at, m.joined_at,
               i.expires_at as invitation_expires_at,
               inviter.first_name as invited_by_first_name, inviter.last_name as invited_by_last_name,
               ${teachingSql(deps.sql)}
        from public.organisation_members m
        left join public.invitations i
          on i.member_id = m.id and i.accepted_at is null and i.revoked_at is null
        left join public.organisation_members inviter on inviter.id = m.invited_by
        where m.id = ${id.data} and m.organisation_id = ${organisationId}
      `
      if (!row) throw notFound('Member not found.')
      const history = await deps.sql<HistoryRow[]>`
        select e.action, e.created_at, actor.first_name as actor_first_name, actor.last_name as actor_last_name
        from public.audit_events e
        left join public.organisation_members actor on actor.id = e.actor_member_id
        where e.organisation_id = ${organisationId} and e.entity_type = 'member' and e.entity_id = ${row.id}
          and e.action in ${deps.sql(HISTORY_ACTIONS)}
        order by e.created_at desc, e.id desc
        limit 50
      `
      return c.json({
        member: {
          ...toMember(row),
          invitedBy: shortName(row.invited_by_first_name, row.invited_by_last_name),
        },
        history: history.map((entry) => ({
          action: entry.action,
          at: entry.created_at,
          actor: shortName(entry.actor_first_name, entry.actor_last_name),
        })),
      })
    })

    // Revoke: cancels the link and removes someone who never set a password.
    // They had no account or activity, so nothing is lost; the audit log keeps the record.
    .delete('/:id/invitation', async (c) => {
      const id = uuid.safeParse(c.req.param('id'))
      if (!id.success) throw notFound('Member not found.')
      const { organisationId, memberId: actorId } = c.var.auth

      await deps.sql.begin(async (tx) => {
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
        await audit(tx, {
          organisationId,
          actorMemberId: actorId,
          action: 'member.invitation_revoked',
          entityType: 'member',
          entityId: member.id,
          data: { email: member.email, firstName: member.first_name, lastName: member.last_name, role: member.role },
          requestId: c.var.requestId,
        })
        // Invitations cascade with the member.
        await tx`delete from public.organisation_members where id = ${member.id}`
      })
      return c.body(null, 204)
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

    // F1.02b Change role. Owners keep their role here; nobody changes their own.
    .patch('/:id/role', async (c) => {
      const body = await parseBody(c, ChangeRole)
      const { organisationId, memberId: actorId } = c.var.auth
      const member = await editable(c.req.param('id'), organisationId, actorId)
      if (member.role !== body.role) {
        await deps.sql.begin(async (tx) => {
          await tx`update public.organisation_members set role = ${body.role} where id = ${member.id}`
          await audit(tx, {
            organisationId,
            actorMemberId: actorId,
            action: 'member.role_changed',
            entityType: 'member',
            entityId: member.id,
            data: { from: member.role, to: body.role },
            requestId: c.var.requestId,
          })
        })
      }
      return c.json({ member: { ...member, role: body.role } })
    })

    // F1.02c Remove member: they can't sign in any more. What they recorded stays, with their name.
    // They come off the cohorts and courses they teach, and off sessions that haven't started.
    .delete('/:id', async (c) => {
      const { organisationId, memberId: actorId } = c.var.auth
      const member = await editable(c.req.param('id'), organisationId, actorId)
      if (member.status === 'invited') throw new AppError(409, 'still_invited', 'They haven’t joined yet. Cancel the invitation instead.')
      await deps.sql.begin(async (tx) => {
        const at = now()
        const taught = await tx`delete from public.cohort_course_trainers where member_id = ${member.id} returning cohort_course_id`
        await tx`update public.sessions set trainer_member_id = null where trainer_member_id = ${member.id} and starts_at > ${at}`
        await tx`update public.courses set default_lead_member_id = null where default_lead_member_id = ${member.id}`
        await tx`update public.programmes set lead_member_id = null where lead_member_id = ${member.id}`
        await tx`update public.organisation_members set status = 'deactivated', deactivated_at = ${at} where id = ${member.id}`
        await audit(tx, {
          organisationId,
          actorMemberId: actorId,
          action: 'member.removed',
          entityType: 'member',
          entityId: member.id,
          data: { role: member.role, email: member.email, cohortCourses: taught.length },
          requestId: c.var.requestId,
        })
      })
      return c.body(null, 204)
    })
}
