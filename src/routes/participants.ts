import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { audit, isPg, PG, type Sql, type Tx } from '../lib/db.js'
import { AppError, notFound } from '../lib/errors.js'
import { INVITATION_TTL_HOURS, invitationLink, issueInvitation, sendInvitationEmail } from '../lib/invitations.js'
import { renderEmail } from '../lib/mailer.js'
import { shortName } from '../lib/names.js'
import { isoDate, optionalText, parseBody, uuid } from '../lib/validation.js'
import { requireAuth, requireRole, type AuthVariables } from '../middleware/auth.js'

/** Most rows a single import may contain (B1.03a). */
export const IMPORT_MAX_ROWS = 500

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

const phone = z
  .string()
  .trim()
  .max(40)
  .nullish()
  .transform((value) => (value ? value : null))

const twoPartName = z
  .string()
  .trim()
  .transform((value) => value.replace(/\s+/g, ' '))
  .pipe(z.string().min(1, 'Enter their full name.').max(160).refine((value) => value.includes(' '), 'Enter their first and last name.'))

const AddParticipant = z.object({
  fullName: twoPartName,
  email: z.string().trim().toLowerCase().pipe(z.email('Enter an email address like name@organisation.org.').max(254)),
  phone,
  cohortId: uuid,
  sendEmail: z.boolean().default(true),
})

const ImportRow = z.object({
  full_name: z.string().max(200).nullish(),
  email: z.string().max(300).nullish(),
  phone: z.string().max(60).nullish(),
})

const ImportBody = z.object({
  cohortId: uuid,
  fileName: z.string().trim().max(200).default('participants.csv'),
  rows: z.array(ImportRow).min(1, 'The file has no rows.').max(IMPORT_MAX_ROWS, `Up to ${IMPORT_MAX_ROWS} rows per file.`),
  sendEmails: z.boolean().default(true),
})

const EditParticipant = z.object({
  fullName: twoPartName,
  email: z.string().trim().toLowerCase().pipe(z.email('Enter an email address like name@organisation.org.').max(254)),
  phone,
})

const Defer = z.object({
  effectiveOn: isoDate.optional(),
  reason: z.string().trim().min(1, 'Choose a reason.').max(120),
  note: optionalText(1000),
  /** An upcoming cohort in the same programme to join later, or null to decide later. */
  toCohortId: uuid.nullish().transform((value) => value ?? null),
  notify: z.boolean().default(true),
})

const Withdraw = z.object({
  effectiveOn: isoDate.optional(),
  reason: z.string().trim().min(1, 'Choose a reason.').max(120),
  note: optionalText(1000),
  notify: z.boolean().default(true),
})

const Transfer = z.object({
  toCohortId: uuid,
  reason: optionalText(500),
  notify: z.boolean().default(true),
})

/** "Amara Grace Okafor" → first "Amara Grace", last "Okafor". Names are validated to have two parts. */
function splitName(fullName: string): { firstName: string; lastName: string } {
  const clean = fullName.trim().replace(/\s+/g, ' ')
  const cut = clean.lastIndexOf(' ')
  return { firstName: clean.slice(0, cut).slice(0, 80), lastName: clean.slice(cut + 1).slice(0, 80) }
}

interface CohortRow {
  id: string
  name: string
  programme_id: string
  programme_name: string
  status: string
  organisation_name: string
}

async function findCohort(sql: Sql | Tx, organisationId: string, id: string): Promise<CohortRow> {
  const [row] = await sql<CohortRow[]>`
    select c.id, c.name, c.programme_id, p.name as programme_name, public.status(c) as status, o.name as organisation_name
    from public.cohorts c
    join public.programmes p on p.id = c.programme_id
    join public.organisations o on o.id = c.organisation_id
    where c.id = ${id} and c.organisation_id = ${organisationId}
  `
  if (!row) throw new AppError(400, 'bad_request', 'Some fields need attention.', [{ field: 'cohortId', message: 'Choose a cohort.' }])
  return row
}

function requireOpenCohort(cohort: CohortRow) {
  if (cohort.status === 'archived' || cohort.status === 'completed') {
    throw new AppError(409, 'cohort_closed', `${cohort.name} has ${cohort.status === 'archived' ? 'been archived' : 'ended'}. Choose an active or upcoming cohort.`, [
      { field: 'cohortId', message: 'Choose an active or upcoming cohort.' },
    ])
  }
}

