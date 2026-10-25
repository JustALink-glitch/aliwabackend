import { Hono } from 'hono'
import { notify as inApp } from '../lib/notifications.js'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { audit, type Sql, type Tx } from '../lib/db.js'
import { AppError, forbidden, notFound } from '../lib/errors.js'
import { renderEmail } from '../lib/mailer.js'
import { can, staffScope, teachingIds, type StaffScope } from '../lib/staff.js'
import { MAX_SESSIONS_PER_SCHEDULE, occurrences, toRrule, weekdaysFromRrule, type Weekday } from '../lib/schedule.js'
import { isoDate, optionalText, parseBody, uuid } from '../lib/validation.js'
import { requireAuth, requireRole, type AuthVariables } from '../middleware/auth.js'
import { attendanceRoutes } from './attendance.js'
import { sessionResourceRoutes, sessionResources, toResource } from './session-resources.js'

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Enter a time like 10:00.')

const joinUrl = z
  .string()
  .trim()
  .max(500)
  .nullish()
  .transform((value) => (value ? value : null))
  .refine((value) => value === null || /^https:\/\/\S+$/.test(value), 'Paste the full meeting link, starting with https://')

const Where = {
  mode: z.enum(['online', 'in_person']),
  location: optionalText(200),
  joinUrl,
}

const Schedule = z
  .object({
    cohortId: uuid,
    courseId: uuid,
    trainerMemberId: uuid.nullish().transform((value) => value ?? null),
    date: isoDate,
    start: time,
    end: time,
    repeat: z
      .object({
        weekdays: z.array(z.number().int().min(1).max(7)).min(1, 'Choose at least one day.'),
        count: z.number().int().min(1).max(MAX_SESSIONS_PER_SCHEDULE).optional(),
        until: isoDate.optional(),
      })
      .refine((r) => Boolean(r.count) !== Boolean(r.until), 'Choose how the repeat ends.')
      .nullish()
      .transform((value) => value ?? null),
    ...Where,
  })
  .refine((v) => v.end > v.start, { path: ['end'], message: 'End must be after the start.' })
  .refine((v) => v.mode === 'online' || Boolean(v.location), { path: ['location'], message: 'Enter where it happens.' })

const Edit = z
  .object({
    scope: z.enum(['this', 'following', 'all']).default('this'),
    date: isoDate,
    start: time,
    end: time,
    trainerMemberId: uuid.nullish().transform((value) => value ?? null),
    notify: z.boolean().default(false),
    ...Where,
  })
  .refine((v) => v.end > v.start, { path: ['end'], message: 'End must be after the start.' })
  .refine((v) => v.mode === 'online' || Boolean(v.location), { path: ['location'], message: 'Enter where it happens.' })

const Cancel = z.object({
  reason: z.string().trim().min(1, 'Add a reason. Participants see it in the email.').max(300),
  notify: z.boolean().default(true),
})

const fieldError = (field: string, message: string) => new AppError(400, 'bad_request', 'Some fields need attention.', [{ field, message }])

interface SessionRow {
  id: string
  cohort_course_id: string
  series_id: string | null
  rrule: string | null
  series_count: number | null
  starts_at: Date
  ends_at: Date
  status: string
  mode: string
  location: string | null
  zoom_join_url: string | null
  zoom_meeting_id: string | null
  cancelled_at: Date | null
  cancellation_reason: string | null
  cancelled_by_first_name: string | null
  cancelled_by_last_name: string | null
  trainer_member_id: string | null
  trainer_first_name: string | null
  trainer_last_name: string | null
  trainer_is_lead: boolean | null
  course_id: string
  course_name: string
  cohort_id: string
  cohort_name: string
  cohort_status: string
  programme_id: string
  number: number | null
  total: number
  expected: number
  attendance_count: number
  present_count: number
  report_submitted_at: Date | null
  report_due_at: Date
}

