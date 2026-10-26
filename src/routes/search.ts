import { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import type { Sql } from '../lib/db.js'
import { isAdmin, staffScope, teachingIds } from '../lib/staff.js'
import type { AuthContext } from '../lib/auth.js'
import { requireAuth, type AuthVariables } from '../middleware/auth.js'

type Kind = 'participants' | 'cohorts' | 'courses' | 'programmes' | 'trainers' | 'sessions' | 'interventions'
type Item = { id: string; title: string; subtitle: string; link: string }
type Group = { kind: Kind; label: string; items: Item[] }

const LIMIT = 5
const methodLabel: Record<string, string> = { call: 'Phone call', email: 'Email', message: 'Message', visit: 'In-person visit', other: 'Follow-up' }
const outcomeLabel: Record<string, string> = { awaiting_response: 'Awaiting response', reached: 'Reached', resolved: 'Resolved', no_response: 'No response' }
const roleLabel: Record<string, string> = { owner: 'Owner', admin: 'Admin', trainer: 'Trainer', assistant_trainer: 'Assistant trainer' }
const enrolmentLabel: Record<string, string> = { active: 'Active', deferred: 'Deferred', withdrawn: 'Withdrawn', completed: 'Completed', transferred: 'Transferred' }

/** "50%_off" → a LIKE pattern that matches it literally anywhere. */
const like = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`

/** /v1/search?q= — G1.02 search in the top bar. Everyone sees only what their role can open. */
export function searchRoutes(deps: AppDeps) {
  return new Hono<{ Variables: AuthVariables }>().use(requireAuth(deps)).get('/', async (c) => {
    const q = (c.req.query('q') ?? '').trim().replace(/\s+/g, ' ').slice(0, 80)
    if (q.length < 2) return c.json({ query: q, groups: [] })
    const auth = c.var.auth
    const [org] = await deps.sql<{ time_zone: string }[]>`select time_zone from public.organisations where id = ${auth.organisationId}`
    const day = (d: Date) => {
      const parts = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: org!.time_zone }).formatToParts(d)
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
      return `${get('weekday')} ${get('day')} ${get('month')}`
    }
    const groups = isAdmin(auth)
      ? await adminSearch(deps.sql, auth, like(q), day)
      : auth.role === 'participant'
        ? await participantSearch(deps.sql, auth, like(q), day)
        : await trainerSearch(deps.sql, auth, like(q), day)
    return c.json({ query: q, groups: groups.filter((g) => g.items.length) })
  })
}

type Day = (d: Date) => string

interface SessionRow {
  id: string
  title: string
  course: string
  cohort: string
  starts_at: Date
  cancelled: boolean
}

/** Sessions nearest to now first: what's coming up or just happened is what people look for. */
function sessionsMatching(sql: Sql, auth: AuthContext, pattern: string, cohortCourseIds: string[] | null) {
  return sql<SessionRow[]>`
    select s.id, s.title, co.name as course, h.name as cohort, s.starts_at, s.cancelled_at is not null as cancelled
    from public.sessions s
    join public.cohort_courses x on x.id = s.cohort_course_id
    join public.courses co on co.id = x.course_id
    join public.cohorts h on h.id = x.cohort_id
    where s.organisation_id = ${auth.organisationId} and h.archived_at is null
      and (co.name ilike ${pattern} or s.title ilike ${pattern})
      ${cohortCourseIds ? sql`and s.cohort_course_id = any(${cohortCourseIds}::uuid[])` : sql``}
    order by abs(extract(epoch from s.starts_at - now())) limit ${LIMIT}
  `
}

const sessionItem = (s: SessionRow, link: string, day: Day): Item => ({
  id: s.id,
  title: `${s.course} · ${day(s.starts_at)}`,
  subtitle: `${s.cohort}${s.cancelled ? ' · Cancelled' : s.title && s.title !== s.course ? ` · ${s.title}` : ''}`,
  link,
})

async function adminSearch(sql: Sql, auth: AuthContext, pattern: string, day: Day): Promise<Group[]> {
  const org = auth.organisationId
  const [participants, cohorts, courses, programmes, trainers, sessions] = await Promise.all([
    sql<{ id: string; first_name: string; last_name: string; cohort: string | null; status: string | null; flagged: boolean }[]>`
      select m.id, m.first_name, m.last_name, e.cohort, e.status,
             exists (select 1 from public.attention_flags f join public.enrolments en on en.id = f.enrolment_id
                     where en.member_id = m.id and f.cleared_at is null and f.resolved_at is null) as flagged
      from public.organisation_members m
      left join lateral (
        select h.name as cohort, en.status::text as status from public.enrolments en join public.cohorts h on h.id = en.cohort_id
        where en.member_id = m.id order by (en.status = 'active') desc, h.starts_on desc limit 1
      ) e on true
      where m.organisation_id = ${org} and m.role = 'participant' and m.status <> 'deactivated'
        and (m.first_name || ' ' || m.last_name ilike ${pattern} or m.email ilike ${pattern})
      order by m.first_name, m.last_name limit ${LIMIT}
    `,
    sql<{ id: string; name: string; programme: string }[]>`
      select h.id, h.name, p.name as programme from public.cohorts h join public.programmes p on p.id = h.programme_id
      where h.organisation_id = ${org} and h.archived_at is null and h.name ilike ${pattern} order by h.starts_on desc limit ${LIMIT}
    `,
    sql<{ id: string; name: string; programme_id: string; programme: string }[]>`
      select co.id, co.name, p.id as programme_id, p.name as programme from public.courses co join public.programmes p on p.id = co.programme_id
      where co.organisation_id = ${org} and co.archived_at is null and co.name ilike ${pattern} order by co.name limit ${LIMIT}
    `,
    sql<{ id: string; name: string; cohorts: number }[]>`
      select p.id, p.name, (select count(*)::int from public.cohorts h where h.programme_id = p.id and h.archived_at is null) as cohorts
      from public.programmes p where p.organisation_id = ${org} and p.archived_at is null and p.name ilike ${pattern} order by p.name limit ${LIMIT}
    `,
    sql<{ id: string; first_name: string; last_name: string; role: string; status: string }[]>`
      select id, first_name, last_name, role, status from public.organisation_members
      where organisation_id = ${org} and role in ('trainer', 'assistant_trainer') and status <> 'deactivated'
        and (first_name || ' ' || last_name ilike ${pattern} or email ilike ${pattern})
      order by first_name, last_name limit ${LIMIT}
    `,
    sessionsMatching(sql, auth, pattern, null),
  ])
  const interventions = participants.length
    ? await sql<{ id: string; member_id: string; first_name: string; method: string; outcome: string | null; contacted_at: Date }[]>`
        select i.id, en.member_id, m.first_name, i.method::text, i.outcome::text, i.contacted_at
        from public.interventions i join public.enrolments en on en.id = i.enrolment_id join public.organisation_members m on m.id = en.member_id
        where i.organisation_id = ${org} and en.member_id = any(${participants.map((p) => p.id)}::uuid[])
        order by i.contacted_at desc limit 3
      `
    : []
  return [
    {
      kind: 'participants',
      label: 'Participants',
      items: participants.map((p) => ({
        id: p.id,
        title: `${p.first_name} ${p.last_name}`,
        subtitle: [p.cohort ?? 'Not in a cohort', p.flagged ? 'Needs attention' : p.status ? enrolmentLabel[p.status] : null].filter(Boolean).join(' · '),
        link: `/admin/participants/${p.id}`,
      })),
    },
    { kind: 'cohorts', label: 'Cohorts', items: cohorts.map((h) => ({ id: h.id, title: h.name, subtitle: h.programme, link: `/admin/cohorts/${h.id}` })) },
    { kind: 'courses', label: 'Courses', items: courses.map((co) => ({ id: co.id, title: co.name, subtitle: co.programme, link: `/admin/courses/library/${co.id}` })) },
    {
      kind: 'programmes',
      label: 'Programmes',
      items: programmes.map((p) => ({ id: p.id, title: p.name, subtitle: `${p.cohorts} ${p.cohorts === 1 ? 'cohort' : 'cohorts'}`, link: `/admin/programmes/${p.id}` })),
    },
    {
      kind: 'trainers',
      label: 'Trainers',
      items: trainers.map((t) => ({
        id: t.id,
        title: `${t.first_name} ${t.last_name}`,
        subtitle: `${roleLabel[t.role]}${t.status === 'invited' ? ' · Invited' : ''}`,
        link: `/admin/trainers/${t.id}`,
      })),
    },
    { kind: 'sessions', label: 'Sessions', items: sessions.map((s) => sessionItem(s, `/admin/courses/sessions/${s.id}`, day)) },
    {
      kind: 'interventions',
      label: 'Interventions',
      items: interventions.map((i) => ({
        id: i.id,
        title: `${methodLabel[i.method] ?? 'Follow-up'} with ${i.first_name}`,
        subtitle: [day(i.contacted_at), i.outcome ? outcomeLabel[i.outcome] : null].filter(Boolean).join(' · '),
        link: `/admin/participants/${i.member_id}`,
      })),
    },
  ]
}

async function trainerSearch(sql: Sql, auth: AuthContext, pattern: string, day: Day): Promise<Group[]> {
  const ids = teachingIds(await staffScope(sql, auth)) ?? []
  if (!ids.length) return []
  const [participants, cohorts, courses, sessions] = await Promise.all([
    sql<{ id: string; first_name: string; last_name: string; cohort: string }[]>`
      select distinct on (m.first_name, m.last_name, m.id) m.id, m.first_name, m.last_name, h.name as cohort
      from public.organisation_members m
      join public.enrolments en on en.member_id = m.id and en.status = 'active'
      join public.cohorts h on h.id = en.cohort_id and h.archived_at is null
      join public.cohort_courses x on x.cohort_id = h.id and x.id = any(${ids}::uuid[])
      where m.organisation_id = ${auth.organisationId} and m.status <> 'deactivated'
        and (m.first_name || ' ' || m.last_name ilike ${pattern} or m.email ilike ${pattern})
      order by m.first_name, m.last_name, m.id limit ${LIMIT}
    `,
    sql<{ id: string; name: string; programme: string }[]>`
      select distinct h.id, h.name, p.name as programme, h.starts_on from public.cohorts h
      join public.programmes p on p.id = h.programme_id
      join public.cohort_courses x on x.cohort_id = h.id and x.id = any(${ids}::uuid[])
      where h.archived_at is null and h.name ilike ${pattern} order by h.starts_on desc limit ${LIMIT}
    `,
    sql<{ id: string; name: string; cohort_id: string; cohort: string }[]>`
      select x.id, co.name, h.id as cohort_id, h.name as cohort from public.cohort_courses x
      join public.courses co on co.id = x.course_id join public.cohorts h on h.id = x.cohort_id
      where x.id = any(${ids}::uuid[]) and h.archived_at is null and co.name ilike ${pattern} order by co.name limit ${LIMIT}
    `,
    sessionsMatching(sql, auth, pattern, ids),
  ])
  return [
    {
      kind: 'participants',
      label: 'Participants',
      items: participants.map((p) => ({ id: p.id, title: `${p.first_name} ${p.last_name}`, subtitle: p.cohort, link: `/trainer/participants/${p.id}` })),
    },
    { kind: 'cohorts', label: 'Cohorts', items: cohorts.map((h) => ({ id: h.id, title: h.name, subtitle: h.programme, link: `/trainer/cohorts/${h.id}` })) },
    { kind: 'courses', label: 'Courses', items: courses.map((co) => ({ id: co.id, title: co.name, subtitle: co.cohort, link: `/trainer/cohorts/${co.cohort_id}/courses` })) },
    { kind: 'sessions', label: 'Sessions', items: sessions.map((s) => sessionItem(s, `/trainer/sessions/${s.id}`, day)) },
  ]
}

async function participantSearch(sql: Sql, auth: AuthContext, pattern: string, day: Day): Promise<Group[]> {
  const mine = await sql<{ id: string }[]>`
    select x.id from public.enrolments e join public.cohort_courses x on x.cohort_id = e.cohort_id
    where e.member_id = ${auth.memberId} and e.status in ('active', 'completed')
  `
  const ids = mine.map((r) => r.id)
  if (!ids.length) return []
  const [courses, sessions] = await Promise.all([
    sql<{ id: string; name: string; cohort: string }[]>`
      select x.id, co.name, h.name as cohort from public.cohort_courses x
      join public.courses co on co.id = x.course_id join public.cohorts h on h.id = x.cohort_id
      where x.id = any(${ids}::uuid[]) and co.name ilike ${pattern} order by co.name limit ${LIMIT}
    `,
    sessionsMatching(sql, auth, pattern, ids),
  ])
  return [
    { kind: 'courses', label: 'Courses', items: courses.map((co) => ({ id: co.id, title: co.name, subtitle: co.cohort, link: `/participant/courses/${co.id}` })) },
    { kind: 'sessions', label: 'Sessions', items: sessions.map((s) => sessionItem(s, `/participant/sessions/${s.id}`, day)) },
  ]
}