async function allowsMultipleCohorts(sql: Sql | Tx, organisationId: string): Promise<boolean> {
  const [row] = await sql<{ allow: boolean }[]>`
    select allow_multi_cohort_enrolment as allow from public.organisation_settings where organisation_id = ${organisationId}
  `
  return row?.allow ?? false
}

type RowCheck =
  | { ok: true; existingMemberId: string | null }
  | { ok: false; code: string; message: string; field: 'full_name' | 'email'; cohortName?: string; memberId?: string }

/**
 * Whether a person can be enrolled in the cohort. Shared by Add participant (B1.02/b) and import review (B1.03b).
 * Someone already in this organisation as a participant is enrolled again rather than invited twice.
 */
async function checkPerson(
  tx: Sql | Tx,
  input: { organisationId: string; cohort: CohortRow; email: string; multi: boolean },
): Promise<RowCheck> {
  const [member] = await tx<{ id: string; organisation_id: string; role: string; status: string }[]>`
    select id, organisation_id, role, status from public.organisation_members where email = ${input.email}
  `
  if (!member) return { ok: true, existingMemberId: null }
  if (member.organisation_id !== input.organisationId || member.role !== 'participant') {
    return { ok: false, code: 'email_in_use', field: 'email', message: 'This email is already used on Synqop by someone else.' }
  }
  if (member.status === 'deactivated') {
    return { ok: false, code: 'access_ended', field: 'email', message: 'This person’s access was ended.' }
  }
  const enrolments = await tx<{ cohort_id: string; cohort_name: string; status: string; cohort_status: string }[]>`
    select e.cohort_id, c.name as cohort_name, e.status, public.status(c) as cohort_status
    from public.enrolments e join public.cohorts c on c.id = e.cohort_id
    where e.member_id = ${member.id}
  `
  const here = enrolments.find((e) => e.cohort_id === input.cohort.id)
  if (here) {
    return { ok: false, code: 'already_enrolled', field: 'email', message: `Already in ${input.cohort.name}`, cohortName: input.cohort.name, memberId: member.id }
  }
  if (!input.multi) {
    const current = enrolments.find((e) => e.status === 'active' && ['active', 'upcoming', 'draft'].includes(e.cohort_status))
    if (current) {
      return { ok: false, code: 'one_cohort_only', field: 'email', message: `Already in ${current.cohort_name}`, cohortName: current.cohort_name, memberId: member.id }
    }
  }
  return { ok: true, existingMemberId: member.id }
}

/** Creates (or reuses) the participant and enrols them. Returns the invitation token for new people. */
async function enrol(
  tx: Tx,
  input: {
    organisationId: string
    actorId: string
    cohort: CohortRow
    fullName: string
    email: string
    phone: string | null
    existingMemberId: string | null
    source: 'manual' | 'import'
    now: Date
    requestId: string
  },
): Promise<{ memberId: string; firstName: string; token: string | null; expiresAt: Date | null }> {
  let memberId = input.existingMemberId
  let token: string | null = null
  let expiresAt: Date | null = null
  const { firstName, lastName } = splitName(input.fullName)
  if (!memberId) {
    const [member] = await tx<{ id: string }[]>`
      insert into public.organisation_members
        (organisation_id, email, first_name, last_name, phone, role, status, invited_by, invited_at)
      values
        (${input.organisationId}, ${input.email}, ${firstName}, ${lastName}, ${input.phone}, 'participant',
         'invited', ${input.actorId}, ${input.now})
      returning id
    `
    memberId = member!.id
    ;({ token, expiresAt } = await issueInvitation(tx, {
      organisationId: input.organisationId,
      memberId,
      invitedBy: input.actorId,
      now: input.now,
    }))
    await audit(tx, {
      organisationId: input.organisationId,
      actorMemberId: input.actorId,
      action: 'member.invited',
      entityType: 'member',
      entityId: memberId,
      data: { role: 'participant', source: input.source },
      requestId: input.requestId,
    })
  }
  await tx`
    insert into public.enrolments (organisation_id, cohort_id, member_id)
    values (${input.organisationId}, ${input.cohort.id}, ${memberId})
  `
  await audit(tx, {
    organisationId: input.organisationId,
    actorMemberId: input.actorId,
    action: 'participant.enrolled',
    entityType: 'member',
    entityId: memberId,
    data: { cohortId: input.cohort.id, cohortName: input.cohort.name, source: input.source },
    requestId: input.requestId,
  })
  return { memberId, firstName, token, expiresAt }
}

