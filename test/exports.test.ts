import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/lib/db.js'
import { addDays } from '../src/lib/schedule.js'
import { createTestDatabase, TEST_DATABASE_URL } from './helpers/db.js'
import { as, client, testApp } from './helpers/app.js'

const day = (offset: number) => addDays(new Date().toISOString().slice(0, 10), offset)

type Report = { id: string; title: string; subtitle: string; status: string; format: string; by: { name: string } | null }

describe.skipIf(!TEST_DATABASE_URL)('reports (E1)', () => {
  let sql: Sql
  let drop: () => Promise<void>
  let app: ReturnType<typeof testApp>['app']
  let req: ReturnType<typeof client>
  const admin = { id: randomUUID(), email: 'ada@aliwa.org' }
  let token: string
  let trainerToken: string
  const ids: Record<string, string> = {}
  const post = (path: string, body: unknown, t = token) => req('POST', path, { token: t, body })
  const get = (path: string, t = token) => req('GET', path, { token: t })
  const file = (id: string) => app.request(`/v1/reports/${id}/file`, { headers: { Authorization: `Bearer ${token}` } })

  beforeAll(async () => {
    ;({ sql, drop } = await createTestDatabase())
    app = testApp(sql).app
    req = client(app)
    await sql`insert into auth.users (id, email) values (${admin.id}, ${admin.email})`
    token = as(admin.id, admin.email)
    await post('/v1/organisations', { organisationName: 'ALIWA Foundation', fullName: 'Ada Obi' })
    const t = (await post('/v1/members', { email: 'ngozi@aliwa.org', firstName: 'Ngozi', lastName: 'Eze', role: 'trainer' })).body.member as { id: string }
    const tUser = randomUUID()
    await sql`insert into auth.users (id, email) values (${tUser}, 'ngozi@aliwa.org')`
    await sql`update organisation_members set user_id = ${tUser}, status = 'active' where id = ${t.id}`
    trainerToken = as(tUser, 'ngozi@aliwa.org')
    ids.programme = ((await post('/v1/programmes', { name: 'Data & AI' })).body.programme as { id: string }).id
    const courseId = ((await post('/v1/courses', { programmeId: ids.programme, name: 'Python', defaultLeadMemberId: t.id })).body.course as { id: string }).id
    ids.cohort = ((await post('/v1/cohorts', { programmeId: ids.programme, name: 'Cohort 5', startsOn: day(-20), endsOn: day(60), deliveryMode: 'online', courseIds: [courseId] })).body.cohort as { id: string }).id
    const people: string[] = []
    for (const n of ['Amara Okafor', 'Bayo, "BJ" Ade']) people.push(((await post('/v1/participants', { fullName: n, email: `${n.split(' ')[0]!.replace(',', '')}@example.com`, cohortId: ids.cohort })).body.participant as { id: string }).id)
    const [s] = await sql<{ id: string }[]>`
      insert into sessions (organisation_id, cohort_course_id, title, starts_at, ends_at, trainer_member_id)
      select organisation_id, id, 'x', now() - interval '50 hours', now() - interval '48 hours', ${t.id} from cohort_courses where cohort_id = ${ids.cohort} returning id
    `
    await req('PUT', `/v1/sessions/${s!.id}/attendance`, { token, body: { marks: [{ memberId: people[0], status: 'present' }, { memberId: people[1], status: 'absent' }] } })
    await sql`insert into session_feedback (organisation_id, session_id, member_id, rating) select organisation_id, ${s!.id}, ${people[0]!}, 4 from sessions where id = ${s!.id}`
  })

  afterAll(async () => {
    await drop?.()
  })

  it('checks what was asked for (E1.02)', async () => {
    const res = await post('/v1/reports', { kind: 'attendance', programmeId: ids.programme, format: 'csv', from: day(0), to: day(-3) })
    expect(res.body.error!.details).toEqual([
      { field: 'cohortId', message: 'Choose a cohort.' },
      { field: 'to', message: 'Choose a date on or after the start.' },
    ])
    expect((await post('/v1/reports', { kind: 'feedback', programmeId: randomUUID(), format: 'pdf' })).status).toBe(400)
    expect((await post('/v1/reports', { kind: 'feedback', programmeId: ids.programme, format: 'pdf' }, trainerToken)).status).toBe(403)
  })

  it('generates a CSV of attendance (E1.03, E1.04)', async () => {
    const res = await post('/v1/reports', { kind: 'attendance', programmeId: ids.programme, cohortId: ids.cohort, from: day(-7), to: day(0), format: 'csv' })
    expect(res.status).toBe(202)
    const list = (await get('/v1/reports')).body.reports as Report[]
    expect(list[0]).toMatchObject({ title: 'Attendance — Cohort 5', status: 'ready', format: 'csv', by: { name: 'Ada O.' } })
    const download = await file((res.body.report as { id: string }).id)
    expect(download.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(download.headers.get('content-disposition')).toContain('Attendance - Cohort 5.csv')
    const text = await download.text()
    expect(text).toContain('Date,Time,Course,Trainer,Present,Excused,Absent,Not recorded,Attendance')
    expect(text).toMatch(/Python,Ngozi Eze,1,0,1,0,50%/)
  })

  it('generates PDF summaries, assignments and feedback', async () => {
    for (const kind of ['cohort_summary', 'programme_summary', 'assignments', 'feedback']) {
      const res = await post('/v1/reports', { kind, programmeId: ids.programme, cohortId: kind === 'programme_summary' || kind === 'feedback' ? null : ids.cohort, format: 'pdf' })
      expect(res.status).toBe(202)
      const download = await file((res.body.report as { id: string }).id)
      expect(download.headers.get('content-type')).toBe('application/pdf')
      const bytes = Buffer.from(await download.arrayBuffer())
      expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
    }
    const list = (await get('/v1/reports')).body.reports as Report[]
    expect(list.map((r) => r.title)).toEqual(['Feedback — Data & AI', 'Assignments and grades — Cohort 5', 'Programme summary — Data & AI', 'Cohort summary — Cohort 5', 'Attendance — Cohort 5'])
    expect(list[0]!.subtitle).toBe('Programme to date')
  })

  it('marks a report failed and tries again (E1.05)', async () => {
    const res = await post('/v1/reports', { kind: 'cohort_summary', programmeId: ids.programme, cohortId: ids.cohort, format: 'pdf' })
    const id = (res.body.report as { id: string }).id
    await sql`update generated_reports set status = 'failed', error = 'boom', content = null where id = ${id}`
    expect((await file(id)).status).toBe(409)
    const retry = await post(`/v1/reports/${id}/retry`, {})
    expect(retry.status).toBe(202)
    const list = (await get('/v1/reports')).body.reports as Report[]
    expect(list.find((r) => r.id === id)).toBeUndefined()
    expect(list.find((r) => r.id === (retry.body.report as { id: string }).id)).toMatchObject({ status: 'ready' })
  })
})