/** Sessions with everything the lists and detail need. Numbers ignore cancelled sessions. */
function selectSessions(sql: Sql | Tx, organisationId: string, filter: { id?: string; from?: Date; to?: Date; cohortId?: string; seriesId?: string; cohortCourseIds?: string[] | null }) {
  return sql<SessionRow[]>`
    with numbered as (
      select s.id,
             case when s.cancelled_at is null
                  then row_number() over (partition by s.cohort_course_id, (s.cancelled_at is null) order by s.starts_at) end as number
      from public.sessions s
      where s.organisation_id = ${organisationId}
    )
    select s.id, s.cohort_course_id, s.series_id, ss.rrule,
           (select count(*)::int from public.sessions x where x.series_id = s.series_id) as series_count,
           s.starts_at, s.ends_at, public.status(s) as status, s.mode, s.location, s.zoom_join_url, s.zoom_meeting_id,
           s.cancelled_at, s.cancellation_reason, cb.first_name as cancelled_by_first_name, cb.last_name as cancelled_by_last_name,
           s.trainer_member_id, t.first_name as trainer_first_name, t.last_name as trainer_last_name,
           (select ct.is_lead from public.cohort_course_trainers ct where ct.cohort_course_id = s.cohort_course_id and ct.member_id = s.trainer_member_id) as trainer_is_lead,
           co.id as course_id, co.name as course_name, h.id as cohort_id, h.name as cohort_name, public.status(h) as cohort_status,
           h.programme_id,
           n.number::int as number,
           greatest(coalesce(x.planned_session_count, 0),
                    (select count(*)::int from public.sessions y where y.cohort_course_id = s.cohort_course_id and y.cancelled_at is null)) as total,
           (select count(*)::int from public.enrolments e where e.cohort_id = h.id and e.status = 'active') as expected,
           (select count(*)::int from public.attendance_records a where a.session_id = s.id) as attendance_count,
           (select count(*)::int from public.attendance_records a where a.session_id = s.id and a.status = 'present') as present_count,
           r.submitted_at as report_submitted_at,
           s.ends_at + make_interval(hours => st.report_due_hours) as report_due_at
    from public.sessions s
    join numbered n on n.id = s.id
    join public.cohort_courses x on x.id = s.cohort_course_id
    join public.courses co on co.id = x.course_id
    join public.cohorts h on h.id = x.cohort_id
    join public.organisation_settings st on st.organisation_id = s.organisation_id
    left join public.session_series ss on ss.id = s.series_id
    left join public.organisation_members t on t.id = s.trainer_member_id
    left join public.organisation_members cb on cb.id = s.cancelled_by
    left join public.session_reports r on r.session_id = s.id
    where s.organisation_id = ${organisationId}
      ${filter.id ? sql`and s.id = ${filter.id}` : sql``}
      ${filter.from ? sql`and s.ends_at > ${filter.from}` : sql``}
      ${filter.to ? sql`and s.starts_at < ${filter.to}` : sql``}
      ${filter.cohortId ? sql`and h.id = ${filter.cohortId}` : sql``}
      ${filter.seriesId ? sql`and s.series_id = ${filter.seriesId}` : sql``}
      ${filter.cohortCourseIds ? sql`and s.cohort_course_id = any(${filter.cohortCourseIds}::uuid[])` : sql``}
    order by s.starts_at, co.name
  `
}