interface ListRow {
  id: string
  email: string
  first_name: string
  last_name: string
  phone: string | null
  status: string
  invited_at: Date | null
  joined_at: Date | null
  invitation_expires_at: Date | null
  last_sign_in_at: Date | null
  enrolment_id: string | null
  enrolment_status: string | null
  enrolled_at: Date | null
  cohort_id: string | null
  cohort_name: string | null
  cohort_status: string | null
  programme_name: string | null
  present: number | null
  recorded: number | null
}

const toListItem = (row: ListRow) => ({
  id: row.id,
  email: row.email,
  firstName: row.first_name,
  lastName: row.last_name,
  phone: row.phone,
  status: row.status,
  invitedAt: row.invited_at,
  joinedAt: row.joined_at,
  invitationExpiresAt: row.invitation_expires_at,
  lastSignInAt: row.last_sign_in_at,
  enrolment: row.enrolment_id
    ? {
        id: row.enrolment_id,
        status: row.enrolment_status,
        enrolledAt: row.enrolled_at,
        cohort: { id: row.cohort_id, name: row.cohort_name, status: row.cohort_status },
        programmeName: row.programme_name,
        // Attendance % in this cohort: present ÷ recorded (excused counts as not present).
        attendance: row.recorded ? { present: row.present ?? 0, recorded: row.recorded, rate: Math.round(((row.present ?? 0) / row.recorded) * 100) } : null,
      }
    : null,
})

async function sendChangeEmail(
  deps: AppDeps,
  input: { to: string; firstName: string; organisationName: string; title: string; intro: string },
): Promise<boolean> {
  const { text, html } = renderEmail({
    title: input.title,
    intro: `Hi ${input.firstName}, ${input.intro}`,
    buttonLabel: 'Open Synqop',
    buttonUrl: `${deps.appUrl.replace(/\/$/, '')}/sign-in`,
    note: `If you have questions, reply to your programme team at ${input.organisationName}.`,
  })
  try {
    await deps.mailer.send({ to: input.to, subject: input.title, text, html })
    return true
  } catch (error) {
    console.error('Enrolment email failed', error)
    return false
  }
}

