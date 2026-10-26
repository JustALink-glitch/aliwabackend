import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/lib/db.js'
import { addDays } from '../src/lib/schedule.js'
import { createTestDatabase, TEST_DATABASE_URL } from './helpers/db.js'
import { as, client, testApp } from './helpers/app.js'

const day = (offset: number) => addDays(new Date().toISOString().slice(0, 10), offset)

describe.skipIf(!TEST_DATABASE_URL)('counts shown in lists (programmes, cohorts, participants, trainers)', () => {
  let sql: Sql
  let drop: () => Promise<void>
  let req: ReturnType<typeof client>
  const owner = { id: randomUUID(), email: 'ada@aliwa.org' }
  let token: string
  const ids: Record<string, string> = {}
  const post = (path: string, body: unknown) => req('POST', path, { token, body })
  const get = (path: string) => req('GET', path, { token })

  beforeAll(async () => {
    ;({ sql, drop } = await createTestDatabase())
    const t = testApp(sql)
    req = client(t.app)
    await sql`insert into auth.users (id, email) values (${owner.id}, ${owner.email})`
    token = as(owner.id, owner.email)
    await post('/v1/organisations', { organisationName: 'ALIWA Foundation', fullName: 'Ada Obi' })
    ids.ngozi = ((await post('/v1/members', { email: 'ngozi@aliwa.org', fullName: 'Ngozi Eze', role: 'trainer' })).body.member as { id: string }).id
    await req('POST', `/v1/invitations/${t.mail.lastToken('ngozi@aliwa.org')}/accept`, { body: { password: 'a-strong-password' } })
    ids.programme = ((await post('/v1/programmes', { name: 'Data & AI' })).body.programme as { id: string }).id
    ids.course = ((await post('/v1/courses', { programmeId: ids.programme, name: 'Python', defaultLeadMemberId: ids.ngozi })).body.course as { id: string }).id
    ids.cohort = ((await post('/v1/cohorts', { programmeId: ids.programme, name: 'Cohort 5', startsOn: day(-20), endsOn: day(60), deliveryMode: 'online', courseIds: [ids.course] })).body
      .cohort as { id: string }).id
    const [cc] = await sql<{ id: string }[]>`select id from cohort_courses where cohort_id = ${ids.cohort!}`
    ids.cc = cc!.id
    for (const [key, name] of [['amara', 'Amara Okafor'], ['chidi', 'Chidi Nwosu']] as const) {
      ids[key] = ((await post('/v1/participants', { fullName: name, email: `${key}@example.com`, cohortId: ids.cohort })).body.participant as { id: string }).id
    }
    // A held session with marks, one this week and an upcoming one.
    const [held] = await sql<{ id: string }[]>`
      insert into sessions (organisation_id, cohort_course_id, title, starts_at, ends_at, trainer_member_id)
      select organisation_id, id, 'Python', now() - interval '30 minutes', now() - interval '5 minutes', ${ids.ngozi!} from cohort_courses where id = ${ids.cc!} returning id`
    ids.held = held!.id
    await sql`insert into sessions (organisation_id, cohort_course_id, title, starts_at, ends_at, trainer_member_id, mode, location)
              select organisation_id, id, 'Python', now() + interval '50 days', now() + interval '50 days 2 hours', ${ids.ngozi!}, 'in_person', 'Lab 2' from cohort_courses where id = ${ids.cc!}`
    await sql`insert into attendance_records (organisation_id, session_id, member_id, status, source)
              select organisation_id, ${ids.held!}, ${ids.amara!}, 'absent', 'manual' from sessions where id = ${ids.held!}`
    await sql`insert into attendance_records (organisation_id, session_id, member_id, status, source)
              select organisation_id, ${ids.held!}, ${ids.chidi!}, 'present', 'manual' from sessions where id = ${ids.held!}`
    // Two assignments due, one due this week; Chidi handed in the first.
    const assignment = async (title: string, dueOffsetHours: number) =>
      (
        await sql<{ id: string }[]>`
          insert into assignments (organisation_id, cohort_course_id, title, due_at, grading_scale, max_points, published_at)
          select organisation_id, id, ${title}, now() + make_interval(hours => ${dueOffsetHours}), 'points', 10, now() - interval '5 days' from cohort_courses where id = ${ids.cc!} returning id`
      )[0]!.id
    ids.a1 = await assignment('Exercises 1', -48)
    ids.a2 = await assignment('Exercises 2', -24)
    await assignment('Project', 72)
    await sql`insert into submissions (organisation_id, assignment_id, member_id) select organisation_id, ${ids.a1!}, ${ids.chidi!} from assignments where id = ${ids.a1!}`
    await sql`insert into attention_flags (organisation_id, enrolment_id, rule, details)
              select organisation_id, id, 'overdue_assignments', '{"count": 2}' from enrolments where member_id = ${ids.amara!}`
  })

  afterAll(async () => {
    await drop?.()
  })

  it('counts flagged participants per programme and cohort, with the next session', async () => {
    const [p] = (await get('/v1/programmes')).body.programmes as { needsAttention: number }[]
    expect(p!.needsAttention).toBe(1)
    const [c] = (await get('/v1/cohorts')).body.cohorts as { needsAttention: number; nextSession: { mode: string; location: string } | null }[]
    expect(c).toMatchObject({ needsAttention: 1, nextSession: { mode: 'in_person', location: 'Lab 2' } })
  })

  it('shows each participant’s assignments and open flags (B1.01)', async () => {
    const list = (await get('/v1/participants')).body.participants as { firstName: string; enrolment: { assignments: unknown; flags: number } }[]
    const by = Object.fromEntries(list.map((p) => [p.firstName, p.enrolment]))
    expect(by.Amara).toMatchObject({ assignments: { due: 2, submitted: 0, overdue: 2, dueThisWeek: 1 }, flags: 1 })
    expect(by.Chidi).toMatchObject({ assignments: { due: 2, submitted: 1, overdue: 1, dueThisWeek: 1 }, flags: 0 })
  })

  it('returns a participant’s sessions and work for the detail tabs (B1.04)', async () => {
    const res = await get(`/v1/participants/${ids.amara}/learning`)
    expect(res.body).toMatchObject({ cohortId: ids.cohort, attendance: { present: 0, recorded: 1 } })
    expect((res.body.sessions as { mark: string }[]).map((s) => s.mark)).toEqual(['absent'])
    expect((res.body.assignments as { title: string; status: string }[]).map((a) => [a.title, a.status])).toEqual([
      ['Project', 'not_submitted'],
      ['Exercises 2', 'overdue'],
      ['Exercises 1', 'overdue'],
    ])
  })

  it('counts assignments per course and each trainer’s sessions and reports in a cohort (A3.05)', async () => {
    const res = await get(`/v1/cohorts/${ids.cohort}`)
    expect((res.body.courses as { assignments: number }[])[0]!.assignments).toBe(3)
    expect(res.body.trainerStats).toEqual({ [ids.ngozi!]: { held: 1, reports: 0 } })
  })

  it('counts sessions a trainer leads this week (B2.01)', async () => {
    const [m] = (await get('/v1/members?role=trainer')).body.members as { sessionsThisWeek: number; teaching: { cohorts: unknown[] } }[]
    expect(m!.sessionsThisWeek).toBe(1)
    expect(m!.teaching.cohorts).toHaveLength(1)
  })
})