const toSession = (row: SessionRow) => ({
  id: row.id,
  title: row.course_name,
  course: { id: row.course_id, name: row.course_name },
  cohort: { id: row.cohort_id, name: row.cohort_name, status: row.cohort_status },
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  status: row.status,
  mode: row.mode,
  location: row.location,
  joinUrl: row.zoom_join_url,
  zoomMeetingId: row.zoom_meeting_id,
  trainer: row.trainer_member_id
    ? { id: row.trainer_member_id, name: `${row.trainer_first_name} ${row.trainer_last_name}`, isLead: Boolean(row.trainer_is_lead) }
    : null,
  series: row.series_id ? { id: row.series_id, weekdays: weekdaysFromRrule(row.rrule ?? ''), sessions: row.series_count ?? 0 } : null,
  number: row.number,
  total: row.total,
  expected: row.expected,
  attendance: { recorded: row.attendance_count, present: row.present_count },
  report: { submittedAt: row.report_submitted_at, dueAt: row.report_due_at },
  cancelled: row.cancelled_at
    ? {
        at: row.cancelled_at,
        reason: row.cancellation_reason,
        by: row.cancelled_by_first_name ? `${row.cancelled_by_first_name} ${row.cancelled_by_last_name}` : null,
      }
    : null,
})

/** /v1/sessions — C1 for admins; T3 for trainers, limited to the cohort courses they teach. */
export function sessionRoutes(deps: AppDeps) {
  async function timeZoneOf(sql: Sql | Tx, organisationId: string) {
    const [row] = await sql<{ time_zone: string; name: string }[]>`select time_zone, name from public.organisations where id = ${organisationId}`
    return row!
  }

  async function findSession(sql: Sql | Tx, organisationId: string, id: string, scope?: StaffScope) {
    if (!uuid.safeParse(id).success) throw notFound('Session not found.')
    const [row] = await selectSessions(sql, organisationId, { id, cohortCourseIds: scope ? teachingIds(scope) : null })
    if (!row) throw notFound('Session not found.')
    return row
  }

  /** The session, if this person may change its schedule (C1.04–C1.06, T3.06–T3.07). */
  async function findForScheduling(c: { var: { auth: AuthVariables['auth'] } }, id: string) {
    const scope = await staffScope(deps.sql, c.var.auth)
    const row = await findSession(deps.sql, c.var.auth.organisationId, id, scope)
    if (!can(scope, row.cohort_course_id).schedule) throw forbidden('Only admins and the course’s lead trainer can change this session.')
    return row
  }

  /** The trainer must teach this course in this cohort. */
  async function checkTrainer(tx: Sql | Tx, cohortCourseId: string, trainerId: string | null) {
    if (!trainerId) return
    const [row] = await tx`
      select 1 from public.cohort_course_trainers t
      join public.organisation_members m on m.id = t.member_id and m.status <> 'deactivated'
      where t.cohort_course_id = ${cohortCourseId} and t.member_id = ${trainerId}
    `
    if (!row) throw fieldError('trainerMemberId', 'Choose one of this course’s trainers in the cohort.')
  }

  async function notify(
    input: { organisationId: string; organisationName: string; cohortId: string; trainerId: string | null; subject: string; intro: (firstName: string) => string; sessionId: string },
  ) {
    // In the participants' bell too (G1.01), unless they switched it off.
    const enrolled = await deps.sql<{ id: string }[]>`
      select e.member_id as id from public.enrolments e where e.cohort_id = ${input.cohortId} and e.status = 'active'
    `
    await inApp(deps.sql, {
      organisationId: input.organisationId,
      to: { memberIds: enrolled.map((r) => r.id) },
      event: 'session_changed',
      title: input.subject,
      link: `/participant/sessions/${input.sessionId}`,
    })
    const people = await deps.sql<{ email: string; first_name: string }[]>`
      select m.email, m.first_name from public.organisation_members m
      join public.enrolments e on e.member_id = m.id and e.cohort_id = ${input.cohortId} and e.status = 'active'
      where m.status <> 'deactivated'
      union
      select m.email, m.first_name from public.organisation_members m
      where m.id = ${input.trainerId} and m.status <> 'deactivated'
    `
    let sent = 0
    for (const person of people) {
      const { text, html } = renderEmail({
        title: input.subject,
        intro: `Hi ${person.first_name}, ${input.intro(person.first_name)}`,
        buttonLabel: 'Open Synqop',
        buttonUrl: `${deps.appUrl.replace(/\/$/, '')}/sign-in`,
        note: `Sent by ${input.organisationName} through Synqop.`,
      })
      try {
        await deps.mailer.send({ to: person.email, subject: input.subject, text, html })
        sent++
      } catch (error) {
        console.error('Session email failed', error)
      }
    }
    return sent
  }

  const describeWhen = (row: Pick<SessionRow, 'starts_at' | 'ends_at'>, tz: string) => {
    const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz }).format(row.starts_at)
    const t = (d: Date) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(d)
    return `${day.replace(',', '')}, ${t(row.starts_at)}–${t(row.ends_at)}`
  }

  return (
    new Hono<{ Variables: AuthVariables }>()
      .use(requireAuth(deps), requireRole('owner', 'admin', 'trainer', 'assistant_trainer'))

      // C1.02 / T3.03: cohorts and courses this person can schedule in, with each course's trainers.
      .get('/options', async (c) => {
        const auth = c.var.auth
        const scope = await staffScope(deps.sql, auth)
        const ids = teachingIds(scope)
        const rows = await deps.sql<
          { cohort_id: string; cohort_name: string; status: string; starts_on: string; ends_on: string; cc_id: string; course_id: string; course_name: string; trainers: { id: string; firstName: string; lastName: string; isLead: boolean; status: string }[] }[]
        >`
          select h.id as cohort_id, h.name as cohort_name, public.status(h) as status, h.starts_on::text, h.ends_on::text,
                 x.id as cc_id, co.id as course_id, co.name as course_name,
                 coalesce((select json_agg(json_build_object('id', m.id, 'firstName', m.first_name, 'lastName', m.last_name, 'isLead', t.is_lead, 'status', m.status) order by t.is_lead desc, m.first_name)
                           from public.cohort_course_trainers t join public.organisation_members m on m.id = t.member_id where t.cohort_course_id = x.id), '[]') as trainers
          from public.cohorts h
          join public.cohort_courses x on x.cohort_id = h.id
          join public.courses co on co.id = x.course_id
          where h.organisation_id = ${auth.organisationId} and h.archived_at is null
            ${ids ? deps.sql`and x.id = any(${ids}::uuid[])` : deps.sql``}
          order by h.starts_on desc, h.name, co.name
        `
        const cohorts = new Map<string, { id: string; name: string; status: string; startsOn: string; endsOn: string; courses: unknown[] }>()
        for (const r of rows) {
          if (!scope.admin && !can(scope, r.cc_id).schedule) continue
          if (!cohorts.has(r.cohort_id)) cohorts.set(r.cohort_id, { id: r.cohort_id, name: r.cohort_name, status: r.status, startsOn: r.starts_on, endsOn: r.ends_on, courses: [] })
          cohorts.get(r.cohort_id)!.courses.push({ id: r.cc_id, courseId: r.course_id, name: r.course_name, trainers: r.trainers })
        }
        return c.json({ cohorts: [...cohorts.values()] })
      })

      // C1.01 week view (?from=&to= are organisation-local dates, inclusive) and A3.04 (?cohortId=).
      .get('/', async (c) => {
        const { organisationId } = c.var.auth
        const ids = teachingIds(await staffScope(deps.sql, c.var.auth))
        const { time_zone: tz } = await timeZoneOf(deps.sql, organisationId)
        const from = isoDate.safeParse(c.req.query('from'))
        const to = isoDate.safeParse(c.req.query('to'))
        const cohortId = uuid.safeParse(c.req.query('cohortId'))
        // Local midnight → instant, using the organisation's time zone.
        const [range] = await deps.sql<{ from: Date | null; to: Date | null }[]>`
          select ${from.success ? deps.sql`(${from.data}::date)::timestamp at time zone ${tz}` : deps.sql`null::timestamptz`} as from,
                 ${to.success ? deps.sql`(${to.data}::date + 1)::timestamp at time zone ${tz}` : deps.sql`null::timestamptz`} as to
        `
        const rows = await selectSessions(deps.sql, organisationId, {
          ...(range!.from && { from: range!.from }),
          ...(range!.to && { to: range!.to }),
          ...(cohortId.success && { cohortId: cohortId.data }),
          cohortCourseIds: ids,
        })
        // "Attendance to confirm": held in the last 30 days, not cancelled, nothing recorded.
        const toConfirm = await deps.sql<SessionRow[]>`
          select id from public.sessions s
          where s.organisation_id = ${organisationId} and s.cancelled_at is null and s.ends_at < now()
            and s.ends_at > now() - interval '30 days'
            and not exists (select 1 from public.attendance_records a where a.session_id = s.id)
            ${ids ? deps.sql`and s.cohort_course_id = any(${ids}::uuid[])` : deps.sql``}
            ${cohortId.success ? deps.sql`and s.cohort_course_id in (select id from public.cohort_courses where cohort_id = ${cohortId.data})` : deps.sql``}
          order by s.starts_at desc limit 10
        `
        const confirmRows = toConfirm.length
          ? (await Promise.all(toConfirm.map((r) => selectSessions(deps.sql, organisationId, { id: r.id, cohortCourseIds: ids })))).flat()
          : []
        const [any] = await deps.sql<{ exists: boolean }[]>`
          select exists (
            select 1 from public.sessions s
            ${cohortId.success ? deps.sql`join public.cohort_courses x on x.id = s.cohort_course_id and x.cohort_id = ${cohortId.data}` : deps.sql``}
            where s.organisation_id = ${organisationId}
              ${ids ? deps.sql`and s.cohort_course_id = any(${ids}::uuid[])` : deps.sql``}
          ) as exists
        `
        return c.json({ timeZone: tz, hasAny: any!.exists, sessions: rows.map(toSession), attendanceToConfirm: confirmRows.map(toSession) })
      })

      .get('/:id', async (c) => {
        const scope = await staffScope(deps.sql, c.var.auth)
        const row = await findSession(deps.sql, c.var.auth.organisationId, c.req.param('id'), scope)
        const allowed = can(scope, row.cohort_course_id)
        const permissions = { schedule: allowed.schedule, attendance: allowed.attendance, resources: allowed.resources, report: allowed.report }
        const resources = await sessionResources(deps.sql, row.id, row.cohort_course_id)
        return c.json({ session: toSession(row), can: permissions, resources: resources.map((r) => toResource(r, c.var.auth.memberId)) })
      })

      // C1.02 Schedule session(s).
      .post('/', async (c) => {
        const body = await parseBody(c, Schedule)
        const { organisationId, memberId: actorId } = c.var.auth
        const result = await deps.sql.begin(async (tx) => {
          const [cohortCourse] = await tx<{ id: string; course_name: string; cohort_name: string; starts_on: string; ends_on: string; status: string }[]>`
            select x.id, co.name as course_name, h.name as cohort_name, h.starts_on::text, h.ends_on::text, public.status(h) as status
            from public.cohort_courses x
            join public.courses co on co.id = x.course_id
            join public.cohorts h on h.id = x.cohort_id
            where x.organisation_id = ${organisationId} and x.cohort_id = ${body.cohortId} and x.course_id = ${body.courseId}
          `
          if (!cohortCourse) throw fieldError('courseId', 'Choose a course this cohort runs.')
          if (!can(await staffScope(tx, c.var.auth), cohortCourse.id).schedule) throw fieldError('courseId', 'Choose a course you lead in this cohort.')
          if (cohortCourse.status === 'archived' || cohortCourse.status === 'completed') {
            throw fieldError('cohortId', 'Choose an active or upcoming cohort.')
          }
          await checkTrainer(tx, cohortCourse.id, body.trainerMemberId)

          const dates = occurrences(body.date, body.repeat ? { weekdays: body.repeat.weekdays as Weekday[], count: body.repeat.count, until: body.repeat.until } : null)
          if (dates.length === 0) throw fieldError('repeat', 'No sessions fall on the chosen days. Check the date and days.')
          const outside = dates.filter((d) => d < cohortCourse.starts_on || d > cohortCourse.ends_on)
          if (outside.length > 0) {
            throw fieldError(
              outside[0]! < cohortCourse.starts_on ? 'date' : 'repeat',
              `${outside.length === dates.length ? 'These sessions fall' : `${outside.length} of ${dates.length} sessions fall`} outside ${cohortCourse.cohort_name} (${cohortCourse.starts_on} to ${cohortCourse.ends_on}).`,
            )
          }

          const { time_zone: tz } = await timeZoneOf(tx, organisationId)
          let seriesId: string | null = null
          if (body.repeat) {
            const [series] = await tx<{ id: string }[]>`
              insert into public.session_series (organisation_id, cohort_course_id, rrule, created_by)
              values (${organisationId}, ${cohortCourse.id},
                      ${toRrule({ weekdays: body.repeat.weekdays as Weekday[], count: body.repeat.count, until: body.repeat.until })}, ${actorId})
              returning id
            `
            seriesId = series!.id
          }
          const ids: string[] = []
          for (const date of dates) {
            const [row] = await tx<{ id: string }[]>`
              insert into public.sessions
                (organisation_id, cohort_course_id, series_id, title, starts_at, ends_at, mode, location, zoom_join_url, trainer_member_id, created_by)
              values
                (${organisationId}, ${cohortCourse.id}, ${seriesId}, ${cohortCourse.course_name},
                 (${date}::date + ${body.start}::time) at time zone ${tz},
                 (${date}::date + ${body.end}::time) at time zone ${tz},
                 ${body.mode}, ${body.location}, ${body.mode === 'online' ? body.joinUrl : null}, ${body.trainerMemberId}, ${actorId})
              returning id
            `
            ids.push(row!.id)
          }
          await audit(tx, {
            organisationId,
            actorMemberId: actorId,
            action: 'sessions.scheduled',
            entityType: 'cohort',
            entityId: body.cohortId,
            data: { courseId: body.courseId, count: ids.length, seriesId },
            requestId: c.var.requestId,
          })
          return { ids }
        })
        return c.json({ created: result.ids.length, firstSessionId: result.ids[0] }, 201)
      })

      // C1.06 Edit (with C1.04 scope for repeating sessions). Held sessions never change.
      .patch('/:id', async (c) => {
        const body = await parseBody(c, Edit)
        const { organisationId, memberId: actorId } = c.var.auth
        const session = await findForScheduling(c, c.req.param('id'))
        if (session.cancelled_at) throw new AppError(409, 'session_cancelled', 'This session was cancelled, so it can’t be edited.')
        if (session.status !== 'scheduled') throw new AppError(409, 'session_started', 'This session has started or been held, so it can’t be changed.')
        const { time_zone: tz, name: organisationName } = await timeZoneOf(deps.sql, organisationId)

        const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(session.starts_at)
        if (body.scope !== 'this' && body.date !== localDate) {
          throw fieldError('date', 'Change the date one session at a time. Choose “Only this session”.')
        }
        if (body.scope !== 'this' && !session.series_id) throw fieldError('scope', 'This session doesn’t repeat.')

        const updated = await deps.sql.begin(async (tx) => {
          await checkTrainer(tx, session.cohort_course_id, body.trainerMemberId)
          const [cohort] = await tx<{ starts_on: string; ends_on: string; name: string }[]>`
            select starts_on::text, ends_on::text, name from public.cohorts where id = ${session.cohort_id}
          `
          if (body.date < cohort!.starts_on || body.date > cohort!.ends_on) {
            throw fieldError('date', `Choose a date within ${cohort!.name} (${cohort!.starts_on} to ${cohort!.ends_on}).`)
          }
          const targets =
            body.scope === 'this'
              ? [session.id]
              : (
                  await tx<{ id: string }[]>`
                    select id from public.sessions s
                    where s.series_id = ${session.series_id} and s.cancelled_at is null and public.status(s) = 'scheduled'
                      ${body.scope === 'following' ? tx`and s.starts_at >= ${session.starts_at}` : tx``}
                  `
                ).map((r) => r.id)
          for (const id of targets) {
            // Keep each session's own date; apply the new times, place, link and trainer.
            await tx`
              update public.sessions s
              set starts_at = (${id === session.id ? body.date : tx`(s.starts_at at time zone ${tz})::date`}::date + ${body.start}::time) at time zone ${tz},
                  ends_at = (${id === session.id ? body.date : tx`(s.starts_at at time zone ${tz})::date`}::date + ${body.end}::time) at time zone ${tz},
                  mode = ${body.mode}, location = ${body.location}, zoom_join_url = ${body.mode === 'online' ? body.joinUrl : null},
                  trainer_member_id = ${body.trainerMemberId}, updated_at = now()
              where s.id = ${id}
            `
          }
          await audit(tx, {
            organisationId,
            actorMemberId: actorId,
            action: 'session.updated',
            entityType: 'session',
            entityId: session.id,
            data: { scope: body.scope, count: targets.length },
            requestId: c.var.requestId,
          })
          return targets.length
        })

        let emailed = 0
        if (body.notify) {
          const fresh = await findSession(deps.sql, organisationId, session.id)
          emailed = await notify({
            organisationId,
            organisationName,
            cohortId: session.cohort_id,
            trainerId: body.trainerMemberId ?? session.trainer_member_id,
            sessionId: session.id,
            subject: `${session.course_name}: session changed`,
            intro: () =>
              updated > 1
                ? `${updated} upcoming ${session.course_name} sessions in ${session.cohort_name} have changed, starting ${describeWhen(fresh, tz)}. Check Synqop for the new details.`
                : `the ${session.course_name} session in ${session.cohort_name} has changed. It's now ${describeWhen(fresh, tz)}${fresh.mode === 'online' ? ', online' : fresh.location ? ` at ${fresh.location}` : ''}.`,
          })
        }
        return c.json({ updated, emailed })
      })

      // C1.05 Cancel session.
      .post('/:id/cancel', async (c) => {
        const body = await parseBody(c, Cancel)
        const { organisationId, memberId: actorId } = c.var.auth
        const session = await findForScheduling(c, c.req.param('id'))
        if (session.cancelled_at) return c.json({ cancelled: true, emailed: 0 })
        if (session.status !== 'scheduled') throw new AppError(409, 'session_started', 'This session has started or been held, so it can’t be cancelled.')
        await deps.sql.begin(async (tx) => {
          await tx`
            update public.sessions set cancelled_at = now(), cancellation_reason = ${body.reason}, cancelled_by = ${actorId}, updated_at = now()
            where id = ${session.id}
          `
          await audit(tx, {
            organisationId,
            actorMemberId: actorId,
            action: 'session.cancelled',
            entityType: 'session',
            entityId: session.id,
            data: { reason: body.reason },
            requestId: c.var.requestId,
          })
        })
        let emailed = 0
        if (body.notify) {
          const { time_zone: tz, name: organisationName } = await timeZoneOf(deps.sql, organisationId)
          emailed = await notify({
            organisationId,
            organisationName,
            cohortId: session.cohort_id,
            trainerId: session.trainer_member_id,
            sessionId: session.id,
            subject: `Cancelled: ${session.course_name}, ${describeWhen(session, tz)}`,
            intro: () => `the ${session.course_name} session on ${describeWhen(session, tz)} is cancelled. Reason: ${body.reason}`,
          })
        }
        return c.json({ cancelled: true, emailed })
      })

      // C2: /:id/attendance…
      .route('/', attendanceRoutes(deps))
      .route('/', sessionResourceRoutes(deps))
  )
}
