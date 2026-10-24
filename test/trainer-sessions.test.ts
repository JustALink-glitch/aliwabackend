import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/lib/db.js'
import { addDays } from '../src/lib/schedule.js'
import { createTestDatabase, TEST_DATABASE_URL } from './helpers/db.js'
import { as, client, testApp } from './helpers/app.js'

const day = (offset: number) => addDays(new Date().toISOString().slice(0, 10), offset)

type Session = { id: string; course: { name: string }; status: string }

describe.skipIf(!TEST_DATABASE_URL)('trainer sessions, register, resources and cohorts (T3, T4, T8)', () => {
  let sql: Sql
  let drop: () => Promise<void>
  let req: ReturnType<typeof client>
  let files: ReturnType<typeof testApp>['files']
  const admin = { id: randomUUID(), email: 'ada@aliwa.org' }
  let adminToken: string
  let ngozi: string
  let assistant: string
  let tunde: string
  let participant: string
  const ids: Record<string, string> = {}

  const post = (path: string, body: unknown, token = adminToken) => req('POST', path, { token, body })
  const get = (path: string, token = adminToken) => req('GET', path, { token })

  async function member(email: string, firstName: string, lastName: string, role: string) {
    const m = (await post('/v1/members', { email, firstName, lastName, role })).body.member as { id: string }
    const user = randomUUID()
    await sql`insert into auth.users (id, email) values (${user}, ${email})`
    await sql`update organisation_members set user_id = ${user}, status = 'active' where id = ${m.id}`
    return { id: m.id, token: as(user, email) }
  }

  async function held(cc: string, hoursAgo: number) {
    const [s] = await sql<{ id: string }[]>`
      insert into sessions (organisation_id, cohort_course_id, title, starts_at, ends_at)
      select organisation_id, id, 'x', now() - ${hoursAgo} * interval '1 hour', now() - ${hoursAgo - 2} * interval '1 hour'
      from cohort_courses where id = ${cc} returning id
    `
    return s!.id
  }

  beforeAll(async () => {
    ;({ sql, drop } = await createTestDatabase())
    const t = testApp(sql)
    req = client(t.app)
    files = t.files
    await sql`insert into auth.users (id, email) values (${admin.id}, ${admin.email})`
    adminToken = as(admin.id, admin.email)
    await post('/v1/organisations', { organisationName: 'ALIWA Foundation', fullName: 'Ada Obi' })
    const n = await member('ngozi@aliwa.org', 'Ngozi', 'Eze', 'trainer')
    const a = await member('sade@aliwa.org', 'Sade', 'Bakare', 'assistant_trainer')
    const tu = await member('tunde@aliwa.org', 'Tunde', 'Adeyemi', 'trainer')
    ngozi = n.token
    assistant = a.token
    tunde = tu.token
    ids.ngozi = n.id
    ids.sade = a.id
    const programmeId = ((await post('/v1/programmes', { name: 'Data & AI' })).body.programme as { id: string }).id
    ids.python = ((await post('/v1/courses', { programmeId, name: 'Python', defaultLeadMemberId: n.id })).body.course as { id: string }).id
    ids.sql = ((await post('/v1/courses', { programmeId, name: 'SQL', defaultLeadMemberId: tu.id })).body.course as { id: string }).id
    ids.cohort = ((await post('/v1/cohorts', { programmeId, name: 'Cohort 5', startsOn: day(-20), endsOn: day(60), deliveryMode: 'online', courseIds: [ids.python, ids.sql] })).body.cohort as { id: string }).id
    ids.other = ((await post('/v1/cohorts', { programmeId, name: 'Cohort 6', startsOn: day(-20), endsOn: day(60), deliveryMode: 'online', courseIds: [ids.sql] })).body.cohort as { id: string }).id
    const ccs = await sql<{ id: string; name: string }[]>`select x.id, c.name from cohort_courses x join courses c on c.id = x.course_id where x.cohort_id = ${ids.cohort}`
    ids.ccPython = ccs.find((x) => x.name === 'Python')!.id
    ids.ccSql = ccs.find((x) => x.name === 'SQL')!.id
    await sql`insert into cohort_course_trainers (organisation_id, cohort_course_id, member_id) select organisation_id, id, ${a.id} from cohort_courses where id = ${ids.ccPython}`
    ids.amara = ((await post('/v1/participants', { fullName: 'Amara Okafor', email: 'amara@example.com', cohortId: ids.cohort })).body.participant as { id: string }).id
    const pUser = randomUUID()
    await sql`insert into auth.users (id, email) values (${pUser}, 'amara@example.com')`
    await sql`update organisation_members set user_id = ${pUser}, status = 'active' where id = ${ids.amara}`
    participant = as(pUser, 'amara@example.com')
    ids.heldPython = await held(ids.ccPython, 30)
    ids.heldSql = await held(ids.ccSql, 50)
  })

  afterAll(async () => {
    await drop?.()
  })

  it('lets a lead trainer schedule only in their own courses (T3.03)', async () => {
    const options = (await get('/v1/sessions/options', ngozi)).body.cohorts as { name: string; courses: { name: string; trainers: unknown[] }[] }[]
    expect(options.map((c) => [c.name, c.courses.map((x) => x.name)])).toEqual([['Cohort 5', ['Python']]])
    expect((await get('/v1/sessions/options', assistant)).body.cohorts).toEqual([])
    const sqlCourse = await post('/v1/sessions', { cohortId: ids.cohort, courseId: ids.sql, date: day(2), start: '10:00', end: '12:00', mode: 'online' }, ngozi)
    expect(sqlCourse.body.error!.details).toEqual([{ field: 'courseId', message: 'Choose a course you lead in this cohort.' }])
    const ok = await post('/v1/sessions', { cohortId: ids.cohort, courseId: ids.python, trainerMemberId: ids.ngozi, date: day(2), start: '10:00', end: '12:00', mode: 'online', repeat: { weekdays: [1, 3], count: 4 } }, ngozi)
    expect(ok.status).toBe(201)
    expect(ok.body.created).toBe(4)
    ids.upcoming = ok.body.firstSessionId as string
    expect((await post('/v1/sessions', { cohortId: ids.cohort, courseId: ids.python, date: day(3), start: '10:00', end: '12:00', mode: 'online' }, assistant)).status).toBe(400)
  })

  it('shows trainers only their own courses’ sessions, with what they can do (T3.01, T3.02)', async () => {
    const list = (await get('/v1/sessions', ngozi)).body.sessions as Session[]
    expect(new Set(list.map((s) => s.course.name))).toEqual(new Set(['Python']))
    expect((await get(`/v1/sessions/${ids.heldSql}`, ngozi)).status).toBe(404)
    const detail = await get(`/v1/sessions/${ids.upcoming}`, ngozi)
    expect(detail.body.can).toEqual({ schedule: true, attendance: true, resources: true, report: true })
    expect((await get(`/v1/sessions/${ids.upcoming}`, assistant)).body.can).toEqual({ schedule: false, attendance: true, resources: true, report: false })
    expect((await get(`/v1/sessions/${ids.upcoming}`)).body.can).toEqual({ schedule: true, attendance: true, resources: true, report: false })
    expect((await get('/v1/sessions', participant)).status).toBe(403)
  })

  it('lets lead trainers edit and cancel their sessions, not assistants (T3.06, T3.07)', async () => {
    const edit = { scope: 'this', date: day(2), start: '11:00', end: '13:00', mode: 'online', trainerMemberId: ids.ngozi }
    expect((await req('PATCH', `/v1/sessions/${ids.upcoming}`, { token: assistant, body: edit })).status).toBe(403)
    expect((await req('PATCH', `/v1/sessions/${ids.upcoming}`, { token: ngozi, body: edit })).body).toMatchObject({ updated: 1 })
    expect((await post(`/v1/sessions/${ids.upcoming}/cancel`, { reason: 'Public holiday', notify: false }, assistant)).status).toBe(403)
    expect((await post(`/v1/sessions/${ids.upcoming}/cancel`, { reason: 'Public holiday', notify: false }, ngozi)).body).toMatchObject({ cancelled: true })
    expect((await post(`/v1/sessions/${ids.heldSql}/cancel`, { reason: 'x' }, ngozi)).status).toBe(404)
  })

  it('lets the course’s trainers take the register; assistants only if allowed (T4.01–T4.03)', async () => {
    const marks = { marks: [{ memberId: ids.amara, status: 'present' }] }
    expect((await req('GET', `/v1/sessions/${ids.heldPython}/attendance`, { token: ngozi })).body.expected).toBe(1)
    expect((await req('PUT', `/v1/sessions/${ids.heldSql}/attendance`, { token: ngozi, body: marks })).status).toBe(404)
    await sql`update organisation_settings set assistant_can_take_attendance = false`
    expect((await req('PUT', `/v1/sessions/${ids.heldPython}/attendance`, { token: assistant, body: marks })).status).toBe(403)
    expect((await req('PUT', `/v1/sessions/${ids.heldPython}/attendance`, { token: ngozi, body: marks })).status).toBe(200)
    const edit = await req('PATCH', `/v1/sessions/${ids.heldPython}/attendance/${ids.amara}`, { token: ngozi, body: { status: 'excused', reason: 'Clinic appointment' } })
    expect(edit.status).toBe(200)
    await sql`update organisation_settings set assistant_can_take_attendance = true`
  })

  it('adds links and files to a session, visible or kept from participants (T8.01)', async () => {
    const bad = await post(`/v1/sessions/${ids.heldPython}/resources`, { kind: 'link', name: 'Docs', url: 'pandas.org' }, ngozi)
    expect(bad.body.error!.details).toEqual([{ field: 'url', message: 'Paste the full link, starting with https://' }])
    expect((await post(`/v1/sessions/${ids.heldPython}/resources`, { kind: 'link', name: 'pandas documentation', url: 'https://pandas.pydata.org', scope: 'course' }, ngozi)).status).toBe(201)
    const upload = await post(`/v1/sessions/${ids.heldPython}/resources/uploads`, { name: 'Week 3 slides.pdf', size: 1800, type: 'application/pdf' }, assistant)
    const path = (upload.body.upload as { path: string }).path
    expect((await post(`/v1/sessions/${ids.heldPython}/resources`, { kind: 'file', name: 'Week 3 slides', path }, assistant)).body.error!.details).toEqual([
      { field: 'path', message: 'The file didn’t finish uploading. Choose it again.' },
    ])
    files.put(path, 1800, 'application/pdf')
    expect((await post(`/v1/sessions/${ids.heldPython}/resources`, { kind: 'file', name: 'Week 3 slides', path, visible: false }, assistant)).status).toBe(201)
    const detail = await get(`/v1/sessions/${ids.heldPython}`, ngozi)
    const resources = detail.body.resources as { name: string; wholeCourse: boolean; visible: boolean; addedBy: string; size: number | null }[]
    expect(resources.map((r) => [r.name, r.wholeCourse, r.visible, r.addedBy, r.size])).toEqual([
      ['Week 3 slides', false, false, 'Sade Bakare', 1800],
      ['pandas documentation', true, true, 'you', null],
    ])
    const mine = await get(`/v1/my/sessions/${ids.heldPython}`, participant)
    expect((mine.body.resources as { name: string }[]).map((r) => r.name)).toEqual(['pandas documentation'])
    expect((await post(`/v1/sessions/${ids.heldSql}/resources`, { kind: 'link', name: 'x', url: 'https://x.org' }, ngozi)).status).toBe(404)
  })

  it('lists my cohorts and opens one I teach in (T3.04, T3.05)', async () => {
    const list = await get('/v1/trainer/cohorts', ngozi)
    expect(list.body.cohorts).toEqual([
      expect.objectContaining({ name: 'Cohort 5', participants: 1, course: { name: 'Python', lead: true, held: 1, planned: null }, attendance: 0 }),
    ])
    const detail = await get(`/v1/trainer/cohorts/${ids.cohort}`, ngozi)
    expect(detail.body.cohort).toMatchObject({ name: 'Cohort 5' })
    expect((detail.body.courses as { name: string; mine: boolean }[]).map((c) => [c.name, c.mine])).toEqual([
      ['Python', true],
      ['SQL', false],
    ])
    expect((await get(`/v1/trainer/cohorts/${ids.other}`, ngozi)).status).toBe(404)
    expect((await get(`/v1/trainer/cohorts/${ids.other}`, tunde)).status).toBe(200)
  })
})
