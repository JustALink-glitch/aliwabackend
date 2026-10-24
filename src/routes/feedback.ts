import { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import { notFound } from '../lib/errors.js'
import { uuid } from '../lib/validation.js'
import { requireAuth, requireRole, type AuthVariables } from '../middleware/auth.js'

/**
 * /v1/session-feedback/:sessionId — C5.01 (admins) and T7.04 (the course's trainers).
 * Always anonymous: totals and comments, never who said what.
 */
export function feedbackRoutes(deps: AppDeps) {
  return new Hono<{ Variables: AuthVariables }>()
    .use(requireAuth(deps), requireRole('owner', 'admin', 'trainer', 'assistant_trainer'))
    .get('/:sessionId', async (c) => {
      const auth = c.var.auth
      const id = c.req.param('sessionId')
      if (!uuid.safeParse(id).success) throw notFound('Session not found.')
      const admin = auth.role === 'owner' || auth.role === 'admin'
      const [session] = await deps.sql<{ id: string; status: string; starts_at: Date; course_name: string; cohort_name: string; number: number | null }[]>`
        select s.id, public.status(s) as status, s.starts_at, co.name as course_name, h.name as cohort_name,
               (select count(*)::int from public.sessions y
                 where y.cohort_course_id = s.cohort_course_id and y.cancelled_at is null and y.starts_at <= s.starts_at) as number
        from public.sessions s
        join public.cohort_courses x on x.id = s.cohort_course_id
        join public.courses co on co.id = x.course_id
        join public.cohorts h on h.id = x.cohort_id
        where s.id = ${id} and s.organisation_id = ${auth.organisationId}
          ${admin ? deps.sql`` : deps.sql`and exists (select 1 from public.cohort_course_trainers t where t.cohort_course_id = x.id and t.member_id = ${auth.memberId})`}
      `
      if (!session) throw notFound('Session not found.')
      const [[counts], comments, [org]] = await Promise.all([
        deps.sql<{ responses: number; average: string | null; attended: number; r1: number; r2: number; r3: number; r4: number; r5: number }[]>`
          select count(f.*)::int as responses, round(avg(f.rating), 1) as average,
                 (select count(*)::int from public.attendance_records a where a.session_id = ${id} and a.status = 'present') as attended,
                 count(*) filter (where f.rating = 1)::int as r1, count(*) filter (where f.rating = 2)::int as r2,
                 count(*) filter (where f.rating = 3)::int as r3, count(*) filter (where f.rating = 4)::int as r4,
                 count(*) filter (where f.rating = 5)::int as r5
          from public.session_feedback f where f.session_id = ${id}
        `,
        deps.sql<{ comment: string; created_at: Date }[]>`
          select comment, created_at from public.session_feedback
          where session_id = ${id} and comment is not null order by created_at desc
        `,
        deps.sql<{ time_zone: string }[]>`select time_zone from public.organisations where id = ${auth.organisationId}`,
      ])
      return c.json({
        timeZone: org!.time_zone,
        session: { id: session.id, status: session.status, startsAt: session.starts_at, course: session.course_name, cohort: session.cohort_name, number: session.number },
        responses: counts!.responses,
        attended: counts!.attended,
        average: counts!.average === null ? null : Number(counts!.average),
        distribution: { 1: counts!.r1, 2: counts!.r2, 3: counts!.r3, 4: counts!.r4, 5: counts!.r5 },
        comments: comments.map((x) => ({ comment: x.comment, at: x.created_at })),
      })
    })
}
