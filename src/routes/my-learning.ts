import { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import type { AuthContext } from '../lib/auth.js'
import type { Sql } from '../lib/db.js'
import { notFound } from '../lib/errors.js'
import { uuid } from '../lib/validation.js'
import type { AuthVariables } from '../middleware/auth.js'

type SessionStatus = 'scheduled' | 'in_progress' | 'held' | 'cancelled'
type Mark = 'present' | 'absent' | 'excused'

interface MySessionRow {
  id: string
  starts_at: Date
  ends_at: Date
  status: SessionStatus
  mode: 'online' | 'in_person'
  location: string | null
  zoom_join_url: string | null
  cancellation_reason: string | null
  cohort_course_id: string
  course_id: string
  course_name: string
  cohort_id: string
  cohort_name: string
  enrolment_status: string
  trainer_first: string | null
  trainer_last: string | null
  number: number | null
  total: number
  mark: Mark | null
  source: 'zoom' | 'manual' | 'edited' | null
  joined_at: Date | null
  minutes_in_meeting: number | null
  note: string | null
}

/** Every session in my cohorts (active or completed enrolments), with my own attendance. */
function selectMySessions(sql: Sql, auth: AuthContext, filter: { id?: string; cohortCourseId?: string } = {}) {
  return sql<MySessionRow[]>`
    with numbered as (
      select s.id,
             case when s.cancelled_at is null
                  then row_number() over (partition by s.cohort_course_id, (s.cancelled_at is null) order by s.starts_at) end as number
      from public.sessions s where s.organisation_id = ${auth.organisationId}
    )
    select s.id, s.starts_at, s.ends_at, public.status(s) as status, s.mode, s.location, s.zoom_join_url, s.cancellation_reason,
           x.id as cohort_course_id, co.id as course_id, co.name as course_name, h.id as cohort_id, h.name as cohort_name,
           e.status as enrolment_status,
           coalesce(t.first_name, lt.first_name) as trainer_first, coalesce(t.last_name, lt.last_name) as trainer_last,
           n.number::int as number,
           greatest(coalesce(x.planned_session_count, 0),
                    (select count(*)::int from public.sessions y where y.cohort_course_id = x.id and y.cancelled_at is null)) as total,
           a.status as mark, a.source, a.joined_at, a.minutes_in_meeting, a.note
    from public.enrolments e
    join public.cohort_courses x on x.cohort_id = e.cohort_id
    join public.sessions s on s.cohort_course_id = x.id
    join numbered n on n.id = s.id
    join public.courses co on co.id = x.course_id
    join public.cohorts h on h.id = x.cohort_id
    left join public.organisation_members t on t.id = s.trainer_member_id
    left join public.cohort_course_trainers ct on ct.cohort_course_id = x.id and ct.is_lead
    left join public.organisation_members lt on lt.id = ct.member_id
    left join public.attendance_records a on a.session_id = s.id and a.member_id = e.member_id
    where e.member_id = ${auth.memberId} and e.organisation_id = ${auth.organisationId}
      and e.status in ('active', 'completed')
      ${filter.id ? sql`and s.id = ${filter.id}` : sql``}
      ${filter.cohortCourseId ? sql`and x.id = ${filter.cohortCourseId}` : sql``}
    order by s.starts_at
  `
}

const DAY = 24 * 3600 * 1000
const name = (first: string | null, last: string | null) => (first ? `${first} ${last ?? ''}`.trim() : null)

function toSession(r: MySessionRow, now: number) {
  // The join link shows from the day before until the session ends.
  const joinable = r.status !== 'cancelled' && r.mode === 'online' && r.ends_at.getTime() > now && r.starts_at.getTime() - now < DAY
  return {
    id: r.id,
    course: { id: r.course_id, name: r.course_name, cohortCourseId: r.cohort_course_id },
    cohort: { id: r.cohort_id, name: r.cohort_name },
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    status: r.status,
    mode: r.mode,
    location: r.location,
    joinUrl: joinable ? r.zoom_join_url : null,
    cancellationReason: r.cancellation_reason,
    trainer: name(r.trainer_first, r.trainer_last),
    number: r.number,
    total: r.total,
    attendance: r.mark
      ? { status: r.mark, source: r.source, joinedAt: r.joined_at, minutesInMeeting: r.minutes_in_meeting, note: r.note }
      : null,
  }
}

/** Present ÷ recorded over held sessions; excused counts as not present (§05). */
function attendanceOf(rows: MySessionRow[]) {
  const recorded = rows.filter((r) => r.status === 'held' && r.mark)
  const present = recorded.filter((r) => r.mark === 'present').length
  return {
    present,
    excused: recorded.filter((r) => r.mark === 'excused').length,
    recorded: recorded.length,
    rate: recorded.length ? Math.round((present / recorded.length) * 100) : null,
  }
}

/**
 * Participant learning (P2.01 dashboard, P3 courses, P4 sessions). Mounted inside myRoutes,
 * which already requires a signed-in participant.
 */
export function myLearningRoutes(deps: AppDeps) {
  const now = () => (deps.now ? deps.now() : new Date()).getTime()

  async function timeZoneOf(organisationId: string) {
    const [row] = await deps.sql<{ time_zone: string }[]>`select time_zone from public.organisations where id = ${organisationId}`
    return row!.time_zone
  }

  async function resourcesOf(cohortCourseId: string, sessionId?: string) {
    return deps.sql<{ id: string; kind: 'file' | 'link'; name: string; url: string | null; size_bytes: string | null; session_id: string | null }[]>`
      select id, kind, name, url, size_bytes, session_id from public.resources
      where cohort_course_id = ${cohortCourseId} ${sessionId ? deps.sql`and session_id = ${sessionId}` : deps.sql``}
      order by created_at desc
    `
  }
  const toResource = (r: Awaited<ReturnType<typeof resourcesOf>>[number]) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    url: r.kind === 'link' ? r.url : null,
    size: r.size_bytes === null ? null : Number(r.size_bytes),
  })

  return (
    new Hono<{ Variables: AuthVariables }>()

      // P2.01 Dashboard: which cohort, what's next, how attendance and progress stand.
      .get('/overview', async (c) => {
        const auth = c.var.auth
        const t = now()
        const [enrolments, rows, timeZone] = await Promise.all([
          deps.sql<{ status: string; cohort_id: string; cohort_name: string; starts_on: string; ends_on: string; cohort_status: string; programme_name: string; changed_at: Date }[]>`
            select e.status, h.id as cohort_id, h.name as cohort_name, h.starts_on::text, h.ends_on::text, public.status(h) as cohort_status,
                   p.name as programme_name, e.status_changed_at as changed_at
            from public.enrolments e join public.cohorts h on h.id = e.cohort_id join public.programmes p on p.id = h.programme_id
            where e.member_id = ${auth.memberId} and e.organisation_id = ${auth.organisationId}
            order by h.starts_on desc
          `,
          selectMySessions(deps.sql, auth),
          timeZoneOf(auth.organisationId),
        ])
        // The cohort to show: an active enrolment (running first, then upcoming), else the most recent completed one.
        const active = enrolments.filter((e) => e.status === 'active')
        const current =
          active.find((e) => e.cohort_status === 'active') ?? active.find((e) => e.cohort_status === 'upcoming') ?? active[0] ?? enrolments.find((e) => e.status === 'completed') ?? null
        const deferred = !current ? enrolments.find((e) => e.status === 'deferred') ?? null : null
        const mine = current ? rows.filter((r) => r.cohort_id === current.cohort_id) : []
        const live = mine.filter((r) => r.status !== 'cancelled')
        const upcoming = live.filter((r) => r.ends_at.getTime() > t)
        const held = live.filter((r) => r.status === 'held')
        const plannedTotal = new Map<string, number>()
        for (const r of mine) plannedTotal.set(r.cohort_course_id, r.total)
        return c.json({
          timeZone,
          enrolment: current
            ? {
                status: current.status,
                cohort: { id: current.cohort_id, name: current.cohort_name, startsOn: current.starts_on, endsOn: current.ends_on, status: current.cohort_status },
                programme: current.programme_name,
              }
            : null,
          deferred: deferred ? { cohort: deferred.cohort_name, since: deferred.changed_at } : null,
          nextSession: upcoming[0] ? toSession(upcoming[0], t) : null,
          upcoming: upcoming.slice(0, 3).map((r) => toSession(r, t)),
          attendance: attendanceOf(mine),
          recentAttendance: held
            .filter((r) => r.mark)
            .reverse()
            .slice(0, 4)
            .map((r) => toSession(r, t)),
          progress: { held: held.length, total: [...plannedTotal.values()].reduce((s, v) => s + v, 0) },
        })
      })

      // P4.01 Sessions: everything in my cohorts with my attendance.
      .get('/sessions', async (c) => {
        const t = now()
        const [rows, timeZone] = await Promise.all([selectMySessions(deps.sql, c.var.auth), timeZoneOf(c.var.auth.organisationId)])
        return c.json({ timeZone, attendance: attendanceOf(rows), sessions: rows.map((r) => toSession(r, t)) })
      })

      // P4.02 One session: live / in person / past, with my attendance and its resources.
      .get('/sessions/:id', async (c) => {
        const id = c.req.param('id')
        if (!uuid.safeParse(id).success) throw notFound('Session not found.')
        const [row] = await selectMySessions(deps.sql, c.var.auth, { id })
        if (!row) throw notFound('Session not found.')
        const [resources, timeZone] = await Promise.all([resourcesOf(row.cohort_course_id, row.id), timeZoneOf(c.var.auth.organisationId)])
        return c.json({ timeZone, session: toSession(row, now()), resources: resources.map(toResource) })
      })

      // P3.01 My courses.
      .get('/courses', async (c) => {
        const auth = c.var.auth
        const t = now()
        const [rows, courses, work, timeZone] = await Promise.all([
          selectMySessions(deps.sql, auth),
          deps.sql<{ id: string; name: string; cohort_id: string; cohort_name: string; programme_name: string; lead_first: string | null; lead_last: string | null }[]>`
            select x.id, co.name, h.id as cohort_id, h.name as cohort_name, p.name as programme_name, m.first_name as lead_first, m.last_name as lead_last
            from public.enrolments e
            join public.cohort_courses x on x.cohort_id = e.cohort_id
            join public.courses co on co.id = x.course_id
            join public.cohorts h on h.id = x.cohort_id
            join public.programmes p on p.id = x.programme_id
            left join public.cohort_course_trainers ct on ct.cohort_course_id = x.id and ct.is_lead
            left join public.organisation_members m on m.id = ct.member_id
            where e.member_id = ${auth.memberId} and e.organisation_id = ${auth.organisationId} and e.status in ('active', 'completed')
            order by h.starts_on desc, co.name
          `,
          deps.sql<{ cohort_course_id: string; published: number; submitted: number }[]>`
            select a.cohort_course_id, count(*)::int as published, count(s.id)::int as submitted
            from public.assignments a
            left join public.submissions s on s.assignment_id = a.id and s.member_id = ${auth.memberId}
            where a.organisation_id = ${auth.organisationId} and a.published_at is not null
            group by a.cohort_course_id
          `,
          timeZoneOf(auth.organisationId),
        ])
        return c.json({
          timeZone,
          courses: courses.map((x) => {
            const sessions = rows.filter((r) => r.cohort_course_id === x.id)
            const next = sessions.find((r) => r.status !== 'cancelled' && r.ends_at.getTime() > t)
            const w = work.find((v) => v.cohort_course_id === x.id)
            const modes = new Set(sessions.filter((r) => r.status !== 'cancelled').map((r) => (r.mode === 'online' ? 'online' : r.location ?? 'in person')))
            return {
              id: x.id,
              name: x.name,
              cohort: { id: x.cohort_id, name: x.cohort_name },
              programme: x.programme_name,
              trainer: name(x.lead_first, x.lead_last),
              where: [...modes].slice(0, 2).join(', ') || null,
              attendance: attendanceOf(sessions),
              work: w ? { submitted: w.submitted, published: w.published } : null,
              nextSession: next ? toSession(next, t) : null,
            }
          }),
        })
      })

      // P3.02 Course detail: sessions with my attendance, trainer and resources (assignments come from /assignments).
      .get('/courses/:id', async (c) => {
        const auth = c.var.auth
        const id = c.req.param('id')
        if (!uuid.safeParse(id).success) throw notFound('Course not found.')
        const [course] = await deps.sql<{ id: string; name: string; cohort_id: string; cohort_name: string; lead_first: string | null; lead_last: string | null; lead_id: string | null }[]>`
          select x.id, co.name, h.id as cohort_id, h.name as cohort_name, m.first_name as lead_first, m.last_name as lead_last, m.id as lead_id
          from public.enrolments e
          join public.cohort_courses x on x.cohort_id = e.cohort_id
          join public.courses co on co.id = x.course_id
          join public.cohorts h on h.id = x.cohort_id
          left join public.cohort_course_trainers ct on ct.cohort_course_id = x.id and ct.is_lead
          left join public.organisation_members m on m.id = ct.member_id
          where e.member_id = ${auth.memberId} and e.organisation_id = ${auth.organisationId} and e.status in ('active', 'completed') and x.id = ${id}
        `
        if (!course) throw notFound('Course not found.')
        const t = now()
        const [rows, resources, timeZone] = await Promise.all([selectMySessions(deps.sql, auth, { cohortCourseId: id }), resourcesOf(id), timeZoneOf(auth.organisationId)])
        return c.json({
          timeZone,
          course: {
            id: course.id,
            name: course.name,
            cohort: { id: course.cohort_id, name: course.cohort_name },
            trainer: course.lead_id ? { id: course.lead_id, name: name(course.lead_first, course.lead_last) } : null,
          },
          attendance: attendanceOf(rows),
          sessions: rows.map((r) => toSession(r, t)),
          resources: resources.map(toResource),
        })
      })

      // Download a course or session resource file (5-minute link).
      .get('/resources/:id', async (c) => {
        const auth = c.var.auth
        const id = c.req.param('id')
        if (!uuid.safeParse(id).success) throw notFound('Resource not found.')
        const [file] = await deps.sql<{ name: string; storage_path: string | null; url: string | null }[]>`
          select r.name, r.storage_path, r.url from public.resources r
          join public.cohort_courses x on x.id = r.cohort_course_id
          join public.enrolments e on e.cohort_id = x.cohort_id and e.member_id = ${auth.memberId} and e.status in ('active', 'completed')
          where r.id = ${id} and r.organisation_id = ${auth.organisationId}
        `
        if (!file) throw notFound('Resource not found.')
        return c.json({ url: file.storage_path ? await deps.storage.downloadUrl(file.storage_path, file.name) : file.url })
      })
  )
}
