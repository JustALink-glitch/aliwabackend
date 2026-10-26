import { Hono } from 'hono'
import { participantLearning } from '../lib/learning.js'
import type { AppDeps } from '../app.js'
import { refreshFlags, ruleSettings, type Rule } from '../lib/attention.js'
import { notFound } from '../lib/errors.js'
import { uuid } from '../lib/validation.js'
import { requireAuth, requireRole, type AuthVariables } from '../middleware/auth.js'
import { selectCohortSummaries, toCohortSummary } from './programmes.js'

/**
 * /v1/trainer — T7 My participants. Trainers see people in cohorts they teach; attendance and work are
 * from their own courses only, while flags use the whole cohort (§03 decision, 18 Oct).
 */
export function trainerRoutes(deps: AppDeps) {
  const now = () => (deps.now ? deps.now() : new Date())

  return (
    new Hono<{ Variables: AuthVariables }>()
      .use(requireAuth(deps), requireRole('trainer', 'assistant_trainer'))

      // T7.01 My participants.
      .get('/participants', async (c) => {
        const auth = c.var.auth
        await refreshFlags(deps.sql, auth.organisationId, now())
        const [rows, [org], rules] = await Promise.all([
          deps.sql<{
            member_id: string
            first_name: string
            last_name: string
            cohort_id: string
            cohort_name: string
            enrolment_status: string
            present: number
            recorded: number
            submitted: number
            published: number
            flag: Rule | null
            last_active: Date | null
          }[]>`
            with mine as (
              select x.id as cohort_course_id, x.cohort_id from public.cohort_course_trainers t
              join public.cohort_courses x on x.id = t.cohort_course_id where t.member_id = ${auth.memberId}
            )
            select m.id as member_id, m.first_name, m.last_name, h.id as cohort_id, h.name as cohort_name, e.status as enrolment_status,
                   (select count(*)::int from public.attendance_records a join public.sessions s on s.id = a.session_id
                     where a.member_id = m.id and a.status = 'present' and s.cohort_course_id in (select cohort_course_id from mine where cohort_id = h.id)) as present,
                   (select count(*)::int from public.attendance_records a join public.sessions s on s.id = a.session_id
                     where a.member_id = m.id and s.cancelled_at is null and s.cohort_course_id in (select cohort_course_id from mine where cohort_id = h.id)) as recorded,
                   (select count(*)::int from public.submissions s join public.assignments a on a.id = s.assignment_id
                     where s.member_id = m.id and a.cohort_course_id in (select cohort_course_id from mine where cohort_id = h.id)) as submitted,
                   (select count(*)::int from public.assignments a
                     where a.published_at is not null and a.cohort_course_id in (select cohort_course_id from mine where cohort_id = h.id)) as published,
                   (select f.rule from public.attention_flags f where f.enrolment_id = e.id and f.cleared_at is null and f.resolved_at is null
                     order by f.raised_at, array_position(array['missed_in_row','overdue_assignments','low_attendance','low_grade','inactive'], f.rule::text) limit 1) as flag,
                   greatest(u.last_sign_in_at,
                            (select max(s.submitted_at) from public.submissions s where s.member_id = m.id),
                            (select max(se.starts_at) from public.attendance_records a join public.sessions se on se.id = a.session_id where a.member_id = m.id and a.status = 'present')) as last_active
            from public.enrolments e
            join public.cohorts h on h.id = e.cohort_id
            join public.organisation_members m on m.id = e.member_id
            left join auth.users u on u.id = m.user_id
            where e.organisation_id = ${auth.organisationId} and e.status in ('active', 'completed')
              and e.cohort_id in (select cohort_id from mine) and public.status(h) <> 'archived'
            order by (select 1 from public.attention_flags f where f.enrolment_id = e.id and f.cleared_at is null and f.resolved_at is null limit 1) nulls last,
                     m.first_name, m.last_name
          `,
          deps.sql<{ time_zone: string }[]>`select time_zone from public.organisations where id = ${auth.organisationId}`,
          ruleSettings(deps.sql, auth.organisationId),
        ])
        return c.json({
          timeZone: org!.time_zone,
          participants: rows.map((r) => ({
            id: r.member_id,
            name: `${r.first_name} ${r.last_name}`.trim(),
            cohort: { id: r.cohort_id, name: r.cohort_name },
            attendance: r.recorded ? { present: r.present, recorded: r.recorded, rate: Math.round((r.present / r.recorded) * 100) } : null,
            work: { submitted: r.submitted, published: r.published },
            flag: rules.trainersSee ? r.flag : null,
            lastActive: r.last_active,
          })),
        })
      })

      // T7.02 One participant, from the trainer's own courses.
      .get('/participants/:memberId', async (c) => {
        const auth = c.var.auth
        const memberId = c.req.param('memberId')
        if (!uuid.safeParse(memberId).success) throw notFound('Participant not found.')
        const [p] = await deps.sql<{ first_name: string; last_name: string; email: string; enrolled_at: Date; cohort_id: string; cohort_name: string }[]>`
          select m.first_name, m.last_name, m.email, e.enrolled_at, h.id as cohort_id, h.name as cohort_name
          from public.enrolments e join public.organisation_members m on m.id = e.member_id join public.cohorts h on h.id = e.cohort_id
          where e.member_id = ${memberId} and e.organisation_id = ${auth.organisationId} and m.role = 'participant'
            and e.cohort_id in (select x.cohort_id from public.cohort_course_trainers t join public.cohort_courses x on x.id = t.cohort_course_id where t.member_id = ${auth.memberId})
          order by (e.status = 'active') desc, e.enrolled_at desc limit 1
        `
        if (!p) throw notFound('Participant not found.')
        const [courses, trainers, learning, [org]] = await Promise.all([
          deps.sql<{ id: string; name: string }[]>`
            select x.id, co.name from public.cohort_course_trainers t join public.cohort_courses x on x.id = t.cohort_course_id
            join public.courses co on co.id = x.course_id where t.member_id = ${auth.memberId} and x.cohort_id = ${p.cohort_id} order by co.name
          `,
          deps.sql<{ first_name: string; last_name: string }[]>`
            select distinct m.first_name, m.last_name from public.cohort_course_trainers t join public.cohort_courses x on x.id = t.cohort_course_id
            join public.organisation_members m on m.id = t.member_id where x.cohort_id = ${p.cohort_id} order by m.first_name
          `,
          participantLearning(deps.sql, { memberId, cohortId: p.cohort_id, trainerId: auth.memberId }),
          deps.sql<{ time_zone: string }[]>`select time_zone from public.organisations where id = ${auth.organisationId}`,
        ])
        return c.json({
          timeZone: org!.time_zone,
          participant: { id: memberId, name: `${p.first_name} ${p.last_name}`.trim(), firstName: p.first_name, email: p.email, enrolledAt: p.enrolled_at },
          cohort: { id: p.cohort_id, name: p.cohort_name },
          courses: courses.map((x) => x.name),
          trainers: trainers.map((t) => `${t.first_name} ${t.last_name}`.trim()),
          ...learning,
        })
      })

      // T3.04 My cohorts: one row per course I teach in a cohort.
      .get('/cohorts', async (c) => {
        const auth = c.var.auth
        const [rows, [org]] = await Promise.all([
          deps.sql<{
            cohort_id: string
            cohort_name: string
            programme_name: string
            status: string
            starts_on: string
            ends_on: string
            course_name: string
            is_lead: boolean
            planned: number | null
            held: number
            participants: number
            present: number
            recorded: number
            next_at: Date | null
          }[]>`
            select h.id as cohort_id, h.name as cohort_name, p.name as programme_name, public.status(h) as status, h.starts_on::text, h.ends_on::text,
                   co.name as course_name, t.is_lead, x.planned_session_count as planned,
                   (select count(*)::int from public.sessions s where s.cohort_course_id = x.id and public.status(s) = 'held') as held,
                   (select count(*)::int from public.enrolments e where e.cohort_id = h.id and e.status in ('active', 'completed')) as participants,
                   (select count(*)::int from public.attendance_records a join public.sessions s on s.id = a.session_id
                     where s.cohort_course_id = x.id and s.cancelled_at is null and a.status = 'present') as present,
                   (select count(*)::int from public.attendance_records a join public.sessions s on s.id = a.session_id
                     where s.cohort_course_id = x.id and s.cancelled_at is null) as recorded,
                   (select min(s.starts_at) from public.sessions s where s.cohort_course_id = x.id and s.cancelled_at is null and s.ends_at > now()) as next_at
            from public.cohort_course_trainers t
            join public.cohort_courses x on x.id = t.cohort_course_id
            join public.cohorts h on h.id = x.cohort_id
            join public.programmes p on p.id = h.programme_id
            join public.courses co on co.id = x.course_id
            where t.member_id = ${auth.memberId} and h.archived_at is null and not h.is_draft
            order by (public.status(h) = 'completed'), h.starts_on desc, co.name
          `,
          deps.sql<{ time_zone: string }[]>`select time_zone from public.organisations where id = ${auth.organisationId}`,
        ])
        return c.json({
          timeZone: org!.time_zone,
          cohorts: rows.map((r) => ({
            id: r.cohort_id,
            name: r.cohort_name,
            programme: r.programme_name,
            status: r.status,
            startsOn: r.starts_on,
            endsOn: r.ends_on,
            course: { name: r.course_name, lead: r.is_lead, held: r.held, planned: r.planned },
            participants: r.participants,
            attendance: r.recorded ? Math.round((r.present / r.recorded) * 100) : null,
            nextSessionAt: r.next_at,
          })),
        })
      })

      // T3.05 Cohort detail, for a cohort I teach in.
      .get('/cohorts/:id', async (c) => {
        const auth = c.var.auth
        const id = c.req.param('id')
        if (!uuid.safeParse(id).success) throw notFound('Cohort not found.')
        const [summary] = await selectCohortSummaries(deps.sql, auth.organisationId, { id })
        const [mine] = await deps.sql<{ ok: number }[]>`
          select 1 as ok from public.cohort_course_trainers t join public.cohort_courses x on x.id = t.cohort_course_id
          where t.member_id = ${auth.memberId} and x.cohort_id = ${id}
        `
        if (!summary || !mine || summary.archived_at) throw notFound('Cohort not found.')
        await refreshFlags(deps.sql, auth.organisationId, now())
        const [courses, [flagged], [org], rules] = await Promise.all([
          deps.sql<{ id: string; course_id: string; name: string; planned: number | null; held: number; first_at: Date | null; mine: boolean; trainers: { id: string; name: string; isLead: boolean }[] }[]>`
            select x.id, x.course_id, co.name, x.planned_session_count as planned,
                   (select count(*)::int from public.sessions s where s.cohort_course_id = x.id and public.status(s) = 'held') as held,
                   (select min(s.starts_at) from public.sessions s where s.cohort_course_id = x.id and s.cancelled_at is null) as first_at,
                   exists (select 1 from public.cohort_course_trainers t where t.cohort_course_id = x.id and t.member_id = ${auth.memberId}) as mine,
                   coalesce((select json_agg(json_build_object('id', m.id, 'name', m.first_name || ' ' || m.last_name, 'isLead', t.is_lead) order by t.is_lead desc, m.first_name)
                             from public.cohort_course_trainers t join public.organisation_members m on m.id = t.member_id
                             where t.cohort_course_id = x.id and m.status <> 'deactivated'), '[]') as trainers
            from public.cohort_courses x join public.courses co on co.id = x.course_id
            where x.cohort_id = ${id} order by co.created_at
          `,
          deps.sql<{ n: number }[]>`
            select count(distinct f.enrolment_id)::int as n from public.attention_flags f join public.enrolments e on e.id = f.enrolment_id
            where e.cohort_id = ${id} and f.cleared_at is null and f.resolved_at is null
          `,
          deps.sql<{ time_zone: string }[]>`select time_zone from public.organisations where id = ${auth.organisationId}`,
          ruleSettings(deps.sql, auth.organisationId),
        ])
        return c.json({
          timeZone: org!.time_zone,
          cohort: toCohortSummary(summary),
          flagged: rules.trainersSee ? flagged!.n : null,
          courses: courses.map((x) => ({
            id: x.id,
            courseId: x.course_id,
            name: x.name,
            plannedSessions: x.planned,
            heldSessions: x.held,
            firstSessionAt: x.first_at,
            mine: x.mine,
            trainers: x.trainers,
          })),
        })
      })

      // T2.01 Today's teaching: my cohorts, today's sessions, grading queue and headline figures.
      .get('/today', async (c) => {
        const auth = c.var.auth
        const assistant = auth.role === 'assistant_trainer'
        await refreshFlags(deps.sql, auth.organisationId, now())
        const [cohorts, sessions, queue, [att], [flagged], [settings], leads, [org], rules] = await Promise.all([
          deps.sql<{ id: string; name: string; programme: string; status: string; participants: number; held: number; planned: number; present: number; recorded: number; next_at: Date | null; courses: string[] }[]>`
            with mine as (
              select x.id, x.cohort_id, x.planned_session_count from public.cohort_course_trainers t join public.cohort_courses x on x.id = t.cohort_course_id
              where t.member_id = ${auth.memberId}
            )
            select h.id, h.name, p.name as programme, public.status(h) as status,
                   (select count(*)::int from public.enrolments e where e.cohort_id = h.id and e.status = 'active') as participants,
                   (select count(*)::int from public.sessions s where s.cohort_course_id in (select id from mine where cohort_id = h.id) and public.status(s) = 'held') as held,
                   greatest((select coalesce(sum(planned_session_count), 0)::int from mine where cohort_id = h.id),
                            (select count(*)::int from public.sessions s where s.cohort_course_id in (select id from mine where cohort_id = h.id) and s.cancelled_at is null)) as planned,
                   (select count(*)::int from public.attendance_records a join public.sessions s on s.id = a.session_id
                     where s.cohort_course_id in (select id from mine where cohort_id = h.id) and s.cancelled_at is null and a.status = 'present') as present,
                   (select count(*)::int from public.attendance_records a join public.sessions s on s.id = a.session_id
                     where s.cohort_course_id in (select id from mine where cohort_id = h.id) and s.cancelled_at is null) as recorded,
                   (select min(s.starts_at) from public.sessions s where s.cohort_course_id in (select id from mine where cohort_id = h.id) and s.cancelled_at is null and s.ends_at > now()) as next_at,
                   array(select co.name from mine m join public.cohort_courses x on x.id = m.id join public.courses co on co.id = x.course_id where m.cohort_id = h.id order by co.name) as courses
            from public.cohorts h join public.programmes p on p.id = h.programme_id
            where h.id in (select cohort_id from mine) and public.status(h) in ('active', 'upcoming')
            order by h.starts_on
          `,
          // Today and the next one after, in the organisation's time zone.
          deps.sql<{ id: string; course: string; cohort: string; starts_at: Date; ends_at: Date; mode: string; location: string | null; join_url: string | null; status: string; expected: number; recorded: number; number: number; total: number; today: boolean }[]>`
            with tz as (select time_zone from public.organisations where id = ${auth.organisationId})
            select s.id, co.name as course, h.name as cohort, s.starts_at, s.ends_at, s.mode, s.location, s.zoom_join_url as join_url, public.status(s) as status,
                   (select count(*)::int from public.enrolments e where e.cohort_id = h.id and e.status = 'active') as expected,
                   (select count(*)::int from public.attendance_records a where a.session_id = s.id) as recorded,
                   (select count(*)::int from public.sessions y where y.cohort_course_id = s.cohort_course_id and y.cancelled_at is null and y.starts_at <= s.starts_at) as number,
                   greatest(coalesce(x.planned_session_count, 0), (select count(*)::int from public.sessions y where y.cohort_course_id = s.cohort_course_id and y.cancelled_at is null)) as total,
                   ((s.starts_at at time zone (select time_zone from tz))::date = (now() at time zone (select time_zone from tz))::date) as today
            from public.sessions s
            join public.cohort_courses x on x.id = s.cohort_course_id
            join public.courses co on co.id = x.course_id
            join public.cohorts h on h.id = x.cohort_id
            where s.cohort_course_id in (select cohort_course_id from public.cohort_course_trainers where member_id = ${auth.memberId})
              and s.cancelled_at is null
              and (s.starts_at at time zone (select time_zone from tz))::date >= (now() at time zone (select time_zone from tz))::date
            order by s.starts_at
            limit 8
          `,
          deps.sql<{ id: string; title: string; cohort: string; due_at: Date; closed: boolean; expected: number; submitted: number; late: number; to_grade: number }[]>`
            select a.id, a.title, h.name as cohort, a.due_at, (a.late_policy = 'closed' and a.due_at < now()) as closed,
                   (select count(*)::int from public.enrolments e where e.cohort_id = h.id and e.status = 'active') as expected,
                   (select count(*)::int from public.submissions s where s.assignment_id = a.id) as submitted,
                   (select count(*)::int from public.submissions s where s.assignment_id = a.id and s.is_late) as late,
                   (select count(*)::int from public.submissions s left join public.grades g on g.submission_id = s.id where s.assignment_id = a.id and g.id is null) as to_grade
            from public.assignments a
            join public.cohort_courses x on x.id = a.cohort_course_id
            join public.cohorts h on h.id = x.cohort_id
            where a.cohort_course_id in (select cohort_course_id from public.cohort_course_trainers where member_id = ${auth.memberId})
              and a.published_at is not null and h.archived_at is null
            order by a.due_at
          `,
          // Attendance in my courses: the last 4 weeks and the 4 before.
          deps.sql<{ present: number; recorded: number; prev_present: number; prev_recorded: number }[]>`
            select count(*) filter (where a.status = 'present' and s.starts_at > now() - interval '28 days')::int as present,
                   count(*) filter (where s.starts_at > now() - interval '28 days')::int as recorded,
                   count(*) filter (where a.status = 'present' and s.starts_at <= now() - interval '28 days' and s.starts_at > now() - interval '56 days')::int as prev_present,
                   count(*) filter (where s.starts_at <= now() - interval '28 days' and s.starts_at > now() - interval '56 days')::int as prev_recorded
            from public.attendance_records a join public.sessions s on s.id = a.session_id
            where s.cancelled_at is null and s.cohort_course_id in (select cohort_course_id from public.cohort_course_trainers where member_id = ${auth.memberId})
          `,
          deps.sql<{ n: number }[]>`
            select count(distinct f.enrolment_id)::int as n from public.attention_flags f join public.enrolments e on e.id = f.enrolment_id
            where f.organisation_id = ${auth.organisationId} and f.cleared_at is null and f.resolved_at is null
              and e.cohort_id in (select x.cohort_id from public.cohort_course_trainers t join public.cohort_courses x on x.id = t.cohort_course_id where t.member_id = ${auth.memberId})
          `,
          deps.sql<{ attendance: boolean; resources: boolean; grade: boolean; create: boolean; reports: boolean }[]>`
            select assistant_can_take_attendance as attendance, assistant_can_add_resources as resources, assistant_can_grade as grade,
                   assistant_can_create_assignments as create, assistant_can_write_reports as reports
            from public.organisation_settings where organisation_id = ${auth.organisationId}
          `,
          // For assistants: who leads the courses they assist on.
          deps.sql<{ course: string; cohort: string; lead: string | null }[]>`
            select co.name as course, h.name as cohort,
                   (select m.first_name || ' ' || m.last_name from public.cohort_course_trainers l join public.organisation_members m on m.id = l.member_id
                     where l.cohort_course_id = x.id and l.is_lead limit 1) as lead
            from public.cohort_course_trainers t join public.cohort_courses x on x.id = t.cohort_course_id
            join public.courses co on co.id = x.course_id join public.cohorts h on h.id = x.cohort_id
            where t.member_id = ${auth.memberId} and public.status(h) in ('active', 'upcoming') order by h.starts_on, co.name
          `,
          deps.sql<{ time_zone: string }[]>`select time_zone from public.organisations where id = ${auth.organisationId}`,
          ruleSettings(deps.sql, auth.organisationId),
        ])
        const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : null)
        const canGrade = !assistant || Boolean(settings?.grade)
        const open = queue.filter((q) => q.to_grade > 0 || q.due_at.getTime() > now().getTime())
        return c.json({
          timeZone: org!.time_zone,
          role: assistant ? 'assistant' : 'lead',
          can: assistant
            ? { attendance: settings!.attendance, resources: settings!.resources, grade: settings!.grade, createAssignments: settings!.create, reports: settings!.reports }
            : { attendance: true, resources: true, grade: true, createAssignments: true, reports: true },
          assists: assistant ? leads.map((l) => ({ course: l.course, cohort: l.cohort, lead: l.lead })) : [],
          cohorts: cohorts.map((h) => ({
            id: h.id,
            name: h.name,
            programme: h.programme,
            status: h.status,
            participants: h.participants,
            held: h.held,
            planned: h.planned,
            attendance: pct(h.present, h.recorded),
            nextSessionAt: h.next_at,
            courses: h.courses,
          })),
          attendance: { rate: pct(att!.present, att!.recorded), previous: pct(att!.prev_present, att!.prev_recorded) },
          toGrade: canGrade ? { submissions: queue.reduce((n, q) => n + q.to_grade, 0), assignments: queue.filter((q) => q.to_grade > 0).length } : null,
          flagged: rules.trainersSee ? flagged!.n : null,
          today: sessions.filter((s) => s.today).map(toToday),
          next: sessions.find((s) => !s.today) ? toToday(sessions.find((s) => !s.today)!) : null,
          grading: canGrade
            ? open.slice(0, 5).map((q) => ({ id: q.id, title: q.title, cohort: q.cohort, dueAt: q.due_at, closed: q.closed, expected: q.expected, submitted: q.submitted, late: q.late, toGrade: q.to_grade }))
            : [],
        })

        function toToday(s: (typeof sessions)[number]) {
          return {
            id: s.id,
            course: s.course,
            cohort: s.cohort,
            startsAt: s.starts_at,
            endsAt: s.ends_at,
            mode: s.mode,
            location: s.location,
            joinUrl: s.join_url,
            status: s.status,
            expected: s.expected,
            recorded: s.recorded,
            number: s.number,
            total: s.total,
          }
        }
      })
  )
}
