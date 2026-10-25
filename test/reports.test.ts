import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/lib/db.js'
import { addDays } from '../src/lib/schedule.js'
import { createTestDatabase, TEST_DATABASE_URL } from './helpers/db.js'
import { as, client, testApp } from './helpers/app.js'

const day = (offset: number) => addDays(new Date().toISOString().slice(0, 10), offset)

type Question = { id: string; prompt: string; options: string[]; multiple: boolean }
type Row = { sessionId: string; state: string; draft: boolean; trainer: { name: string } | null }

describe.skipIf(!TEST_DATABASE_URL)('session reports and Today (T5, C3, F1.08, T2)', () => {
  let sql: Sql
  let drop: () => Promise<void>
  let req: ReturnType<typeof client>
  let mail: ReturnType<typeof testApp>['mail']
  const admin = { id: randomUUID(), email: 'ada@aliwa.org' }
  let adminToken: string
  let ngozi: string
  let assistant: string
  const ids: Record<string, string> = {}

  const get = (path: string, token = adminToken) => req('GET', path, { token })
  const post = (path: string, body: unknown, token = adminToken) => req('POST', path, { token, body })
  const put = (path: string, body: unknown, token = adminToken) => req('PUT', path, { token, body })

  async function member(email: string, firstName: string, lastName: string, role: string) {
    const m = (await post('/v1/members', { email, firstName, lastName, role })).body.member as { id: string }
    const user = randomUUID()
    await sql`insert into auth.users (id, email) values (${user}, ${email})`
    await sql`update organisation_members set user_id = ${user}, status = 'active' where id = ${m.id}`
    return { id: m.id, token: as(user, email) }
  }

  /** A session that ended `hoursAgo` hours ago. */
  async function ended(hoursAgo: number) {
    const [s] = await sql<{ id: string }[]>`
      insert into sessions (organisation_id, cohort_course_id, title, starts_at, ends_at, trainer_member_id)
      select organisation_id, id, 'x', now() - ${hoursAgo + 2} * interval '1 hour', now() - ${hoursAgo} * interval '1 hour', ${ids.ngozi!}
      from cohort_courses where id = ${ids.cc!} returning id
    `
    return s!.id
  }

  beforeAll(async () => {
    ;({ sql, drop } = await createTestDatabase())
    const t = testApp(sql)
    req = client(t.app)
    mail = t.mail
    await sql`insert into auth.users (id, email) values (${admin.id}, ${admin.email})`
    adminToken = as(admin.id, admin.email)
    await post('/v1/organisations', { organisationName: 'ALIWA Foundation', fullName: 'Ada Obi' })
    const n = await member('ngozi@aliwa.org', 'Ngozi', 'Eze', 'trainer')
    const a = await member('sade@aliwa.org', 'Sade', 'Bakare', 'assistant_trainer')
    ngozi = n.token
    assistant = a.token
    ids.ngozi = n.id
    const programmeId = ((await post('/v1/programmes', { name: 'Data & AI' })).body.programme as { id: string }).id
    const courseId = ((await post('/v1/courses', { programmeId, name: 'Python', defaultLeadMemberId: n.id })).body.course as { id: string }).id
    const cohortId = ((await post('/v1/cohorts', { programmeId, name: 'Cohort 5', startsOn: day(-20), endsOn: day(60), deliveryMode: 'online', courseIds: [courseId] })).body.cohort as { id: string }).id
    ids.cc = (await sql<{ id: string }[]>`select id from cohort_courses where cohort_id = ${cohortId}`)[0]!.id
    await sql`insert into cohort_course_trainers (organisation_id, cohort_course_id, member_id) select organisation_id, id, ${a.id} from cohort_courses where id = ${ids.cc}`
    await post('/v1/participants', { fullName: 'Amara Okafor', email: 'amara@example.com', cohortId })
    ids.due = await ended(3)
    ids.overdue = await ended(40)
    // Upcoming: no report yet.
    await sql`insert into sessions (organisation_id, cohort_course_id, title, starts_at, ends_at) select organisation_id, id, 'x', now() + interval '1 hour', now() + interval '3 hours' from cohort_courses where id = ${ids.cc}`
  })

  afterAll(async () => {
    await drop?.()
  })

  it('starts every organisation with the F1.08 questions', async () => {
    const res = await get('/v1/settings/session-reports')
    expect(res.body.settings).toMatchObject({ dueHours: 24, remind: true, overdueOnOverview: true })
    const questions = (res.body.settings as { questions: Question[] }).questions
    expect(questions.map((q) => [q.prompt, q.multiple])).toEqual([
      ['How much of the planned content did you cover?', false],
      ['How engaged were participants overall?', false],
      ['Did anything get in the way?', true],
    ])
  })

  it('lists held sessions with their report state (T5.03, C3.01)', async () => {
    const mine = await get('/v1/session-reports', ngozi)
    const rows = mine.body.reports as Row[]
    expect(rows.map((r) => [r.sessionId, r.state])).toEqual([
      [ids.due, 'due'],
      [ids.overdue, 'overdue'],
    ])
    expect(mine.body).toMatchObject({ canWrite: true, counts: { due: 1, overdue: 1, submitted: 0 } })
    expect((await get('/v1/session-reports', assistant)).body.reports).toEqual([])
    expect(((await get('/v1/session-reports')).body.reports as Row[])[0]!.trainer).toEqual({ id: ids.ngozi, name: 'Ngozi Eze' })
  })

  it('saves a draft, then checks every answer on submit (T5.01)', async () => {
    const form = await get(`/v1/session-reports/${ids.due}`, ngozi)
    expect(form.body).toMatchObject({ state: 'due', report: null, can: { write: true, edit: false } })
    const [q1, q2, q3] = form.body.questions as Question[]
    expect((await put(`/v1/session-reports/${ids.due}`, { answers: [{ questionId: q1!.id, choices: ['Most of it'] }], summary: 'Half way' }, ngozi)).body).toEqual({ saved: true, submitted: false })
    expect(((await get('/v1/session-reports', ngozi)).body.reports as Row[])[0]).toMatchObject({ state: 'due', draft: true })
    const bad = await put(`/v1/session-reports/${ids.due}`, { answers: [{ questionId: q1!.id, choices: ['Most of it', 'All of it'] }, { questionId: q3!.id, choices: ['Lunch'] }], summary: ' ', submit: true }, ngozi)
    expect(bad.body.error!.details).toEqual([
      { field: `answers.${q1!.id}`, message: 'Choose one option.' },
      { field: `answers.${q2!.id}`, message: 'Answer question 2.' },
      { field: `answers.${q3!.id}`, message: 'Choose one of the options.' },
      { field: 'summary', message: 'Write a short summary.' },
    ])
    const answers = [
      { questionId: q1!.id, choices: ['Most of it'] },
      { questionId: q2!.id, choices: ['Mostly engaged'] },
      { questionId: q3!.id, choices: ['Venue or equipment', 'Connectivity'] },
    ]
    expect((await put(`/v1/session-reports/${ids.due}`, { answers, summary: 'Covered loops and functions.', submit: true }, ngozi)).body).toEqual({ saved: true, submitted: true })
    const done = await get(`/v1/session-reports/${ids.due}`, ngozi)
    expect(done.body).toMatchObject({ state: 'submitted', report: { summary: 'Covered loops and functions.', author: 'You', onTime: true }, can: { write: true, edit: true } })
    expect((done.body.report as { answers: Record<string, string[]> }).answers[q3!.id]).toEqual(['Connectivity', 'Venue or equipment'])
    // Still editable until it's due.
    expect((await put(`/v1/session-reports/${ids.due}`, { answers, summary: 'Covered loops, functions and pandas.', submit: true }, ngozi)).status).toBe(200)
    await sql`update sessions set ends_at = now() - interval '30 hours', starts_at = now() - interval '32 hours' where id = ${ids.due!}`
    const locked = await put(`/v1/session-reports/${ids.due}`, { answers, summary: 'Late edit', submit: true }, ngozi)
    expect(locked.body.error!.code).toBe('report_locked')
    expect((await get(`/v1/session-reports/${ids.due}`)).body).toMatchObject({ report: { author: 'Ngozi Eze' }, can: { write: false }, trainer: { email: 'ngozi@aliwa.org' } })
  })

  it('accepts a late report, then locks it; admins remind but never write (C3.01, C3.02)', async () => {
    expect((await put(`/v1/session-reports/${ids.overdue}`, { answers: [], summary: 'x', submit: true })).status).toBe(403)
    expect((await put(`/v1/session-reports/${ids.overdue}`, { answers: [], summary: 'x' }, assistant)).status).toBe(403)
    const before = mail.sent.length
    expect((await post(`/v1/session-reports/${ids.overdue}/remind`, {})).body).toEqual({ sent: true, to: 'Ngozi Eze' })
    expect(mail.sent.length - before).toBe(1)
    expect(mail.sent.at(-1)!.subject).toMatch(/^Session report overdue: Python, /)
    expect((await post(`/v1/session-reports/${ids.overdue}/remind`, {}, ngozi)).status).toBe(403)
    const questions = (await get(`/v1/session-reports/${ids.overdue}`, ngozi)).body.questions as Question[]
    const answers = questions.map((q) => ({ questionId: q.id, choices: [q.options[0]!] }))
    expect((await put(`/v1/session-reports/${ids.overdue}`, { answers, summary: 'Sorry this is late.', submit: true }, ngozi)).status).toBe(200)
    expect((await get(`/v1/session-reports/${ids.overdue}`, ngozi)).body).toMatchObject({ report: { onTime: false }, can: { write: false } })
    expect((await post(`/v1/session-reports/${ids.overdue}/remind`, {})).status).toBe(409)
  })

  it('changes questions without changing submitted reports (F1.08)', async () => {
    const current = (await get('/v1/settings/session-reports')).body.settings as { questions: Question[] }
    const [q1, , q3] = current.questions
    const bad = await put('/v1/settings/session-reports', { dueHours: 0, remind: true, overdueOnOverview: true, questions: [{ prompt: 'x', multiple: false, options: ['A'] }] })
    expect(bad.body.error!.details).toEqual([
      { field: 'dueHours', message: 'Use 1 hour or more.' },
      { field: 'questions.0.options', message: 'Give at least two options.' },
    ])
    const saved = await put('/v1/settings/session-reports', {
      dueHours: 48,
      remind: false,
      overdueOnOverview: true,
      questions: [
        { id: q1!.id, prompt: 'How much did you cover?', multiple: false, options: ['All', 'Most', 'Some'] },
        { id: q3!.id, prompt: q3!.prompt, multiple: true, options: q3!.options },
        { prompt: 'Would you teach it the same way again?', multiple: false, options: ['Yes', 'With changes', 'No'] },
      ],
    })
    expect((saved.body.settings as { questions: Question[] }).questions.map((q) => q.prompt)).toEqual(['How much did you cover?', 'Did anything get in the way?', 'Would you teach it the same way again?'])
    expect(saved.body.settings).toMatchObject({ dueHours: 48, remind: false })
    const old = await get(`/v1/session-reports/${ids.due}`)
    expect((old.body.questions as Question[]).map((q) => q.prompt)).toEqual([
      'How much of the planned content did you cover?',
      'How engaged were participants overall?',
      'Did anything get in the way?',
    ])
    expect((await get('/v1/settings/session-reports', ngozi)).status).toBe(403)
  })

  it('puts today’s teaching on one page (T2.01, T2.01a)', async () => {
    const [a] = await sql<{ id: string; organisation_id: string }[]>`
      insert into assignments (organisation_id, cohort_course_id, title, due_at, grading_scale, published_at)
      select organisation_id, id, 'Python Exercises 1', now() - interval '1 day', 'percentage', now() - interval '5 days' from cohort_courses where id = ${ids.cc!}
      returning id, organisation_id
    `
    const [p] = await sql<{ id: string }[]>`select id from organisation_members where email = 'amara@example.com'`
    await sql`insert into submissions (organisation_id, assignment_id, member_id, text_body) values (${a!.organisation_id}, ${a!.id}, ${p!.id}, 'x')`
    const res = await get('/v1/trainer/today', ngozi)
    expect(res.body).toMatchObject({
      role: 'lead',
      cohorts: [{ name: 'Cohort 5', participants: 1, courses: ['Python'] }],
      toGrade: { submissions: 1, assignments: 1 },
      grading: [{ title: 'Python Exercises 1', submitted: 1, expected: 1, toGrade: 1 }],
    })
    expect((res.body.today as unknown[]).length + (res.body.next ? 1 : 0)).toBeGreaterThanOrEqual(1)
    const mine = await get('/v1/trainer/today', assistant)
    expect(mine.body).toMatchObject({ role: 'assistant', assists: [{ course: 'Python', cohort: 'Cohort 5', lead: 'Ngozi Eze' }], can: { attendance: true, reports: false } })
  })
})
