import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { audit, isPg, PG } from '../lib/db.js'
import { AppError, notFound } from '../lib/errors.js'
import { shortName } from '../lib/names.js'
import { invitationLink, issueInvitation, sendInvitationEmail } from '../lib/invitations.js'
import { renderEmail } from '../lib/mailer.js'
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

const Assign = z.object({ cohortId: uuid, courseId: uuid, role: z.enum(['lead', 'assistant']) })

const EditDetails = z.object({
  fullName,
  email,
  phone: z
    .string()
    .trim()
    .max(40)
    .nullish()
    .transform((v) => v || null)
    .refine((v) => v === null || /^\+?[\d\s()-]{7,}$/.test(v), 'Enter a phone number, e.g. +234 806 555 0121.'),
})

const Deactivate = z.object({ notify: z.boolean().default(true) })

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
  /** Running and upcoming cohorts (not archived or completed) and the courses this person teaches there. */
  teaching?: { cohorts: { id: string; name: string }[]; courses: { id: string; name: string }[] }
  sessions_this_week?: number
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
  sessionsThisWeek: row.sessions_this_week ?? 0,
})

/** Cohorts and courses a member teaches, as JSON, for the B2.01 columns. */
const teachingSql = (sql: AppDeps['sql']) => sql`
  (select json_build_object(
     'cohorts', coalesce(json_agg(distinct jsonb_build_object('id', h.id, 'name', h.name)) filter (where h.id is not null), '[]'),
     'courses', coalesce(json_agg(distinct jsonb_build_object('id', co.id, 'name', co.name)) filter (where co.id is not null), '[]'))
   from public.cohort_course_trainers t
   join public.cohort_courses x on x.id = t.cohort_course_id
   join public.cohorts h on h.id = x.cohort_id and h.archived_at is null and public.status(h) <> 'completed'
   join public.courses co on co.id = x.course_id
   where t.member_id = m.id) as teaching,
  -- B2.01 Sessions this week (Monday to Sunday in the organisation's time zone) that they lead.
  (select count(*)::int from public.sessions s
     join public.organisations o on o.id = s.organisation_id
    where s.organisation_id = m.organisation_id and s.cancelled_at is null
      and coalesce(s.trainer_member_id, (select l.member_id from public.cohort_course_trainers l where l.cohort_course_id = s.cohort_course_id and l.is_lead limit 1)) = m.id
      and (s.starts_at at time zone o.time_zone) >= date_trunc('week', now() at time zone o.time_zone)
      and (s.starts_at at time zone o.time_zone) < date_trunc('week', now() at time zone o.time_zone) + interval '7 days') as sessions_this_week`

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

  /** A trainer or assistant (invited or active) who can be given courses. */
  async function trainer(rawId: string, organisationId: string) {
    const id = uuid.safeParse(rawId)
    if (!id.success) throw notFound('Trainer not found.')
    const [member] = await deps.sql<{ id: string; status: string }[]>`
      select id, status from public.organisation_members
      where id = ${id.data} and organisation_id = ${organisationId} and role in ('trainer', 'assistant_trainer')
    `
    if (!member) throw notFound('Trainer not found.')
    if (member.status === 'deactivated') throw new AppError(409, 'deactivated', 'This trainer is deactivated. Reactivate them first.')
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
      // B2.02: what they teach, per cohort, and their recent session reports.
      const [extra, assignments, reports] = await Promise.all([
        deps.sql<{ phone: string | null; last_sign_in_at: Date | null; deactivated_at: Date | null }[]>`
          select m.phone, u.last_sign_in_at, m.deactivated_at from public.organisation_members m left join auth.users u on u.id = m.user_id where m.id = ${row.id}
        `,
        deps.sql<{ cohort_course_id: string; course_id: string; course: string; cohort_id: string; cohort: string; cohort_status: string; is_lead: boolean; held: number; planned: number; next_at: Date | null }[]>`
          select x.id as cohort_course_id, co.id as course_id, co.name as course, h.id as cohort_id, h.name as cohort, public.status(h) as cohort_status, t.is_lead,
                 (select count(*)::int from public.sessions s where s.cohort_course_id = x.id and s.cancelled_at is null and s.ends_at <= now()) as held,
                 greatest(coalesce(x.planned_session_count, 0), (select count(*)::int from public.sessions s where s.cohort_course_id = x.id and s.cancelled_at is null)) as planned,
                 (select min(s.starts_at) from public.sessions s where s.cohort_course_id = x.id and s.cancelled_at is null and s.starts_at > now()) as next_at
          from public.cohort_course_trainers t
          join public.cohort_courses x on x.id = t.cohort_course_id
          join public.courses co on co.id = x.course_id
          join public.cohorts h on h.id = x.cohort_id and h.archived_at is null
          where t.member_id = ${row.id}
          order by (public.status(h) = 'active') desc, h.starts_on desc, co.name
        `,
        deps.sql<{ session_id: string; course: string; cohort: string; number: number; starts_at: Date; due_at: Date; submitted_at: Date | null }[]>`
          select s.id as session_id, co.name as course, h.name as cohort, s.starts_at,
                 (select count(*)::int from public.sessions y where y.cohort_course_id = s.cohort_course_id and y.cancelled_at is null and y.starts_at <= s.starts_at) as number,
                 s.ends_at + make_interval(hours => st.report_due_hours) as due_at, r.submitted_at
          from public.sessions s
          join public.cohort_courses x on x.id = s.cohort_course_id join public.courses co on co.id = x.course_id join public.cohorts h on h.id = x.cohort_id
          join public.organisation_settings st on st.organisation_id = s.organisation_id
          left join public.session_reports r on r.session_id = s.id
          where s.trainer_member_id = ${row.id} and s.cancelled_at is null and s.ends_at <= now()
          order by s.starts_at desc limit 5
        `,
      ])
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
          phone: extra[0]?.phone ?? null,
          lastActiveAt: extra[0]?.last_sign_in_at ?? null,
          deactivatedAt: extra[0]?.deactivated_at ?? null,
        },
        assignments: assignments.map((a) => ({
          cohortCourseId: a.cohort_course_id,
          course: { id: a.course_id, name: a.course },
          cohort: { id: a.cohort_id, name: a.cohort, status: a.cohort_status },
          lead: a.is_lead,
          held: a.held,
          planned: a.planned,
          nextSessionAt: a.next_at,
        })),
        reports: reports.map((r) => ({
          sessionId: r.session_id,
          course: r.course,
          cohort: r.cohort,
          number: r.number,
          startsAt: r.starts_at,
          status: r.submitted_at ? 'submitted' : r.due_at <= new Date() ? 'overdue' : 'due',
        })),
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

    // B2.04 Assign to a course in a cohort, as lead or assistant. A new lead moves the old one to assistant.
    .post('/:id/assignments', async (c) => {
      const body = await parseBody(c, Assign)
      const { organisationId, memberId: actorId } = c.var.auth
      const member = await trainer(c.req.param('id'), organisationId)
      const result = await deps.sql.begin(async (tx) => {
        const [cc] = await tx<{ id: string; course: string; cohort: string; status: string; assistants: boolean }[]>`
          select x.id, co.name as course, h.name as cohort, public.status(h) as status, st.assistants_enabled as assistants
          from public.cohort_courses x join public.courses co on co.id = x.course_id join public.cohorts h on h.id = x.cohort_id
          join public.organisation_settings st on st.organisation_id = x.organisation_id
          where x.organisation_id = ${organisationId} and x.cohort_id = ${body.cohortId} and x.course_id = ${body.courseId}
        `
        if (!cc) throw new AppError(400, 'bad_request', 'Some fields need attention.', [{ field: 'courseId', message: 'Choose a course this cohort runs.' }])
        if (cc.status === 'archived' || cc.status === 'completed') throw new AppError(400, 'bad_request', 'Some fields need attention.', [{ field: 'cohortId', message: 'Choose an active or upcoming cohort.' }])
        if (body.role === 'assistant' && !cc.assistants) throw new AppError(409, 'assistants_off', 'Your organisation doesn’t use assistant trainers. Turn them on in Settings › Programme setup.')
        let replaced: string | null = null
        if (body.role === 'lead') {
          const [old] = await tx<{ first_name: string; last_name: string }[]>`
            update public.cohort_course_trainers t set is_lead = false from public.organisation_members m
            where t.cohort_course_id = ${cc.id} and t.is_lead and t.member_id <> ${member.id} and m.id = t.member_id
            returning m.first_name, m.last_name
          `
          replaced = old ? `${old.first_name} ${old.last_name}` : null
        }
        await tx`
          insert into public.cohort_course_trainers (organisation_id, cohort_course_id, member_id, is_lead)
          values (${organisationId}, ${cc.id}, ${member.id}, ${body.role === 'lead'})
          on conflict (cohort_course_id, member_id) do update set is_lead = excluded.is_lead
        `
        await audit(tx, { organisationId, actorMemberId: actorId, action: 'member.assigned', entityType: 'member', entityId: member.id, data: { cohortCourseId: cc.id, role: body.role }, requestId: c.var.requestId })
        return { course: cc.course, cohort: cc.cohort, replaced }
      })
      return c.json(result)
    })

    .delete('/:id/assignments/:cohortCourseId', async (c) => {
      const { organisationId, memberId: actorId } = c.var.auth
      const member = await trainer(c.req.param('id'), organisationId)
      const ccId = uuid.safeParse(c.req.param('cohortCourseId'))
      if (!ccId.success) throw notFound('Assignment not found.')
      const [gone] = await deps.sql`
        delete from public.cohort_course_trainers where member_id = ${member.id} and cohort_course_id = ${ccId.data} and organisation_id = ${organisationId} returning id
      `
      if (!gone) throw notFound('Assignment not found.')
      await audit(deps.sql, { organisationId, actorMemberId: actorId, action: 'member.unassigned', entityType: 'member', entityId: member.id, data: { cohortCourseId: ccId.data }, requestId: c.var.requestId })
      return c.body(null, 204)
    })

    // B2.05 Edit details. A changed sign-in email is changed in Supabase Auth too, and the new address is told.
    .patch('/:id', async (c) => {
      const body = await parseBody(c, EditDetails)
      const { organisationId, memberId: actorId } = c.var.auth
      const id = uuid.safeParse(c.req.param('id'))
      if (!id.success) throw notFound('Member not found.')
      const [member] = await deps.sql<{ id: string; email: string; role: string; user_id: string | null; first_name: string }[]>`
        select id, email, role, user_id, first_name from public.organisation_members where id = ${id.data} and organisation_id = ${organisationId} and role <> 'participant'
      `
      if (!member) throw notFound('Member not found.')
      if (member.role === 'owner' && member.id !== actorId) throw new AppError(409, 'owner', 'Only the owner can change their own details.')
      const emailChanged = body.email !== member.email
      if (emailChanged) {
        const [taken] = await deps.sql`select 1 from public.organisation_members where email = ${body.email} and id <> ${member.id}`
        if (taken) throw new AppError(409, 'email_in_use', 'This email is already in use on Synqop.', [{ field: 'email', message: 'This email is already in use on Synqop.' }])
        if (member.user_id) {
          const result = await deps.authAdmin.updateEmail(member.user_id, body.email)
          if (!result.ok) throw new AppError(409, 'email_in_use', 'This email is already in use on Synqop.', [{ field: 'email', message: 'This email is already in use on Synqop.' }])
        }
      }
      await deps.sql.begin(async (tx) => {
        await tx`
          update public.organisation_members set first_name = ${body.fullName.firstName}, last_name = ${body.fullName.lastName}, email = ${body.email}, phone = ${body.phone}, updated_at = now()
          where id = ${member.id}
        `
        await audit(tx, { organisationId, actorMemberId: actorId, action: 'member.updated', entityType: 'member', entityId: member.id, data: { emailChanged }, requestId: c.var.requestId })
      })
      if (emailChanged && member.user_id) {
        const [org] = await deps.sql<{ name: string }[]>`select name from public.organisations where id = ${organisationId}`
        const { text, html } = renderEmail({
          title: 'Your sign-in email changed',
          intro: `Hi ${body.fullName.firstName}, your programme team at ${org!.name} changed the email you sign in to Synqop with. From now on, sign in with ${body.email}.`,
          buttonLabel: 'Sign in',
          buttonUrl: `${deps.appUrl.replace(/\/$/, '')}/sign-in`,
          note: 'If you didn’t expect this, contact your programme team.',
        })
        await deps.mailer.send({ to: body.email, subject: 'Your Synqop sign-in email changed', text, html }).catch((e) => console.error('Email change notice failed', e))
      }
      return c.json({ ok: true })
    })

    // B2.06 Deactivate: no more sign-in; what they recorded stays. Upcoming sessions show "No trainer". Reactivate later.
    .post('/:id/deactivate', async (c) => {
      const body = await parseBody(c, Deactivate)
      const { organisationId, memberId: actorId } = c.var.auth
      const member = await editable(c.req.param('id'), organisationId, actorId)
      if (member.status !== 'active') throw new AppError(409, 'not_active', 'Only someone who has joined can be deactivated. Cancel the invitation instead.')
      const at = now()
      await deps.sql.begin(async (tx) => {
        await tx`update public.sessions set trainer_member_id = null where trainer_member_id = ${member.id} and starts_at > ${at} and cancelled_at is null`
        await tx`update public.organisation_members set status = 'deactivated', deactivated_at = ${at} where id = ${member.id}`
        await audit(tx, { organisationId, actorMemberId: actorId, action: 'member.deactivated', entityType: 'member', entityId: member.id, requestId: c.var.requestId })
      })
      if (body.notify) {
        const [info] = await deps.sql<{ first_name: string; org: string }[]>`
          select m.first_name, o.name as org from public.organisation_members m join public.organisations o on o.id = m.organisation_id where m.id = ${member.id}
        `
        const { text, html } = renderEmail({
          title: `Your access to ${info!.org} has ended`,
          intro: `Hi ${info!.first_name}, your programme team at ${info!.org} has ended your access to Synqop. Thank you for your work with them.`,
          buttonLabel: 'Open Synqop',
          buttonUrl: `${deps.appUrl.replace(/\/$/, '')}/sign-in`,
          note: 'If you think this is a mistake, contact your programme team.',
        })
        await deps.mailer.send({ to: member.email, subject: `Your access to ${info!.org} has ended`, text, html }).catch((e) => console.error('Deactivation email failed', e))
      }
      return c.json({ ok: true })
    })

    .post('/:id/reactivate', async (c) => {
      const { organisationId, memberId: actorId } = c.var.auth
      const id = uuid.safeParse(c.req.param('id'))
      if (!id.success) throw notFound('Member not found.')
      const [member] = await deps.sql<{ id: string; status: string; user_id: string | null; role: string }[]>`
        select id, status, user_id, role from public.organisation_members where id = ${id.data} and organisation_id = ${organisationId}
      `
      if (!member) throw notFound('Member not found.')
      if (member.status !== 'deactivated' || !member.user_id) throw new AppError(409, 'not_deactivated', 'Only someone who was deactivated can be reactivated. Invite them instead.')
      await deps.sql.begin(async (tx) => {
        await tx`update public.organisation_members set status = 'active', deactivated_at = null where id = ${member.id}`
        await audit(tx, { organisationId, actorMemberId: actorId, action: 'member.reactivated', entityType: 'member', entityId: member.id, requestId: c.var.requestId })
      })
      return c.json({ ok: true })
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