/** /v1/participants — B1. Owners and admins. */
export function participantRoutes(deps: AppDeps) {
  const now = deps.now ?? (() => new Date())

  async function findParticipant(sql: Sql | Tx, organisationId: string, id: string) {
    if (!uuid.safeParse(id).success) throw notFound('Participant not found.')
    const [row] = await sql<
      {
        id: string
        email: string
        first_name: string
        last_name: string
        phone: string | null
        status: string
        user_id: string | null
        invited_at: Date | null
        joined_at: Date | null
        invitation_expires_at: Date | null
        invitation_sent_at: Date | null
        last_sign_in_at: Date | null
        organisation_name: string
      }[]
    >`
      select m.id, m.email, m.first_name, m.last_name, m.phone, m.status, m.user_id, m.invited_at, m.joined_at,
             i.expires_at as invitation_expires_at, i.sent_at as invitation_sent_at,
             u.last_sign_in_at, o.name as organisation_name
      from public.organisation_members m
      join public.organisations o on o.id = m.organisation_id
      left join public.invitations i on i.member_id = m.id and i.accepted_at is null and i.revoked_at is null
      left join auth.users u on u.id = m.user_id
      where m.id = ${id} and m.organisation_id = ${organisationId} and m.role = 'participant'
    `
    if (!row) throw notFound('Participant not found.')
    return row
  }

  async function findEnrolment(tx: Tx, memberId: string, enrolmentId: string) {
    if (!uuid.safeParse(enrolmentId).success) throw notFound('Enrolment not found.')
    const [row] = await tx<{ id: string; cohort_id: string; cohort_name: string; programme_id: string; status: string }[]>`
      select e.id, e.cohort_id, c.name as cohort_name, c.programme_id, e.status
      from public.enrolments e join public.cohorts c on c.id = e.cohort_id
      where e.id = ${enrolmentId} and e.member_id = ${memberId}
      for update of e
    `
    if (!row) throw notFound('Enrolment not found.')
    if (row.status !== 'active') {
      throw new AppError(409, 'enrolment_not_active', 'Only an active enrolment can be changed.')
    }
    return row
  }

  /** Another cohort in the same programme that the participant can join. */
  async function findTargetCohort(tx: Tx, organisationId: string, programmeId: string, cohortId: string, statuses: string[]) {
    const [row] = await tx<{ id: string; name: string }[]>`
      select c.id, c.name from public.cohorts c
      where c.id = ${cohortId} and c.organisation_id = ${organisationId} and c.programme_id = ${programmeId}
        and public.status(c) in ${tx(statuses)}
    `
    if (!row) {
      throw new AppError(400, 'bad_request', 'Some fields need attention.', [
        { field: 'toCohortId', message: 'Choose a cohort in the same programme.' },
      ])
    }
    return row
  }

  return (
    new Hono<{ Variables: AuthVariables }>()
      .use(requireAuth(deps), requireRole('owner', 'admin'))

      // B1.01 (all participants) and A3.03 (?cohortId= — everyone enrolled in that cohort).
      .get('/', async (c) => {
        const { organisationId } = c.var.auth
        const cohortId = uuid.safeParse(c.req.query('cohortId'))
        const rows = await deps.sql<ListRow[]>`
          select m.id, m.email, m.first_name, m.last_name, m.phone, m.status, m.invited_at, m.joined_at,
                 i.expires_at as invitation_expires_at, u.last_sign_in_at,
                 e.id as enrolment_id, e.status as enrolment_status, e.enrolled_at,
                 ch.id as cohort_id, ch.name as cohort_name, public.status(ch) as cohort_status, p.name as programme_name,
                 att.present, att.recorded
          from public.organisation_members m
          left join public.invitations i on i.member_id = m.id and i.accepted_at is null and i.revoked_at is null
          left join auth.users u on u.id = m.user_id
          ${
            cohortId.success
              ? deps.sql`join public.enrolments e on e.member_id = m.id and e.cohort_id = ${cohortId.data}`
              : deps.sql`left join lateral (
                  select x.* from public.enrolments x where x.member_id = m.id
                  order by (x.status = 'active') desc, x.enrolled_at desc limit 1
                ) e on true`
          }
          left join public.cohorts ch on ch.id = e.cohort_id
          left join public.programmes p on p.id = ch.programme_id
          left join lateral (
            select count(*) filter (where a.status = 'present')::int as present, count(*)::int as recorded
            from public.attendance_records a
            join public.sessions s on s.id = a.session_id and s.cancelled_at is null
            join public.cohort_courses x on x.id = s.cohort_course_id
            where a.member_id = m.id and x.cohort_id = ch.id
          ) att on true
          where m.organisation_id = ${organisationId} and m.role = 'participant'
          order by m.first_name, m.last_name
        `
        const items = rows.map(toListItem)
        const inCohortStatus = (status: string) =>
          items.filter((p) => p.enrolment?.status === 'active' && p.enrolment.cohort.status === status).length
        return c.json({
          participants: items,
          summary: { inActiveCohorts: inCohortStatus('active'), inUpcomingCohorts: inCohortStatus('upcoming') },
        })
      })

      // B1.02 Add participant.
      .post('/', async (c) => {
        const body = await parseBody(c, AddParticipant)
        const { organisationId, memberId: actorId } = c.var.auth
        const at = now()
        const cohort = await findCohort(deps.sql, organisationId, body.cohortId)
        requireOpenCohort(cohort)

        let result: Awaited<ReturnType<typeof enrol>>
        try {
          result = await deps.sql.begin(async (tx) => {
            const multi = await allowsMultipleCohorts(tx, organisationId)
            const check = await checkPerson(tx, { organisationId, cohort, email: body.email, multi })
            if (!check.ok) {
              throw new AppError(409, check.code, check.message, {
                field: check.field,
                cohortName: check.cohortName,
                memberId: check.memberId,
              })
            }
            return enrol(tx, {
              organisationId,
              actorId,
              cohort,
              fullName: body.fullName,
              email: body.email,
              phone: body.phone,
              existingMemberId: check.existingMemberId,
              source: 'manual',
              now: at,
              requestId: c.var.requestId,
            })
          })
        } catch (error) {
          if (isPg(error, PG.uniqueViolation)) {
            throw new AppError(409, 'email_in_use', 'This email is already used on Synqop by someone else.', { field: 'email' })
          }
          throw error
        }

        let emailSent: boolean | null = null
        if (result.token && body.sendEmail) {
          emailSent = await sendInvitationEmail(deps.mailer, {
            to: body.email,
            firstName: result.firstName,
            organisationName: cohort.organisation_name,
            role: 'participant',
            link: invitationLink(deps.appUrl, result.token),
          })
        }
        return c.json(
          { participant: { id: result.memberId }, invited: Boolean(result.token), emailSent, invitationExpiresAt: result.expiresAt },
          201,
        )
      })

      // B1.03b Review rows: checks every row without saving anything.
      .post('/import/preview', async (c) => {
        const body = await parseBody(c, ImportBody)
        const { organisationId } = c.var.auth
        const cohort = await findCohort(deps.sql, organisationId, body.cohortId)
        requireOpenCohort(cohort)
        const rows = await reviewRows(deps.sql, organisationId, cohort, body.rows)
        return c.json({ cohort: { id: cohort.id, name: cohort.name }, rows })
      })

      // B1.03c Import: adds the ready rows in one go and emails invitations afterwards.
      .post('/import', async (c) => {
        const body = await parseBody(c, ImportBody)
        const { organisationId, memberId: actorId } = c.var.auth
        const at = now()
        const cohort = await findCohort(deps.sql, organisationId, body.cohortId)
        requireOpenCohort(cohort)

        const { reviewed, invitations } = await deps.sql.begin(async (tx) => {
          // Lock the cohort so two imports into it can't race.
          await tx`select id from public.cohorts where id = ${cohort.id} for update`
          const reviewed = await reviewRows(tx, organisationId, cohort, body.rows)
          const invitations: { email: string; firstName: string; token: string }[] = []
          for (const row of reviewed) {
            if (row.status !== 'ready') continue
            const result = await enrol(tx, {
              organisationId,
              actorId,
              cohort,
              fullName: row.fullName,
              email: row.email,
              phone: row.phone,
              existingMemberId: row.existingMemberId,
              source: 'import',
              now: at,
              requestId: c.var.requestId,
            })
            if (result.token) invitations.push({ email: row.email, firstName: result.firstName, token: result.token })
          }
          await audit(tx, {
            organisationId,
            actorMemberId: actorId,
            action: 'participants.imported',
            entityType: 'cohort',
            entityId: cohort.id,
            data: {
              fileName: body.fileName,
              added: reviewed.filter((r) => r.status === 'ready').length,
              skipped: reviewed.filter((r) => r.status !== 'ready').length,
            },
            requestId: c.var.requestId,
          })
          return { reviewed, invitations }
        })

        let emailed = 0
        if (body.sendEmails) {
          for (const invitation of invitations) {
            const sent = await sendInvitationEmail(deps.mailer, {
              to: invitation.email,
              firstName: invitation.firstName,
              organisationName: cohort.organisation_name,
              role: 'participant',
              link: invitationLink(deps.appUrl, invitation.token),
            })
            if (sent) emailed++
          }
        }
        return c.json({
          cohort: { id: cohort.id, name: cohort.name },
          added: reviewed.filter((r) => r.status === 'ready').length,
          invited: invitations.length,
          emailed,
          invitationExpiresAt: new Date(at.getTime() + INVITATION_TTL_HOURS * 3600 * 1000),
          skipped: reviewed.filter((r) => r.status !== 'ready'),
          importedAt: at,
        })
      })

      // B1.04 Participant detail.
      .get('/:id', async (c) => {
        const { organisationId } = c.var.auth
        const row = await findParticipant(deps.sql, organisationId, c.req.param('id'))
        const [enrolments, history] = await Promise.all([
          deps.sql<
            {
              id: string
              status: string
              status_reason: string | null
              status_note: string | null
              status_effective_on: string | null
              status_changed_at: Date
              enrolled_at: Date
              cohort_id: string
              cohort_name: string
              cohort_status: string
              programme_id: string
              programme_name: string
              trainers: string[]
              present: number
              recorded: number
            }[]
          >`
            select e.id, e.status, e.status_reason, e.status_note, e.status_effective_on::text, e.status_changed_at, e.enrolled_at,
                   c.id as cohort_id, c.name as cohort_name, public.status(c) as cohort_status,
                   p.id as programme_id, p.name as programme_name,
                   coalesce((
                     select array_agg(distinct m.first_name || ' ' || m.last_name)
                     from public.cohort_courses x
                     join public.cohort_course_trainers t on t.cohort_course_id = x.id
                     join public.organisation_members m on m.id = t.member_id
                     where x.cohort_id = c.id
                   ), '{}') as trainers,
                   (select count(*)::int from public.attendance_records a
                      join public.sessions s on s.id = a.session_id and s.cancelled_at is null
                      join public.cohort_courses x on x.id = s.cohort_course_id
                    where a.member_id = e.member_id and x.cohort_id = c.id and a.status = 'present') as present,
                   (select count(*)::int from public.attendance_records a
                      join public.sessions s on s.id = a.session_id and s.cancelled_at is null
                      join public.cohort_courses x on x.id = s.cohort_course_id
                    where a.member_id = e.member_id and x.cohort_id = c.id) as recorded
            from public.enrolments e
            join public.cohorts c on c.id = e.cohort_id
            join public.programmes p on p.id = c.programme_id
            where e.member_id = ${row.id}
            order by (e.status = 'active') desc, e.enrolled_at desc
          `,
          deps.sql<{ action: string; created_at: Date; data: Record<string, unknown>; actor_first_name: string | null; actor_last_name: string | null }[]>`
            select e.action, e.created_at, e.data, a.first_name as actor_first_name, a.last_name as actor_last_name
            from public.audit_events e
            left join public.organisation_members a on a.id = e.actor_member_id
            where e.organisation_id = ${organisationId} and e.entity_type = 'member' and e.entity_id = ${row.id}
            order by e.created_at desc, e.id desc
            limit 50
          `,
        ])
        return c.json({
          participant: {
            id: row.id,
            email: row.email,
            firstName: row.first_name,
            lastName: row.last_name,
            phone: row.phone,
            status: row.status,
            invitedAt: row.invited_at,
            joinedAt: row.joined_at,
            invitationExpiresAt: row.invitation_expires_at,
            invitationSentAt: row.invitation_sent_at,
            lastSignInAt: row.last_sign_in_at,
          },
          enrolments: enrolments.map((e) => ({
            id: e.id,
            status: e.status,
            reason: e.status_reason,
            note: e.status_note,
            effectiveOn: e.status_effective_on,
            changedAt: e.status_changed_at,
            enrolledAt: e.enrolled_at,
            cohort: { id: e.cohort_id, name: e.cohort_name, status: e.cohort_status },
            programme: { id: e.programme_id, name: e.programme_name },
            trainers: e.trainers,
            attendance: e.recorded ? { present: e.present, recorded: e.recorded, rate: Math.round((e.present / e.recorded) * 100) } : null,
          })),
          history: history.map((h) => ({ action: h.action, at: h.created_at, data: h.data, actor: shortName(h.actor_first_name, h.actor_last_name) })),
        })
      })

      // B1.06 Edit details. The email can change only before they set a password; a new link goes to the new address.
      .patch('/:id', async (c) => {
        const body = await parseBody(c, EditParticipant)
        const { organisationId, memberId: actorId } = c.var.auth
        const at = now()
        const row = await findParticipant(deps.sql, organisationId, c.req.param('id'))
        const emailChanged = body.email !== row.email
        if (emailChanged && row.status !== 'invited') {
          throw new AppError(409, 'email_locked', 'This participant has signed in, so their email can’t be changed here yet.', { field: 'email' })
        }
        const { firstName, lastName } = splitName(body.fullName)
        let token: string | null
        try {
          token = await deps.sql.begin(async (tx) => {
            await tx`
              update public.organisation_members
              set first_name = ${firstName}, last_name = ${lastName}, email = ${body.email}, phone = ${body.phone}, updated_at = now()
              where id = ${row.id}
            `
            let issued: string | null = null
            if (emailChanged) {
              ;({ token: issued } = await issueInvitation(tx, { organisationId, memberId: row.id, invitedBy: actorId, now: at }))
              await tx`update public.organisation_members set invited_at = ${at} where id = ${row.id}`
            }
            await audit(tx, {
              organisationId,
              actorMemberId: actorId,
              action: 'participant.updated',
              entityType: 'member',
              entityId: row.id,
              data: { emailChanged },
              requestId: c.var.requestId,
            })
            return issued
          })
        } catch (error) {
          if (isPg(error, PG.uniqueViolation, 'organisation_members_email_key')) {
            throw new AppError(409, 'email_in_use', 'This email is already used on Synqop by someone else.', { field: 'email' })
          }
          throw error
        }
        let emailSent: boolean | null = null
        if (token) {
          emailSent = await sendInvitationEmail(deps.mailer, {
            to: body.email,
            firstName,
            organisationName: row.organisation_name,
            role: 'participant',
            link: invitationLink(deps.appUrl, token),
          })
        }
        return c.json({ participant: { id: row.id }, emailSent })
      })

      // B1.05a Defer: leaves the cohort now, optionally joining an upcoming cohort in the same programme.
      .post('/:id/enrolments/:enrolmentId/defer', async (c) => {
        const body = await parseBody(c, Defer)
        const { organisationId, memberId: actorId } = c.var.auth
        const participant = await findParticipant(deps.sql, organisationId, c.req.param('id'))
        const joined = await deps.sql.begin(async (tx) => {
          const enrolment = await findEnrolment(tx, participant.id, c.req.param('enrolmentId'))
          const target = body.toCohortId
            ? await findTargetCohort(tx, organisationId, enrolment.programme_id, body.toCohortId, ['upcoming', 'draft'])
            : null
          if (target && target.id === enrolment.cohort_id) {
            throw new AppError(400, 'bad_request', 'Some fields need attention.', [{ field: 'toCohortId', message: 'Choose a different cohort.' }])
          }
          await tx`
            update public.enrolments
            set status = 'deferred', status_reason = ${body.reason}, status_note = ${body.note},
                status_effective_on = ${body.effectiveOn ?? null}, status_changed_at = now(), updated_at = now()
            where id = ${enrolment.id}
          `
          if (target) {
            await tx`
              insert into public.enrolments (organisation_id, cohort_id, member_id, transferred_from_id)
              values (${organisationId}, ${target.id}, ${participant.id}, ${enrolment.id})
              on conflict (cohort_id, member_id) do update set status = 'active', status_changed_at = now(), transferred_from_id = excluded.transferred_from_id
            `
          }
          await audit(tx, {
            organisationId,
            actorMemberId: actorId,
            action: 'enrolment.deferred',
            entityType: 'member',
            entityId: participant.id,
            data: { from: enrolment.cohort_name, to: target?.name ?? null, reason: body.reason },
            requestId: c.var.requestId,
          })
          return { from: enrolment.cohort_name, to: target?.name ?? null }
        })
        if (body.notify) {
          await sendChangeEmail(deps, {
            to: participant.email,
            firstName: participant.first_name,
            organisationName: participant.organisation_name,
            title: `Your place in ${joined.from} is deferred`,
            intro: joined.to
              ? `your place in ${joined.from} has been deferred. You'll continue in ${joined.to}.`
              : `your place in ${joined.from} has been deferred. Your programme team will be in touch about when you can rejoin.`,
          })
        }
        return c.json({ ok: true })
      })

      // B1.05b Withdraw.
      .post('/:id/enrolments/:enrolmentId/withdraw', async (c) => {
        const body = await parseBody(c, Withdraw)
        const { organisationId, memberId: actorId } = c.var.auth
        const participant = await findParticipant(deps.sql, organisationId, c.req.param('id'))
        const cohortName = await deps.sql.begin(async (tx) => {
          const enrolment = await findEnrolment(tx, participant.id, c.req.param('enrolmentId'))
          await tx`
            update public.enrolments
            set status = 'withdrawn', status_reason = ${body.reason}, status_note = ${body.note},
                status_effective_on = ${body.effectiveOn ?? null}, status_changed_at = now(), updated_at = now()
            where id = ${enrolment.id}
          `
          await audit(tx, {
            organisationId,
            actorMemberId: actorId,
            action: 'enrolment.withdrawn',
            entityType: 'member',
            entityId: participant.id,
            data: { cohort: enrolment.cohort_name, reason: body.reason },
            requestId: c.var.requestId,
          })
          return enrolment.cohort_name
        })
        if (body.notify) {
          await sendChangeEmail(deps, {
            to: participant.email,
            firstName: participant.first_name,
            organisationName: participant.organisation_name,
            title: `You've been withdrawn from ${cohortName}`,
            intro: `you've been withdrawn from ${cohortName}. You no longer have access to its sessions and assignments.`,
          })
        }
        return c.json({ ok: true })
      })

      // B1.05c Transfer to an active or upcoming cohort in the same programme.
      .post('/:id/enrolments/:enrolmentId/transfer', async (c) => {
        const body = await parseBody(c, Transfer)
        const { organisationId, memberId: actorId } = c.var.auth
        const participant = await findParticipant(deps.sql, organisationId, c.req.param('id'))
        const moved = await deps.sql.begin(async (tx) => {
          const enrolment = await findEnrolment(tx, participant.id, c.req.param('enrolmentId'))
          const target = await findTargetCohort(tx, organisationId, enrolment.programme_id, body.toCohortId, ['active', 'upcoming', 'draft'])
          if (target.id === enrolment.cohort_id) {
            throw new AppError(400, 'bad_request', 'Some fields need attention.', [{ field: 'toCohortId', message: 'Choose a different cohort.' }])
          }
          await tx`
            update public.enrolments
            set status = 'transferred', status_reason = ${body.reason}, status_changed_at = now(), updated_at = now()
            where id = ${enrolment.id}
          `
          await tx`
            insert into public.enrolments (organisation_id, cohort_id, member_id, transferred_from_id)
            values (${organisationId}, ${target.id}, ${participant.id}, ${enrolment.id})
            on conflict (cohort_id, member_id) do update set status = 'active', status_changed_at = now(), transferred_from_id = excluded.transferred_from_id
          `
          await audit(tx, {
            organisationId,
            actorMemberId: actorId,
            action: 'enrolment.transferred',
            entityType: 'member',
            entityId: participant.id,
            data: { from: enrolment.cohort_name, to: target.name, reason: body.reason },
            requestId: c.var.requestId,
          })
          return { from: enrolment.cohort_name, to: target.name }
        })
        if (body.notify) {
          await sendChangeEmail(deps, {
            to: participant.email,
            firstName: participant.first_name,
            organisationName: participant.organisation_name,
            title: `You've moved to ${moved.to}`,
            intro: `you've moved from ${moved.from} to ${moved.to}. Your new sessions and courses are in Synqop.`,
          })
        }
        return c.json({ ok: true })
      })
  )
}

