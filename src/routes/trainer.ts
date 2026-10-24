import { Hono } from 'hono'
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
        const [courses, trainers, sessions, work, [org]] = await Promise.all([
          deps.sql<{ id: string; name: string }[]>`
            select x.id, co.name from public.cohort_course_trainers t join public.cohort_courses x on x.id = t.cohort_course_id
            join public.courses co on co.id = x.course_id where t.member_id = ${auth.memberId} and x.cohort_id = ${p.cohort_id} order by co.name
          `,
          deps.sql<{ first_name: string; last_name: string }[]>`
            select distinct m.first_name, m.last_name from public.cohort_course_trainers t join public.cohort_courses x on x.id = t.cohort_course_id
            join public.organisation_members m on m.id = t.member_id where x.cohort_id = ${p.cohort_id} order by m.first_name
          `,
          deps.sql<{ id: string; starts_at: Date; course_name: string; mark: string | null }[]>`
            select s.id, s.starts_at, co.name as course_name, a.status as mark
            from public.sessions s
            join public.cohort_courses x on x.id = s.cohort_course_id
            join public.courses co on co.id = x.course_id
            left join public.attendance_records a on a.session_id = s.id and a.member_id = ${memberId}
            where x.cohort_id = ${p.cohort_id} and s.cancelled_at is null and s.ends_at <= now()
              and x.id in (select cohort_course_id from public.cohort_course_trainers where member_id = ${auth.memberId})
            order by s.starts_at
          `,
          deps.sql<{ id: string; title: string; course_name: string; due_at: Date; submitted_at: Date | null; is_late: boolean | null; graded: boolean; grading_scale: string; max_points: string | null; points: string | null; percentage: string | null; letter: string | null; passed: boolean | null; total: number | null; criteria: number }[]>`
            select a.id, a.title, co.name as course_name, a.due_at, s.submitted_at, s.is_late, (g.id is not null) as graded,
                   a.grading_scale, a.max_points, g.points, g.percentage, g.letter, g.passed,
                   (select sum(r.score)::int from public.rubric_scores r where r.grade_id = g.id) as total,
                   (select count(*)::int from public.rubric_criteria rc where rc.assignment_id = a.id) as criteria
            from public.assignments a
            join public.cohort_courses x on x.id = a.cohort_course_id
            join public.courses co on co.id = x.course_id
            left join public.submissions s on s.assignment_id = a.id and s.member_id = ${memberId}
            left join public.grades g on g.submission_id = s.id
            where x.cohort_id = ${p.cohort_id} and a.published_at is not null
              and x.id in (select cohort_course_id from public.cohort_course_trainers where member_id = ${auth.memberId})
            order by a.due_at desc
          `,
          deps.sql<{ time_zone: string }[]>`select time_zone from public.organisations where id = ${auth.organisationId}`,
        ])
        const display = (w: (typeof work)[number]) => {
          if (!w.graded) return null
          switch (w.grading_scale) {
            case 'points':
              return `${Number(w.points)} / ${Number(w.max_points)}`
            case 'percentage':
              return `${Number(w.percentage)}%`
            case 'letter':
              return w.letter
            case 'pass_fail':
              return w.passed ? 'Pass' : 'Fail'
            default:
              return `${w.total ?? 0} / ${w.criteria * 4}`
          }
        }
        const recorded = sessions.filter((s) => s.mark)
        return c.json({
          timeZone: org!.time_zone,
          participant: { id: memberId, name: `${p.first_name} ${p.last_name}`.trim(), firstName: p.first_name, email: p.email, enrolledAt: p.enrolled_at },
          cohort: { id: p.cohort_id, name: p.cohort_name },
          courses: courses.map((x) => x.name),
          trainers: trainers.map((t) => `${t.first_name} ${t.last_name}`.trim()),
          attendance: { present: recorded.filter((s) => s.mark === 'present').length, recorded: recorded.length },
          sessions: sessions.map((s) => ({ id: s.id, startsAt: s.starts_at, course: s.course_name, mark: s.mark })),
          assignments: work.map((w) => ({
            id: w.id,
            title: w.title,
            course: w.course_name,
            dueAt: w.due_at,
            submittedAt: w.submitted_at,
            status: w.graded ? 'graded' : w.submitted_at ? (w.is_late ? 'late' : 'submitted') : w.due_at.getTime() < Date.now() ? 'overdue' : 'not_submitted',
            grade: display(w),
          })),
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
  )
}
