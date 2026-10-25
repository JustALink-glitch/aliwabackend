import { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import { refreshFlags } from '../lib/attention.js'
import { requireAuth, requireRole, type AuthVariables } from '../middleware/auth.js'

/** /v1/overview — O1.01 Programme overview (owners and admins). Lists come from their own endpoints. */
export function overviewRoutes(deps: AppDeps) {
  const now = () => (deps.now ? deps.now() : new Date())

  return new Hono<{ Variables: AuthVariables }>().use(requireAuth(deps), requireRole('owner', 'admin')).get('/', async (c) => {
    const { organisationId } = c.var.auth
    await refreshFlags(deps.sql, organisationId, now())
    const [[counts], [att], weeks, next, [flags], [setup], [org]] = await Promise.all([
      deps.sql<{ programmes: number; active: number; upcoming: number; participants: number }[]>`
        select (select count(*)::int from public.programmes p where p.organisation_id = ${organisationId} and p.archived_at is null) as programmes,
               (select count(*)::int from public.cohorts h where h.organisation_id = ${organisationId} and public.status(h) = 'active') as active,
               (select count(*)::int from public.cohorts h where h.organisation_id = ${organisationId} and public.status(h) = 'upcoming') as upcoming,
               (select count(*)::int from public.enrolments e join public.cohorts h on h.id = e.cohort_id
                 where e.organisation_id = ${organisationId} and e.status = 'active' and public.status(h) = 'active') as participants
      `,
      // Present ÷ recorded marks (excused counts as not present), last 4 weeks and the 4 before.
      deps.sql<{ present: number; recorded: number; prev_present: number; prev_recorded: number }[]>`
        select count(*) filter (where a.status = 'present' and s.starts_at > now() - interval '28 days')::int as present,
               count(*) filter (where s.starts_at > now() - interval '28 days')::int as recorded,
               count(*) filter (where a.status = 'present' and s.starts_at <= now() - interval '28 days' and s.starts_at > now() - interval '56 days')::int as prev_present,
               count(*) filter (where s.starts_at <= now() - interval '28 days' and s.starts_at > now() - interval '56 days')::int as prev_recorded
        from public.attendance_records a join public.sessions s on s.id = a.session_id
        where a.organisation_id = ${organisationId} and s.cancelled_at is null
      `,
      // Training activity: the last 8 weeks (Monday to Sunday, organisation time), oldest first.
      deps.sql<{ week: string; present: number; excused: number; absent: number }[]>`
        with tz as (select time_zone from public.organisations where id = ${organisationId}),
        weeks as (
          select generate_series(
            date_trunc('week', (now() at time zone (select time_zone from tz))::date) - interval '7 weeks',
            date_trunc('week', (now() at time zone (select time_zone from tz))::date),
            interval '1 week')::date as week
        )
        select w.week::text,
               count(a.id) filter (where a.status = 'present')::int as present,
               count(a.id) filter (where a.status = 'excused')::int as excused,
               count(a.id) filter (where a.status = 'absent')::int as absent
        from weeks w
        left join public.sessions s on s.organisation_id = ${organisationId} and s.cancelled_at is null
          and date_trunc('week', (s.starts_at at time zone (select time_zone from tz)))::date = w.week
        left join public.attendance_records a on a.session_id = s.id
        group by w.week order by w.week
      `,
      deps.sql<{ cohort_id: string; starts_at: Date; mode: string; location: string | null; join_url: string | null }[]>`
        select distinct on (x.cohort_id) x.cohort_id, s.starts_at, s.mode, s.location, s.zoom_join_url as join_url
        from public.sessions s join public.cohort_courses x on x.id = s.cohort_course_id
        where s.organisation_id = ${organisationId} and s.cancelled_at is null and s.ends_at > now()
        order by x.cohort_id, s.starts_at
      `,
      deps.sql<{ people: number; cohorts: number }[]>`
        select count(distinct f.enrolment_id)::int as people, count(distinct e.cohort_id)::int as cohorts
        from public.attention_flags f join public.enrolments e on e.id = f.enrolment_id
        where f.organisation_id = ${organisationId} and f.cleared_at is null and f.resolved_at is null
      `,
      // O1.01e "Set up your first cohort".
      deps.sql<{ programme: boolean; cohort: boolean; trainers: boolean; participants: boolean; courses: boolean; session: boolean; admins: number }[]>`
        select exists (select 1 from public.programmes where organisation_id = ${organisationId}) as programme,
               exists (select 1 from public.cohorts where organisation_id = ${organisationId}) as cohort,
               exists (select 1 from public.cohort_course_trainers where organisation_id = ${organisationId}) as trainers,
               exists (select 1 from public.enrolments where organisation_id = ${organisationId}) as participants,
               exists (select 1 from public.cohort_courses where organisation_id = ${organisationId}) as courses,
               exists (select 1 from public.sessions where organisation_id = ${organisationId}) as session,
               (select count(*)::int from public.organisation_members where organisation_id = ${organisationId} and role in ('owner', 'admin') and status <> 'deactivated') as admins
      `,
      deps.sql<{ name: string; time_zone: string }[]>`select name, time_zone from public.organisations where id = ${organisationId}`,
    ])
    const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : null)
    return c.json({
      organisation: org!.name,
      timeZone: org!.time_zone,
      programmes: counts!.programmes,
      cohorts: { active: counts!.active, upcoming: counts!.upcoming },
      participants: counts!.participants,
      attendance: { rate: pct(att!.present, att!.recorded), present: att!.present, recorded: att!.recorded, previous: pct(att!.prev_present, att!.prev_recorded) },
      needsAttention: { people: flags!.people, cohorts: flags!.cohorts },
      activity: weeks.map((w) => ({ weekOf: w.week, present: w.present, excused: w.excused, absent: w.absent, rate: pct(w.present, w.present + w.excused + w.absent) })),
      nextSessions: Object.fromEntries(next.map((n) => [n.cohort_id, { startsAt: n.starts_at, mode: n.mode, location: n.location, joinUrl: n.join_url }])),
      setup: { ...setup!, organisation: true },
    })
  })
}
