import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/lib/db.js'
import { addDays } from '../src/lib/schedule.js'
import { runScheduledJobs } from '../src/lib/scheduler.js'
import { createTestDatabase, TEST_DATABASE_URL } from './helpers/db.js'
import { as, client, testApp } from './helpers/app.js'

const day = (offset: number) => addDays(new Date().toISOString().slice(0, 10), offset)

describe.skipIf(!TEST_DATABASE_URL)('trainer settings, photos and welcome (T9.01–T9.02, T1.03–T1.04, P1.02–P1.03)', () => {
  let sql: Sql
  let drop: () => Promise<void>
  let t: ReturnType<typeof testApp>
  let req: ReturnType<typeof client>
  const owner = { id: randomUUID(), email: 'ada@aliwa.org' }
  let token: string
  const tokens: Record<string, string> = {}
  const ids: Record<string, string> = {}
  const post = (path: string, body: unknown) => req('POST', path, { token, body })

  async function join(email: string) {
    await req('POST', `/v1/invitations/${t.mail.lastToken(email)}/accept`, { body: { password: 'a-strong-password' } })
    const [u] = await sql<{ user_id: string }[]>`select user_id from organisation_members where email = ${email}`
    return as(u!.user_id, email)
  }

  beforeAll(async () => {
    ;({ sql, drop } = await createTestDatabase())
    t = testApp(sql)
    req = client(t.app)
    await sql`insert into auth.users (id, email) values (${owner.id}, ${owner.email})`
    token = as(owner.id, owner.email)
    await post('/v1/organisations', { organisationName: 'ALIWA Foundation', fullName: 'Ada Obi' })
    ids.ngozi = ((await post('/v1/members', { email: 'ngozi@aliwa.org', fullName: 'Ngozi Eze', role: 'trainer' })).body.member as { id: string }).id
    ids.ifeoma = ((await post('/v1/members', { email: 'ifeoma@aliwa.org', fullName: 'Ifeoma Obi', role: 'assistant_trainer' })).body.member as { id: string }).id
    tokens.ngozi = await join('ngozi@aliwa.org')
    tokens.ifeoma = await join('ifeoma@aliwa.org')
    ids.programme = ((await post('/v1/programmes', { name: 'Data & AI Skills Programme' })).body.programme as { id: string }).id
    ids.python = ((await post('/v1/courses', { programmeId: ids.programme, name: 'Python for Data Analysis', defaultLeadMemberId: ids.ngozi })).body.course as { id: string }).id
    ids.cohort = ((await post('/v1/cohorts', { programmeId: ids.programme, name: 'Cohort 5', startsOn: day(-5), endsOn: day(60), deliveryMode: 'online', courseIds: [ids.python] })).body
      .cohort as { id: string }).id
    await post(`/v1/members/${ids.ifeoma}/assignments`, { cohortId: ids.cohort, courseId: ids.python, role: 'assistant' })
    const [cc] = await sql<{ id: string }[]>`select id from cohort_courses where cohort_id = ${ids.cohort!}`
    ids.cc = cc!.id
    const [s] = await sql<{ id: string }[]>`
      insert into sessions (organisation_id, cohort_course_id, title, starts_at, ends_at, trainer_member_id, mode, location)
      select organisation_id, id, 'Python', now() + interval '2 days', now() + interval '2 days 2 hours', ${ids.ngozi!}, 'in_person', 'Lab 2' from cohort_courses where id = ${ids.cc!} returning id
    `
    ids.session = s!.id
    ids.chidi = ((await post('/v1/participants', { fullName: 'Chidi Nwosu', email: 'chidi@example.com', cohortId: ids.cohort })).body.participant as { id: string }).id
    tokens.chidi = await join('chidi@example.com')
  })

  afterAll(async () => {
    await drop?.()
  })

  it('lists trainer notifications with timings from the organisation’s settings (T9.02)', async () => {
    const res = await req('GET', '/v1/me/notification-preferences', { token: tokens.ngozi })
    const prefs = res.body.preferences as { event: string; when: string; email: boolean; inApp: boolean }[]
    expect(prefs.map((p) => p.event)).toEqual(['report_due', 'report_overdue', 'submissions_to_grade', 'participant_flagged', 'session_changed', 'attendance_missing', 'zoom_review'])
    expect(prefs.find((p) => p.event === 'report_overdue')!.when).toBe('When the 24 hours pass')
    expect(prefs.find((p) => p.event === 'submissions_to_grade')).toMatchObject({ when: 'Daily digest at 08:00', email: true, inApp: false })
    const put = await req('PUT', '/v1/me/notification-preferences', { token: tokens.ngozi, body: { preferences: [{ event: 'session_changed', email: false, inApp: true }] } })
    expect(put.status).toBe(200)
  })

  it('saves a bio and checks its length (T9.01)', async () => {
    const long = await req('PATCH', '/v1/me', { token: tokens.ngozi, body: { fullName: 'Ngozi Eze', bio: 'x'.repeat(301) } })
    expect(long.body.error!.details).toEqual([{ field: 'bio', message: 'Keep it to 300 characters or fewer.' }])
    await req('PATCH', '/v1/me', { token: tokens.ngozi, body: { fullName: 'Ngozi Eze', phone: '+234 802 555 0187', bio: 'Data analyst. Six years teaching Python.' } })
    const me = await req('GET', '/v1/me', { token: tokens.ngozi })
    expect(me.body.membership).toMatchObject({ bio: 'Data analyst. Six years teaching Python.', phone: '+234 802 555 0187', photoUrl: null })
    // Leaving bio out keeps it.
    await req('PATCH', '/v1/me', { token: tokens.ngozi, body: { fullName: 'Ngozi Eze' } })
    expect((await req('GET', '/v1/me', { token: tokens.ngozi })).body.membership).toMatchObject({ bio: 'Data analyst. Six years teaching Python.' })
  })

  it('uploads, replaces and removes a profile photo', async () => {
    expect((await req('POST', '/v1/me/photo/upload', { token: tokens.ngozi, body: { type: 'image/gif' } })).body.error!.details).toEqual([
      { field: 'photo', message: 'Use a JPG, PNG or WebP image.' },
    ])
    const up = (await req('POST', '/v1/me/photo/upload', { token: tokens.ngozi, body: { type: 'image/png' } })).body.upload as { path: string }
    expect(up.path).toMatch(new RegExp(`/photos/${ids.ngozi}/[0-9a-f-]+\\.png$`))
    expect(((await req('PUT', '/v1/me/photo', { token: tokens.ngozi, body: { path: up.path } })).body.error!.details as { message: string }[])[0]!.message).toBe('The photo didn’t finish uploading. Choose it again.')
    t.files.put(up.path, 3 * 1024 * 1024, 'image/png')
    expect(((await req('PUT', '/v1/me/photo', { token: tokens.ngozi, body: { path: up.path } })).body.error!.details as { message: string }[])[0]!.message).toBe('Photos can be up to 2 MB.')
    t.files.put(up.path, 50_000, 'image/png')
    // Someone else's path is refused.
    expect(((await req('PUT', '/v1/me/photo', { token: tokens.ifeoma, body: { path: up.path } })).body.error!.details as { message: string }[])[0]!.message).toBe('Choose the photo again.')
    const ok = await req('PUT', '/v1/me/photo', { token: tokens.ngozi, body: { path: up.path } })
    expect(ok.body.photoUrl).toBe(`https://storage.example/view/${up.path}`)
    expect((await req('GET', '/v1/me', { token: tokens.ngozi })).body.membership).toMatchObject({ photoUrl: `https://storage.example/view/${up.path}` })
    const second = (await req('POST', '/v1/me/photo/upload', { token: tokens.ngozi, body: { type: 'image/jpeg' } })).body.upload as { path: string }
    t.files.put(second.path, 40_000, 'image/jpeg')
    await req('PUT', '/v1/me/photo', { token: tokens.ngozi, body: { path: second.path } })
    expect(t.files.removed).toContain(up.path)
    expect((await req('DELETE', '/v1/me/photo', { token: tokens.ngozi })).status).toBe(204)
    expect(t.files.removed).toContain(second.path)
    expect((await req('GET', '/v1/me', { token: tokens.ngozi })).body.membership).toMatchObject({ photoUrl: null })
  })

  it('welcomes a trainer with what they teach (T1.04)', async () => {
    const res = await req('GET', '/v1/me/welcome', { token: tokens.ifeoma })
    expect(res.body).toMatchObject({
      kind: 'trainer',
      organisationName: 'ALIWA Foundation',
      zoom: false,
      teaching: [{ course: 'Python for Data Analysis', cohort: 'Cohort 5', lead: false, leadName: 'Ngozi Eze', mode: 'in_person', location: 'Lab 2' }],
      assistantCan: { attendance: expect.any(Boolean), grade: expect.any(Boolean) },
    })
    expect((res.body.teaching as { nextAt: string }[])[0]!.nextAt).toBeTruthy()
  })

  it('welcomes a participant with their cohort and courses (P1.03)', async () => {
    const res = await req('GET', '/v1/me/welcome', { token: tokens.chidi })
    expect(res.body).toMatchObject({
      kind: 'participant',
      cohort: { name: 'Cohort 5', programme: 'Data & AI Skills Programme' },
      courses: [{ course: 'Python for Data Analysis', trainer: 'Ngozi Eze', mode: 'in_person', location: 'Lab 2' }],
    })
  })

  it('tells the trainer when an admin changes their session, respecting their choices', async () => {
    t.mail.sent.length = 0
    await req('POST', `/v1/sessions/${ids.session}/cancel`, { token, body: { reason: 'Lab closed', notify: true } })
    const [n] = await sql<{ title: string; link_path: string }[]>`select title, link_path from notifications where recipient_member_id = ${ids.ngozi!} and event = 'session_changed'`
    expect(n).toMatchObject({ link_path: `/trainer/sessions/${ids.session}` })
    // Ngozi switched session emails off; Chidi still gets one.
    expect(t.mail.sent.map((m) => m.to)).toEqual(['chidi@example.com'])
  })

  it('sends trainers a morning digest of grading and new flags (T9.02)', async () => {
    const lagos = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', hour12: false }).format(new Date())
    await sql`update organisation_settings set digest_local_time = ${`${lagos === '24' ? '00' : lagos}:00`}::time, assistant_can_grade = false, flag_clear_automatically = false`
    const [a] = await sql<{ id: string }[]>`
      insert into assignments (organisation_id, cohort_course_id, title, due_at, grading_scale, max_points, published_at)
      select organisation_id, id, 'Python Exercises 2', now() - interval '1 day', 'points', 10, now() - interval '3 days' from cohort_courses where id = ${ids.cc!} returning id
    `
    await sql`insert into submissions (organisation_id, assignment_id, member_id) select organisation_id, ${a!.id}, ${ids.chidi!} from assignments where id = ${a!.id}`
    await sql`
      insert into attention_flags (organisation_id, enrolment_id, rule, details, raised_at)
      select organisation_id, id, 'missed_in_row', '{"missed": 3}', now() - interval '1 hour' from enrolments where member_id = ${ids.chidi!}
    `
    t.mail.sent.length = 0
    await sql`delete from notifications`
    const deps = { sql, mailer: t.mail.mailer, appUrl: 'http://localhost:5173', storage: t.files.storage, authAdmin: t.auth.admin }
    const ran = await runScheduledJobs(deps)
    // Ngozi: a grading email (in-app off by default) and an in-app flag (email off by default).
    expect(t.mail.sent.filter((m) => m.to === 'ngozi@aliwa.org').map((m) => m.subject)).toEqual(['1 submission waiting for your grade'])
    const bell = await sql<{ recipient_member_id: string; event: string; title: string }[]>`select recipient_member_id, event, title from notifications where event in ('submissions_to_grade', 'participant_flagged') order by title`
    expect(bell).toHaveLength(2)
    expect(bell).toEqual(
      expect.arrayContaining([
        { recipient_member_id: ids.ifeoma, event: 'participant_flagged', title: 'Chidi Nwosu was flagged' },
        { recipient_member_id: ids.ngozi, event: 'participant_flagged', title: 'Chidi Nwosu was flagged' },
      ]),
    )
    // Ifeoma can't grade here, so no grading email for her.
    expect(t.mail.sent.filter((m) => m.to === 'ifeoma@aliwa.org')).toEqual([])
    expect(ran.trainerDigests).toBe(1)
    // Once a day.
    t.mail.sent.length = 0
    await runScheduledJobs(deps)
    expect(t.mail.sent.filter((m) => m.to === 'ngozi@aliwa.org')).toEqual([])
  })
})