export interface ReviewedRow {
  row: number
  fullName: string
  email: string
  phone: string | null
  status: 'ready' | 'error'
  message: string | null
  existingMemberId: string | null
}

/** Checks import rows (B1.03b): required fields, valid and unique emails, and enrolment rules. */
async function reviewRows(sql: Sql | Tx, organisationId: string, cohort: CohortRow, rows: z.infer<typeof ImportRow>[]): Promise<ReviewedRow[]> {
  const multi = await allowsMultipleCohorts(sql, organisationId)
  const seen = new Map<string, number>()
  const out: ReviewedRow[] = []
  for (const [index, raw] of rows.entries()) {
    const fullName = (raw.full_name ?? '').trim().replace(/\s+/g, ' ')
    const email = (raw.email ?? '').trim().toLowerCase()
    const phoneValue = (raw.phone ?? '').trim() || null
    const base = { row: index + 1, fullName, email, phone: phoneValue, existingMemberId: null as string | null }
    const fail = (message: string) => out.push({ ...base, status: 'error', message })
    if (!fullName && !email) {
      fail('Empty row')
      continue
    }
    if (!fullName) {
      fail('Name missing')
      continue
    }
    if (!fullName.includes(' ')) {
      fail('Last name missing')
      continue
    }
    if (!email) {
      fail('Email missing')
      continue
    }
    if (!EMAIL_RE.test(email) || email.length > 254) {
      fail('Email not valid')
      continue
    }
    if (seen.has(email)) {
      fail(`Same email as row ${seen.get(email)}`)
      continue
    }
    seen.set(email, index + 1)
    const check = await checkPerson(sql, { organisationId, cohort, email, multi })
    if (!check.ok) {
      fail(check.code === 'already_enrolled' ? `Already in ${cohort.name}` : check.code === 'one_cohort_only' ? `Already in ${check.cohortName}` : check.message)
      continue
    }
    out.push({ ...base, status: 'ready', message: null, existingMemberId: check.existingMemberId })
  }
  return out
}
