import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/lib/db.js'
import { addDays } from '../src/lib/schedule.js'
import { createTestDatabase, TEST_DATABASE_URL } from './helpers/db.js'
import { as, client, testApp } from './helpers/app.js'

const day = (offset: number) => addDays(new Date().toISOString().slice(0, 10), offset)

type Row = { participant: { id: string; name: string }; flags: { rule: string; details: Record<string, unknown> }[]; lastIntervention: { outcome: string; by: string } | null }

describe.skipIf(!TEST_DATABASE_URL)('needs attention (D1, T7)', () => {
  let sql: Sql
  let drop: () => Promise<void>
  let req: ReturnType<typeof client>
  const admin = { id: randomUUID(), email: 'ada@aliwa.org' }
  let adminToken: string
  let trainerToken: string
  let participantToken: string
  const people: Record<string, string> = {}
  let cc: string
  let hoursAgo = 400

  const post = (path: string, body: unknown, token = adminToken) => req('POST', path, { token, body })
  const get = (path: string, token = adminToken) => req('GET', path, { token })
  const list = async (token = adminToken) => (await get('/v1/attention', token)).body.participants as Row[]
  const rulesOf = (rows: Row[], key: string) => rows.find((r) => r.participant.id === people[key])?.flags.map((f) => f.rule).sort() ?? []

  /** A held session with marks for some people. */
  async function held(marks: Record<string, 'present' | 'absent' | 'excused'>) {
    hoursAgo -= 24
    const [s] = await sql<{ id: string }[]>`
      insert into sessions (organisation_id, cohort_course_id, title, starts_at, ends_at)
      select organisation_id, id, 'x', now() - ${hoursAgo} * interval '1 hour', now() - ${hoursAgo - 2} * interval '1 hour'
      from cohort_courses where id = ${cc} returning id
    `
    await req('PUT', `/v1/sessions/${s!.id}/attendance`, {
      token: adminToken,
      body: { marks: Object.entries(marks).map(([k, status]) => ({ memberId: people[k], status })) },
    })
  }

  beforeAll(async () => {
    ;({ sql, drop } = await createTestDatabase())
    req = client(testApp(sql).app)
    await sql`insert into auth.users (id, email) values (${admin.id}, ${admin.email})`
    adminToken = as(admin.id, admin.email)
    await post('/v1/organisations', { organisationName: 'ALIWA Foundation', fullName: 'Ada Obi' })
    const trainer = (await post('/v1/members', { email: 'ngozi@aliwa.org', firstName: 'Ngozi', lastName: 'Eze', role: 'trainer' })).body.member as { id: string }
    const tUser = randomUUID()
    await sql`insert into auth.users (id, email) values (${tUser}, 'ngozi@aliwa.org')`
    await sql`update organisation_members set user_id = ${tUser}, status = 'active' where id = ${trainer.id}`
    trainerToken = as(tUser, 'ngozi@aliwa.org')
    const programmeId = ((await post('/v1/programmes', { name: 'Data & AI' })).body.programme as { id: string }).id
    const courseId = ((await post('/v1/courses', { programmeId, name: 'Python', defaultLeadMemberId: trainer.id })).body.course as { id: string }).id
    const other = ((await post('/v1/courses', { programmeId, name: 'Design' })).body.course as { id: string }).id
    const cohort = ((await post('/v1/cohorts', { programmeId, name: 'Cohort 5', startsOn: day(-30), endsOn: day(60), deliveryMode: 'online', courseIds: [courseId] })).body.cohort as { id: string }).id
    const cohort6 = ((await post('/v1/cohorts', { programmeId, name: 'Cohort 6', startsOn: day(-30), endsOn: day(60), deliveryMode: 'online', courseIds: [other] })).body.cohort as { id: string }).id
    for (const [key, n, c] of [['amara', 'Amara Okafor', cohort], ['bolaji', 'Bolaji Ade', cohort], ['chidi', 'Chidi Nwosu', cohort], ['kemi', 'Kemi Bello', cohort6]] as const) {
      people[key] = ((await post('/v1/participants', { fullName: n, email: `${key}@example.com`, cohortId: c })).body.participant as { id: string }).id
    }
    const pUser = randomUUID()
    await sql`insert into auth.users (id, email, last_sign_in_at) values (${pUser}, 'chidi@example.com', now())`
    await sql`update organisation_members set user_id = ${pUser}, status = 'active' where id = ${people.chidi!}`
    participantToken = as(pUser, 'chidi@example.com')
    cc = (await sql<{ id: string }[]>`select id from cohort_courses where cohort_id = ${cohort}`)[0]!.id

    // Amara misses the last two; Bolaji and Chidi attend. Kemi hasn't been active for 20 days.
    await held({ amara: 'present', bolaji: 'present', chidi: 'present' })
    await held({ amara: 'absent', bolaji: 'present', chidi: 'present' })
    await held({ amara: 'absent', bolaji: 'present', chidi: 'present' })
    await sql`update enrolments set enrolled_at = now() - interval '20 days' where member_id = ${people.kemi!}`
    // Bolaji has overdue work; Chidi handed in and got a low grade.
    const [a] = await sql<{ id: string; organisation_id: string }[]>`
      insert into assignments (organisation_id, cohort_course_id, title, due_at, grading_scale, published_at)
      select organisation_id, id, 'Python Exercises 1', now() - interval '1 day', 'percentage', now() - interval '5 days' from cohort_courses where id = ${cc}
      returning id, organisation_id
    `
    for (const k of ['amara', 'chidi'] as const) {
      const [s] = await sql<{ id: string }[]>`insert into submissions (organisation_id, assignment_id, member_id, text_body) values (${a!.organisation_id}, ${a!.id}, ${people[k]!}, 'x') returning id`
      if (k === 'chidi') await sql`insert into grades (organisation_id, submission_id, percentage, score_pct) values (${a!.organisation_id}, ${s!.id}, 30, 30)`
    }
  })

  afterAll(async () => {
    await drop?.()
  })

  it('flags people from the rules (D1.01)', async () => {
    const rows = await list()
    expect(rulesOf(rows, 'amara')).toEqual(['low_attendance', 'missed_in_row'])
    expect(rulesOf(rows, 'bolaji')).toEqual(['overdue_assignments'])
    expect(rulesOf(rows, 'chidi')).toEqual(['low_grade'])
    expect(rulesOf(rows, 'kemi')).toEqual(['inactive'])
    const amara = rows.find((r) => r.participant.id === people.amara)!
    expect(amara.flags.find((f) => f.rule === 'missed_in_row')!.details).toMatchObject({ missed: 2 })
    expect(amara.flags.find((f) => f.rule === 'low_attendance')!.details).toMatchObject({ attendancePct: 33, present: 1, recorded: 3 })
    expect(rows.find((r) => r.participant.id === people.bolaji)!.flags[0]!.details).toMatchObject({ count: 1, titles: ['Python Exercises 1'] })
    expect((await get('/v1/attention/count')).body.count).toBe(4)
    // Checking again doesn't duplicate flags.
    expect((await list()).flatMap((r) => r.flags).length).toBe(5)
  })

  it('shows trainers only their cohorts, and not to participants', async () => {
    const rows = await list(trainerToken)
    expect(rows.map((r) => r.participant.name).sort()).toEqual(['Amara Okafor', 'Bolaji Ade', 'Chidi Nwosu'])
    expect((await get(`/v1/attention/participants/${people.kemi}`, trainerToken)).status).toBe(404)
    expect((await get('/v1/attention', participantToken)).status).toBe(403)
  })

  it('records interventions and lists them (D1.03, T7.03, D1.04)', async () => {
    const future = await post(`/v1/attention/participants/${people.amara}/interventions`, { method: 'call', date: day(2), time: '10:00', notes: 'x', outcome: 'reached' }, trainerToken)
    expect(future.body.error!.details).toEqual([{ field: 'date', message: 'Choose a time that has already happened.' }])
    const empty = await post(`/v1/attention/participants/${people.amara}/interventions`, { method: 'call', date: day(0), time: '00:00', notes: ' ', outcome: 'reached' }, trainerToken)
    expect(empty.status).toBe(400)
    const ok = await post(`/v1/attention/participants/${people.amara}/interventions`, {
      method: 'call', date: day(-1), time: '11:20', notes: 'Transport costs; joining online for two weeks.', outcome: 'reached', reviewOn: day(5),
    }, trainerToken)
    expect(ok.status).toBe(201)
    const row = (await list()).find((r) => r.participant.id === people.amara)!
    expect(row.lastIntervention).toMatchObject({ outcome: 'reached', by: 'Ngozi Eze' })
    const detail = await get(`/v1/attention/participants/${people.amara}`)
    expect(detail.body).toMatchObject({ canResolve: true, nextReview: day(5), interventions: [{ method: 'call', by: { name: 'Ngozi Eze', trainer: true } }] })
    const log = await get('/v1/attention/interventions')
    expect(log.body.interventions).toEqual([expect.objectContaining({ participant: { id: people.amara, name: 'Amara Okafor' }, outcome: 'reached', reviewOn: day(5) })])
  })

  it('lets admins resolve; a resolved flag only comes back after the rule stops matching (D1.02)', async () => {
    expect((await post(`/v1/attention/participants/${people.amara}/resolve`, { note: 'Sorted' }, trainerToken)).status).toBe(403)
    expect((await post(`/v1/attention/participants/${people.amara}/resolve`, { note: ' ' })).status).toBe(400)
    expect((await post(`/v1/attention/participants/${people.amara}/resolve`, { note: 'Transport sorted; joining online.' })).body).toEqual({ resolved: 2 })
    expect(rulesOf(await list(), 'amara')).toEqual([])
    expect((await post(`/v1/attention/participants/${people.amara}/resolve`, { note: 'Again' })).body.error!.code).toBe('nothing_to_resolve')

    // She attends, so "missed in a row" stops matching; then misses two more and a new flag opens.
    await held({ amara: 'present', bolaji: 'present', chidi: 'present' })
    expect(rulesOf(await list(), 'amara')).toEqual([])
    await held({ amara: 'absent', bolaji: 'present', chidi: 'present' })
    await held({ amara: 'absent', bolaji: 'present', chidi: 'present' })
    expect(rulesOf(await list(), 'amara')).toEqual(['missed_in_row'])
  })

  it('clears flags by itself when the rule stops matching', async () => {
    const [a] = await sql<{ id: string; organisation_id: string }[]>`select id, organisation_id from assignments limit 1`
    await sql`insert into submissions (organisation_id, assignment_id, member_id, text_body, is_late) values (${a!.organisation_id}, ${a!.id}, ${people.bolaji!}, 'late', true)`
    expect(rulesOf(await list(), 'bolaji')).toEqual([])
  })

  it('lists the trainer’s participants with their own-course figures (T7.01, T7.02)', async () => {
    const res = await get('/v1/trainer/participants', trainerToken)
    const rows = res.body.participants as { id: string; name: string; attendance: { rate: number } | null; work: { submitted: number; published: number }; flag: string | null }[]
    expect(rows.map((r) => r.name).sort()).toEqual(['Amara Okafor', 'Bolaji Ade', 'Chidi Nwosu'])
    expect(rows.find((r) => r.id === people.amara)).toMatchObject({ flag: 'missed_in_row', work: { submitted: 1, published: 1 } })
    expect(rows.find((r) => r.id === people.chidi)).toMatchObject({ attendance: { rate: 100 }, flag: 'low_grade' })
    const detail = await get(`/v1/trainer/participants/${people.chidi}`, trainerToken)
    expect(detail.body).toMatchObject({ participant: { name: 'Chidi Nwosu' }, courses: ['Python'], trainers: ['Ngozi Eze'], assignments: [{ title: 'Python Exercises 1', status: 'graded', grade: '30%' }] })
    expect((await get(`/v1/trainer/participants/${people.kemi}`, trainerToken)).status).toBe(404)
    expect((await get('/v1/trainer/participants')).status).toBe(403)
  })
})
