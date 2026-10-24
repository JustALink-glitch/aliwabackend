import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/lib/db.js'
import { addDays } from '../src/lib/schedule.js'
import { createTestDatabase, TEST_DATABASE_URL } from './helpers/db.js'
import { as, client, testApp } from './helpers/app.js'

const day = (offset: number) => addDays(new Date().toISOString().slice(0, 10), offset)

describe.skipIf(!TEST_DATABASE_URL)('attendance (C2)', () => {
  let sql: Sql
  let drop: () => Promise<void>
  let req: ReturnType<typeof client>
  const owner = { id: randomUUID(), email: 'ada@aliwa.org' }
  const other = { id: randomUUID(), email: 'kofi@other.org' }
  let token: string
  let otherToken: string
  let programmeId: string
  let cohortId: string
  let heldId: string
  let futureId: string
  const people: Record<string, string> = {}

  const post = (path: string, body: unknown, t = token) => req('POST', path, { token: t, body })
  const register = async () => (await req('GET', `/v1/sessions/${heldId}/attendance`, { token })).body

  beforeAll(async () => {
    ;({ sql, drop } = await createTestDatabase())
    req = client(testApp(sql).app)
    await sql`insert into auth.users (id, email) values (${owner.id}, ${owner.email}), (${other.id}, ${other.email})`
    token = as(owner.id, owner.email)
    otherToken = as(other.id, other.email)
    await post('/v1/organisations', { organisationName: 'ALIWA Foundation', fullName: 'Ada Obi' })
    await post('/v1/organisations', { organisationName: 'Other', fullName: 'Kofi Mensah' }, otherToken)
    programmeId = ((await post('/v1/programmes', { name: 'Data & AI' })).body.programme as { id: string }).id
    const courseId = ((await post('/v1/courses', { programmeId, name: 'Python', plannedSessions: 10 })).body.course as { id: string }).id
    cohortId = ((await post('/v1/cohorts', { programmeId, name: 'Cohort 5', startsOn: day(-30), endsOn: day(60), deliveryMode: 'online', courseIds: [courseId] })).body.cohort as { id: string }).id
    for (const [key, name] of [['amara', 'Amara Okafor'], ['bolaji', 'Bolaji Adeyemi'], ['chidi', 'Chidi Nwosu']] as const) {
      people[key] = ((await post('/v1/participants', { fullName: name, email: `${key}@example.com`, cohortId })).body.participant as { id: string }).id
    }
    const [cc] = await sql<{ id: string }[]>`select id from cohort_courses where cohort_id = ${cohortId}`
    const [held] = await sql<{ id: string }[]>`
      insert into sessions (organisation_id, cohort_course_id, title, starts_at, ends_at)
      select organisation_id, id, 'Python', now() - interval '3 days', now() - interval '3 days' + interval '2 hours'
      from cohort_courses where id = ${cc!.id} returning id
    `
    heldId = held!.id
    futureId = ((await post('/v1/sessions', { cohortId, courseId, date: day(2), start: '10:00', end: '12:00', mode: 'online' })).body.firstSessionId as string)
  })

  afterAll(async () => {
    await drop?.()
  })

  it('lists everyone expected, nothing recorded yet', async () => {
    const body = await register()
    expect(body).toMatchObject({ status: 'held', expected: 3, rate: null, counts: { present: 0, notRecorded: 3 } })
    expect((body.register as { name: string; status: null }[]).map((r) => [r.name, r.status])).toEqual([
      ['Amara Okafor', null],
      ['Bolaji Adeyemi', null],
      ['Chidi Nwosu', null],
    ])
  })

  it("doesn't open before the session starts", async () => {
    const res = await req('PUT', `/v1/sessions/${futureId}/attendance`, { token, body: { marks: [{ memberId: people.amara, status: 'present' }] } })
    expect(res.status).toBe(409)
    expect(res.body.error!.code).toBe('session_not_started')
  })

  it('saves the register; unmarked people stay Not recorded (C2.03)', async () => {
    const res = await req('PUT', `/v1/sessions/${heldId}/attendance`, {
      token,
      body: { marks: [{ memberId: people.amara, status: 'present' }, { memberId: people.bolaji, status: 'absent' }] },
    })
    expect(res.body).toEqual({ marked: 2 })
    const body = await register()
    expect(body).toMatchObject({ rate: 50, counts: { present: 1, absent: 1, notRecorded: 1 }, firstSaved: { by: 'Ada O.' } })
    expect((body.register as { source: string | null }[])[0]!.source).toBe('manual')
  })

  it('needs Edit, with a reason, to change a mark (C2.02)', async () => {
    const again = await req('PUT', `/v1/sessions/${heldId}/attendance`, { token, body: { marks: [{ memberId: people.amara, status: 'absent' }] } })
    expect(again.status).toBe(409)
    expect(again.body.error!.code).toBe('already_recorded')

    const noReason = await req('PATCH', `/v1/sessions/${heldId}/attendance/${people.bolaji}`, { token, body: { status: 'excused', reason: ' ' } })
    expect(noReason.status).toBe(400)
    const ok = await req('PATCH', `/v1/sessions/${heldId}/attendance/${people.bolaji}`, {
      token,
      body: { status: 'excused', reason: 'Told the trainer in advance', note: 'Family event' },
    })
    expect(ok.status).toBe(200)
    // Marking someone who wasn't marked also goes in the log.
    await req('PATCH', `/v1/sessions/${heldId}/attendance/${people.chidi}`, { token, body: { status: 'present', reason: 'Joined late on a shared device' } })

    const body = await register()
    expect(body).toMatchObject({ rate: 67, counts: { present: 2, excused: 1, notRecorded: 0 }, changes: { count: 2, lastBy: 'Ada O.' } })
    const bolaji = (body.register as { memberId: string; source: string; note: string }[]).find((r) => r.memberId === people.bolaji)!
    expect(bolaji).toMatchObject({ source: 'edited', note: 'Family event' })
  })

  it('keeps every change in the history, newest first (C2.05)', async () => {
    const res = await req('GET', `/v1/sessions/${heldId}/attendance/history`, { token })
    const entries = res.body.entries as { kind: string; participant?: string; from?: string | null; to?: string; reason?: string; marked?: number }[]
    expect(entries.map((e) => e.kind)).toEqual(['change', 'change', 'register'])
    expect(entries[1]).toMatchObject({ participant: 'Bolaji Adeyemi', from: 'absent', to: 'excused', reason: 'Told the trainer in advance' })
    expect(entries[0]).toMatchObject({ participant: 'Chidi Nwosu', from: null, to: 'present' })
    expect(entries[2]).toMatchObject({ marked: 2 })
  })

  it('feeds attendance % into cohorts, programmes and participants', async () => {
    const cohorts = await req('GET', '/v1/cohorts', { token })
    expect(cohorts.body.cohorts).toEqual([expect.objectContaining({ attendance4w: 67, attendanceAll: 67 })])
    const programmes = await req('GET', '/v1/programmes', { token })
    expect(programmes.body.programmes).toEqual([expect.objectContaining({ attendance4w: 67 })])
    const list = await req('GET', '/v1/participants', { token })
    const rates = Object.fromEntries(
      (list.body.participants as { id: string; enrolment: { attendance: { rate: number } | null } }[]).map((p) => [p.id, p.enrolment.attendance?.rate]),
    )
    expect(rates).toEqual({ [people.amara!]: 100, [people.bolaji!]: 0, [people.chidi!]: 100 })
    const detail = await req('GET', `/v1/participants/${people.bolaji}`, { token })
    expect((detail.body.enrolments as { attendance: unknown }[])[0]!.attendance).toEqual({ present: 0, recorded: 1, rate: 0 })
  })

  it('keeps withdrawn people who were marked, without expecting them', async () => {
    const detail = await req('GET', `/v1/participants/${people.bolaji}`, { token })
    const enrolmentId = (detail.body.enrolments as { id: string }[])[0]!.id
    await post(`/v1/participants/${people.bolaji}/enrolments/${enrolmentId}/withdraw`, { reason: 'Other', notify: false })
    const body = await register()
    expect(body.expected).toBe(2)
    expect((body.register as { memberId: string; stillEnrolled: boolean }[]).find((r) => r.memberId === people.bolaji)!.stillEnrolled).toBe(false)
  })

  it('is private to the organisation and closed for cancelled sessions', async () => {
    expect((await req('GET', `/v1/sessions/${heldId}/attendance`, { token: otherToken })).status).toBe(404)
    await post(`/v1/sessions/${futureId}/cancel`, { reason: 'Holiday', notify: false })
    const res = await req('PATCH', `/v1/sessions/${futureId}/attendance/${people.amara}`, { token, body: { status: 'present', reason: 'x' } })
    expect(res.body.error!.code).toBe('session_cancelled')
  })
})
