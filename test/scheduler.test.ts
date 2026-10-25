import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Sql } from '../src/lib/db.js'
import { addDays } from '../src/lib/schedule.js'
import { runScheduledJobs, type SchedulerDeps } from '../src/lib/scheduler.js'
import { createTestDatabase, TEST_DATABASE_URL } from './helpers/db.js'
import { as, client, testApp } from './helpers/app.js'

const day = (offset: number) => addDays(new Date().toISOString().slice(0, 10), offset)

describe.skipIf(!TEST_DATABASE_URL)('scheduled jobs (X2)', () => {
  let sql: Sql
  let drop: () => Promise<void>
  let t: ReturnType<typeof testApp>
  let req: ReturnType<typeof client>
  let deps: SchedulerDeps
  const owner = { id: randomUUID(), email: 'ada@aliwa.org' }
  let token: string
  const ids: Record<string, string> = {}
  const post = (path: string, body: unknown, tk = token) => req('POST', path, { token: tk, body })
  const to = (email: string) => t.mail.sent.filter((m) => m.to === email)
  const run = (now = new Date()) => runScheduledJobs(deps, now)
  const hours = (h: number) => new Date(Date.now() + h * 3_600_000)

  /** A session in Cohort 5's Python course, relative to now. */
  async function session(startHours: number, lengthHours = 2) {
    const [s] = await sql<{ id: string }[]>`
      insert into sessions (organisation_id, cohort_course_id, title, starts_at, ends_at, trainer_member_id)
      select organisation_id, id, 'Python for Data Analysis', ${hours(startHours)}, ${hours(startHours + lengthHours)}, ${ids.trainer!} from cohort_courses where id = ${ids.cc!} returning id
    `
    return s!.id
  }

  async function participant(name: string, email: string, join = true) {
    const id = ((await post('/v1/participants', { fullName: name, email, cohortId: ids.cohort })).body.participant as { id: string }).id
    if (join) await req('POST', `/v1/invitations/${t.mail.lastToken(email)}/accept`, { body: { password: 'a-strong-password' } })
    return id
  }

  beforeAll(async () => {
    ;({ sql, drop } = await createTestDatabase())
    t = testApp(sql)
    req = client(t.app)
    deps = { sql, mailer: t.mail.mailer, appUrl: 'http://localhost:5173', storage: t.files.storage, authAdmin: t.auth.admin }
    await sql`insert into auth.users (id, email) values (${owner.id}, ${owner.email})`
    token = as(owner.id, owner.email)
    await post('/v1/organisations', { organisationName: 'ALIWA Foundation', fullName: 'Ada Obi' })
    const trainer = (await post('/v1/members', { email: 'ngozi@aliwa.org', fullName: 'Ngozi Eze', role: 'trainer' })).body.member as { id: string }
    await req('POST', `/v1/invitations/${t.mail.lastToken('ngozi@aliwa.org')}/accept`, { body: { password: 'a-strong-password' } })
    ids.trainer = trainer.id
    ids.programme = ((await post('/v1/programmes', { name: 'Data & AI' })).body.programme as { id: string }).id
    const course = ((await post('/v1/courses', { programmeId: ids.programme, name: 'Python for Data Analysis', defaultLeadMemberId: trainer.id })).body.course as { id: string }).id
    ids.cohort = ((await post('/v1/cohorts', { programmeId: ids.programme, name: 'Cohort 5', startsOn: day(-20), endsOn: day(60), deliveryMode: 'online', courseIds: [course] })).body
      .cohort as { id: string }).id
    const [cc] = await sql<{ id: string }[]>`select id from cohort_courses where cohort_id = ${ids.cohort!}`
    ids.cc = cc!.id
    ids.chidi = await participant('Chidi Nwosu', 'chidi@example.com')
    ids.amara = await participant('Amara Okafor', 'amara@example.com')
    ids.bisi = await participant('Bisi Ade', 'bisi@example.com', false)
    // Start each test with an empty outbox and no sessions.
  })

  beforeEach(async () => {
    t.mail.sent.length = 0
    await sql`delete from sessions`
    await sql`delete from notifications`
  })

  afterAll(async () => {
    await drop?.()
  })

  it('reminds participants once before a session, respecting their choices (X2.01)', async () => {
    await req('PUT', '/v1/me/notification-preferences', {
      token: as((await sql<{ user_id: string }[]>`select user_id from organisation_members where id = ${ids.amara!}`)[0]!.user_id, 'amara@example.com'),
      body: { preferences: [{ event: 'session_starting', email: false, inApp: true }] },
    })
    const id = await session(0.5)
    await session(3) // too far ahead
    expect((await run()).sessionReminders).toBe(1)
    const [mail] = to('chidi@example.com')
    expect(mail!.subject).toMatch(/^Starts at \d\d:\d\d — Python for Data Analysis$/)
    expect(mail!.text).toContain('Your session starts in 30 minutes')
    expect(mail!.text).toContain('Trainer: Ngozi Eze')
    expect(mail!.text).toContain(`http://localhost:5173/participant/sessions/${id}`)
    // Amara turned email off but still sees it in the app; Bisi hasn't joined yet.
    expect(to('amara@example.com')).toHaveLength(0)
    expect(to('bisi@example.com')).toHaveLength(0)
    expect(await sql`select recipient_member_id from notifications where event = 'session_starting' order by recipient_member_id`).toHaveLength(2)
    expect((await run()).sessionReminders).toBe(0)
    expect(t.mail.sent).toHaveLength(1)
  })

  it('reminds only people who haven’t submitted (X2.02)', async () => {
    const a = (
      await post('/v1/assignments', {
        cohortCourseId: ids.cc,
        title: 'Python Exercises 2',
        brief: 'Loops.',
        dueDate: day(1),
        dueTime: '23:59',
        submissionTypes: ['link'],
        latePolicy: 'accept_late',
        gradingScale: 'points',
        maxPoints: 100,
        publish: true,
      })
    ).body.assignment as { id: string }
    await sql`update assignments set due_at = ${hours(20)} where id = ${a.id}`
    await sql`insert into submissions (organisation_id, assignment_id, member_id, link_url, submitted_at) select organisation_id, id, ${ids.amara!}, 'https://x.y', now() from assignments where id = ${a.id}`
    expect((await run()).assignmentReminders).toBe(1)
    expect(to('chidi@example.com')[0]!.text).toContain('Status: Not submitted')
    expect(to('amara@example.com')).toHaveLength(0)
    expect((await run()).assignmentReminders).toBe(0)
    await sql`delete from assignments`
  })

  it('reminds the trainer before a report is due, then flags it overdue (F1.08, X2.05)', async () => {
    const soon = await session(-24) // ended 22 hours ago; due in 2 hours
    const late = await session(-30) // ended 28 hours ago; 4 hours overdue
    const counts = await run()
    expect(counts).toMatchObject({ reportReminders: 1, reportsOverdue: 1 })
    const mails = to('ngozi@aliwa.org').map((m) => m.subject)
    expect(mails.some((s) => s.startsWith('Overdue — session report for'))).toBe(true)
    expect(mails.some((s) => s.startsWith('Due '))).toBe(true)
    // Admins see it in the app; their email for this is off by default.
    expect(await sql`select event, link_path from notifications n join organisation_members m on m.id = n.recipient_member_id where m.role = 'owner' and n.event = 'report_overdue'`).toEqual([
      { event: 'report_overdue', link_path: `/admin/courses/reports/${late}` },
    ])
    expect(to(owner.email)).toHaveLength(0)
    expect(await run()).toMatchObject({ reportReminders: 0, reportsOverdue: 0 })
    expect(soon).toBeTruthy()
  })

  it('reminds the trainer when attendance isn’t recorded (F1.07)', async () => {
    const missing = await session(-5) // ended 3 hours ago
    const taken = await session(-6)
    await sql`insert into attendance_records (organisation_id, session_id, member_id, status, source) select organisation_id, ${taken}, ${ids.chidi!}, 'present', 'manual' from sessions where id = ${taken}`
    await sql`update organisation_settings set report_due_hours = 168`
    expect((await run()).attendanceMissing).toBe(1)
    expect(to('ngozi@aliwa.org').map((m) => m.subject)).toEqual([expect.stringMatching(/^Take attendance — Python for Data Analysis/)])
    expect(to('ngozi@aliwa.org')[0]!.text).toContain(`/trainer/sessions/${missing}/attendance`)
    await sql`update organisation_settings set in_person_reminder_enabled = false, report_due_hours = 24`
    await sql`delete from delivery_log where key like 'attendance_missing:%'`
    expect((await run()).attendanceMissing).toBe(0)
    await sql`update organisation_settings set in_person_reminder_enabled = true`
  })

  it('sends admins a daily digest when there’s something new (X2.06)', async () => {
    // Digest time: the start of this hour in Lagos.
    const lagos = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', hour12: false }).format(new Date()).padStart(2, '0')
    await req('PUT', '/v1/me/notification-preferences', { token, body: { preferences: [], digestTime: `${lagos === '24' ? '00' : lagos}:00` } })
    await sql`update organisation_settings set flag_clear_automatically = false`
    expect((await run()).digests).toBe(0) // nothing new: no email
    await sql`delete from delivery_log where key like 'digest:%'`
    await sql`
      insert into attention_flags (organisation_id, enrolment_id, rule, details, raised_at)
      select organisation_id, id, 'missed_in_row', '{"missed": 3}', now() - interval '1 hour' from enrolments where member_id = ${ids.chidi!}
    `
    expect((await run()).digests).toBe(1)
    const [mail] = to(owner.email)
    expect(mail!.subject).toMatch(/^Synqop daily digest — /)
    expect(mail!.text).toContain('New flags: Chidi Nwosu · Cohort 5 — missed 3 sessions in a row')
    expect((await run()).digests).toBe(0)
  })

  it('deletes an organisation after its 30 days, sign-ins included (F1.11)', async () => {
    const other = { id: randomUUID(), email: 'zed@other.org' }
    await sql`insert into auth.users (id, email) values (${other.id}, ${other.email})`
    const tk = as(other.id, other.email)
    await post('/v1/organisations', { organisationName: 'Other Org', fullName: 'Zed Ola' }, tk)
    const p = ((await post('/v1/programmes', { name: 'P' }, tk)).body.programme as { id: string }).id
    const c = ((await post('/v1/courses', { programmeId: p, name: 'C' }, tk)).body.course as { id: string }).id
    const h = ((await post('/v1/cohorts', { programmeId: p, name: 'H', startsOn: day(-5), endsOn: day(5), deliveryMode: 'online', courseIds: [c] }, tk)).body.cohort as { id: string }).id
    const member = ((await post('/v1/participants', { fullName: 'Pat Doe', email: 'pat@other.org', cohortId: h }, tk)).body.participant as { id: string }).id
    const [s] = await sql<{ id: string; organisation_id: string }[]>`
      insert into sessions (organisation_id, cohort_course_id, title, starts_at, ends_at) select organisation_id, id, 'x', now() - interval '3 hours', now() - interval '2 hours' from cohort_courses where cohort_id = ${h} returning id, organisation_id
    `
    await sql`insert into attendance_records (organisation_id, session_id, member_id, status, source) values (${s!.organisation_id}, ${s!.id}, ${member}, 'present', 'manual')`
    await post('/v1/privacy/deletion', { exported: true, confirmName: 'Other Org' }, tk)
    expect((await run()).deleted).toBe(0)
    await sql`update organisations set deletion_scheduled_for = now() - interval '1 minute' where id = ${s!.organisation_id}`
    expect((await run()).deleted).toBe(1)
    expect(await sql`select 1 from organisations where id = ${s!.organisation_id}`).toHaveLength(0)
    expect(await sql`select 1 from organisation_members where email in ('zed@other.org', 'pat@other.org')`).toHaveLength(0)
    expect(t.auth.deleted).toContain(other.id)
    // ALIWA is untouched.
    expect(await sql`select 1 from organisations where name = 'ALIWA Foundation'`).toHaveLength(1)
  })

  it('lets an outside cron run the jobs only with the secret', async () => {
    const secret = 'a'.repeat(32)
    const withSecret = testApp(sql, {}).app
    expect((await withSecret.request('/v1/internal/run-jobs', { method: 'POST', headers: { Authorization: `Bearer ${secret}` } })).status).toBe(404)
    const app = (await import('../src/app.js')).createApp({ ...deps, corsOrigins: [], verifyToken: async () => null, loadMembership: async () => ({ reason: 'no_organisation' }), cronSecret: secret, log: false })
    expect((await app.request('/v1/internal/run-jobs', { method: 'POST', headers: { Authorization: 'Bearer wrong' } })).status).toBe(404)
    const ok = await app.request('/v1/internal/run-jobs', { method: 'POST', headers: { Authorization: `Bearer ${secret}` } })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { ran: Record<string, number> }).ran).toHaveProperty('digests')
  })
})
