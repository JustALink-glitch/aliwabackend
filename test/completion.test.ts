import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/lib/db.js'
import { addDays } from '../src/lib/schedule.js'
import { createTestDatabase, TEST_DATABASE_URL } from './helpers/db.js'
import { as, client, testApp } from './helpers/app.js'

const day = (offset: number) => addDays(new Date().toISOString().slice(0, 10), offset)

type Row = { enrolmentId: string; participant: { id: string; name: string }; status: string; certificate: { id: string; code: string } | null }

describe.skipIf(!TEST_DATABASE_URL)('completion, certificates and outcomes (F1.05, F1.06, D2, D3, P7)', () => {
  let sql: Sql
  let drop: () => Promise<void>
  let req: ReturnType<typeof client>
  let mail: ReturnType<typeof testApp>['mail']
  const admin = { id: randomUUID(), email: 'ada@aliwa.org' }
  let adminToken: string
  let trainerToken: string
  let chidiToken: string
  const people: Record<string, string> = {}
  let programmeId: string
  let endedCohort: string

  const post = (path: string, body: unknown, token = adminToken) => req('POST', path, { token, body })
  const put = (path: string, body: unknown, token = adminToken) => req('PUT', path, { token, body })
  const get = (path: string, token = adminToken) => req('GET', path, { token })
  const rows = async () => (await get('/v1/completion/certificates')).body.enrolments as Row[]
  const statusOf = (list: Row[], key: string) => list.find((r) => r.participant.id === people[key])?.status
  const enrolmentOf = (list: Row[], key: string) => list.find((r) => r.participant.id === people[key])!.enrolmentId

  async function held(cc: string, hoursAgo: number, marks: Record<string, 'present' | 'absent'>) {
    const [s] = await sql<{ id: string }[]>`
      insert into sessions (organisation_id, cohort_course_id, title, starts_at, ends_at)
      select organisation_id, id, 'x', now() - ${hoursAgo} * interval '1 hour', now() - ${hoursAgo - 2} * interval '1 hour'
      from cohort_courses where id = ${cc} returning id
    `
    await sql`
      insert into attendance_records (organisation_id, session_id, member_id, status, source)
      select organisation_id, ${s!.id}, m.id, x.status::attendance_status, 'manual'
      from (select unnest(${Object.keys(marks).map((k) => people[k]!)}::uuid[]) as id, unnest(${Object.values(marks)}::text[]) as status) x
      join organisation_members m on m.id = x.id
    `
  }

  async function graded(cc: string, scores: Record<string, number>) {
    const [a] = await sql<{ id: string; organisation_id: string }[]>`
      insert into assignments (organisation_id, cohort_course_id, title, due_at, grading_scale, published_at)
      select organisation_id, id, 'Project', now() - interval '3 days', 'percentage', now() - interval '20 days' from cohort_courses where id = ${cc}
      returning id, organisation_id
    `
    for (const [k, score] of Object.entries(scores)) {
      const [s] = await sql<{ id: string }[]>`insert into submissions (organisation_id, assignment_id, member_id, text_body) values (${a!.organisation_id}, ${a!.id}, ${people[k]!}, 'x') returning id`
      await sql`insert into grades (organisation_id, submission_id, percentage, score_pct) values (${a!.organisation_id}, ${s!.id}, ${score}, ${score})`
    }
  }

  beforeAll(async () => {
    ;({ sql, drop } = await createTestDatabase())
    const t = testApp(sql)
    req = client(t.app)
    mail = t.mail
    await sql`insert into auth.users (id, email) values (${admin.id}, ${admin.email})`
    adminToken = as(admin.id, admin.email)
    await post('/v1/organisations', { organisationName: 'ALIWA Foundation', fullName: 'Ada Obi' })
    const trainer = (await post('/v1/members', { email: 'ngozi@aliwa.org', firstName: 'Ngozi', lastName: 'Eze', role: 'trainer' })).body.member as { id: string }
    const tUser = randomUUID()
    await sql`insert into auth.users (id, email) values (${tUser}, 'ngozi@aliwa.org')`
    await sql`update organisation_members set user_id = ${tUser}, status = 'active' where id = ${trainer.id}`
    trainerToken = as(tUser, 'ngozi@aliwa.org')
    programmeId = ((await post('/v1/programmes', { name: 'Data & AI', outcomes: ['Employed', 'Internship'] })).body.programme as { id: string }).id
    const courseId = ((await post('/v1/courses', { programmeId, name: 'Python', defaultLeadMemberId: trainer.id })).body.course as { id: string }).id
    endedCohort = ((await post('/v1/cohorts', { programmeId, name: 'Cohort 3', startsOn: day(-60), endsOn: day(30), deliveryMode: 'online', courseIds: [courseId] })).body.cohort as { id: string }).id
    const running = ((await post('/v1/cohorts', { programmeId, name: 'Cohort 5', startsOn: day(-10), endsOn: day(60), deliveryMode: 'online', courseIds: [courseId] })).body.cohort as { id: string }).id
    for (const [key, n, c] of [['grace', 'Grace Eke', endedCohort], ['lara', 'Lara Coker', endedCohort], ['ola', 'Ola Martins', endedCohort], ['chidi', 'Chidi Nwosu', running]] as const) {
      people[key] = ((await post('/v1/participants', { fullName: n, email: `${key}@example.com`, cohortId: c })).body.participant as { id: string }).id
    }
    const pUser = randomUUID()
    await sql`insert into auth.users (id, email, last_sign_in_at) values (${pUser}, 'chidi@example.com', now())`
    await sql`update organisation_members set user_id = ${pUser}, status = 'active' where id = ${people.chidi!}`
    chidiToken = as(pUser, 'chidi@example.com')
    const ccEnded = (await sql<{ id: string }[]>`select id from cohort_courses where cohort_id = ${endedCohort}`)[0]!.id
    const ccRunning = (await sql<{ id: string }[]>`select id from cohort_courses where cohort_id = ${running}`)[0]!.id
    for (const [h, lara] of [[300, 'present'], [250, 'absent'], [200, 'absent'], [150, 'present']] as const) {
      await held(ccEnded, h, { grace: 'present', lara, ola: 'present' })
    }
    await graded(ccEnded, { grace: 80, lara: 90, ola: 40 })
    await held(ccRunning, 50, { chidi: 'present' })
    // The cohort finished two days ago.
    await sql`update cohorts set ends_on = ${day(-2)} where id = ${endedCohort}`
  })

  afterAll(async () => {
    await drop?.()
  })

  it('shows where everyone stands against the rule (D2.01)', async () => {
    const res = await get('/v1/completion/certificates')
    expect(res.status).toBe(200)
    expect((res.body.rule as { sentence: string }).sentence).toBe('At least 75% attendance, 80% of assignments submitted and a 50% average grade, confirmed by an admin.')
    const list = res.body.enrolments as Row[]
    expect(statusOf(list, 'grace')).toBe('eligible')
    expect(statusOf(list, 'lara')).toBe('not_completed') // 50% attendance
    expect(statusOf(list, 'ola')).toBe('not_completed') // 40% grade
    expect(statusOf(list, 'chidi')).toBe('not_yet')
    expect(res.body.counts).toEqual({ eligible: 1, issuedThisYear: 0, completed: 1, inEndedCohorts: 3 })
    expect((await get('/v1/completion/certificates', trainerToken)).status).toBe(403)
  })

  it('issues certificates to eligible people only, and emails them (D2.02)', async () => {
    const list = await rows()
    const refused = await post('/v1/completion/certificates', { enrolmentIds: [enrolmentOf(list, 'lara')] })
    expect(refused.status).toBe(400)
    const before = mail.sent.length
    const ok = await post('/v1/completion/certificates', { enrolmentIds: [enrolmentOf(list, 'grace')], notify: true })
    expect(ok.status).toBe(201)
    expect(ok.body).toEqual({ issued: 1 })
    expect(mail.sent.length - before).toBe(1)
    expect(mail.sent.at(-1)).toMatchObject({ to: 'grace@example.com', subject: 'Your certificate of completion is ready' })
    const after = await rows()
    const grace = after.find((r) => r.participant.id === people.grace)!
    expect(grace.status).toBe('issued')
    expect(grace.certificate!.code).toMatch(/^SYN-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    const [e] = await sql<{ status: string }[]>`select status from enrolments where id = ${grace.enrolmentId}`
    expect(e!.status).toBe('completed')
    const cert = await get(`/v1/completion/certificates/${grace.certificate!.id}`)
    expect(cert.body.certificate).toMatchObject({ title: 'Certificate of Completion', participant: { name: 'Grace Eke' }, programme: 'Data & AI', cohort: { name: 'Cohort 3' }, organisation: 'ALIWA Foundation' })
    // Issuing again does nothing.
    expect((await post('/v1/completion/certificates', { enrolmentIds: [grace.enrolmentId] })).status).toBe(400)
  })

  it('shows participants their progress and certificate (P7.01, P7.02)', async () => {
    const res = await get('/v1/my/progress', chidiToken)
    expect(res.body.progress).toMatchObject({
      status: 'not_yet',
      cohort: { name: 'Cohort 5', ended: false },
      attendance: { enabled: true, needed: 75, value: 100, met: true, detail: '1 of 1 sessions' },
      submissions: { value: null, met: true },
      requiresApproval: true,
    })
    expect((await get('/v1/my/certificate', chidiToken)).status).toBe(404)
    expect((await get('/v1/my/progress')).status).toBe(403)
  })

  it('records outcomes for people who completed (D3.01, D3.02)', async () => {
    const first = await get(`/v1/completion/outcomes?programmeId=${programmeId}`)
    expect(first.body).toMatchObject({ programmeId, completed: 1, notRecorded: 1, cohorts: [{ name: 'Cohort 3' }] })
    const employed = (first.body.options as { id: string; label: string }[]).find((o) => o.label === 'Employed')!
    const enrolmentId = (first.body.people as { enrolmentId: string }[])[0]!.enrolmentId
    const future = await post('/v1/completion/outcomes', { enrolmentId, optionId: employed.id, achievedOn: day(10) })
    expect(future.body.error!.details).toEqual([{ field: 'achievedOn', message: 'Choose a date that has already happened.' }])
    const ok = await post('/v1/completion/outcomes', { enrolmentId, optionId: employed.id, organisationName: 'Northwind Analytics', roleTitle: 'Data analyst', achievedOn: day(-1) })
    expect(ok.status).toBe(201)
    const again = await post('/v1/completion/outcomes', { enrolmentId, optionId: employed.id, organisationName: 'Northwind Analytics', roleTitle: 'Junior data analyst', achievedOn: day(-1) })
    expect(again.status).toBe(201)
    const res = await get(`/v1/completion/outcomes?programmeId=${programmeId}&cohortId=${endedCohort}`)
    expect(res.body).toMatchObject({ notRecorded: 0, outcomes: [{ participant: { name: 'Grace Eke' }, option: { label: 'Employed' }, roleTitle: 'Junior data analyst' }] })
    expect((res.body.options as { label: string; count: number }[]).map((o) => [o.label, o.count])).toEqual([['Employed', 1], ['Internship', 0]])
    // Only people who completed.
    const lara = enrolmentOf(await rows(), 'lara')
    expect((await post('/v1/completion/outcomes', { enrolmentId: lara, optionId: employed.id, achievedOn: day(-1) })).status).toBe(400)
  })

  it('saves completion settings, and issues automatically when set (F1.05)', async () => {
    const current = (await get('/v1/settings/completion')).body.settings as Record<string, unknown>
    expect(current).toMatchObject({ attendance: { enabled: true, minPct: 75 }, certificateTitle: 'Certificate of Completion', defaultOutcomes: ['Employed', 'Internship', 'Further study', 'Started a business', 'Freelancing'] })
    const bad = await put('/v1/settings/completion', { ...current, grade: { enabled: true, minPct: 120 } })
    expect(bad.status).toBe(400)
    const saved = await put('/v1/settings/completion', {
      ...current,
      grade: { enabled: true, minPct: 30 },
      autoIssue: true,
      requiresApproval: false,
      signedBy: 'Ada Obi, Programme Director',
      defaultOutcomes: ['Employed', 'Apprenticeship'],
    })
    expect(saved.body.settings).toMatchObject({ signedBy: 'Ada Obi, Programme Director', grade: { minPct: 30 }, autoIssue: true })
    expect((await get('/v1/programmes')).body.defaultOutcomes).toEqual(['Employed', 'Apprenticeship'])
    // Ola now meets the rule and is issued automatically.
    const list = await rows()
    expect(statusOf(list, 'ola')).toBe('issued')
    const cert = await get(`/v1/completion/certificates/${list.find((r) => r.participant.id === people.ola)!.certificate!.id}`)
    expect((cert.body.certificate as { signedBy: string }).signedBy).toBe('Ada Obi, Programme Director')
    expect((await get('/v1/settings/completion', trainerToken)).status).toBe(403)
  })

  it('saves needs-attention rules, including who sees flags (F1.06)', async () => {
    const current = (await get('/v1/settings/attention-rules')).body.settings as Record<string, unknown>
    expect(current).toMatchObject({ missedInRow: { enabled: true, count: 2 }, trainersSee: true, clearAutomatically: true, trainersCanResolve: false })
    expect(typeof current.flaggedNow).toBe('number')
    expect((await put('/v1/settings/attention-rules', { ...current, inactivity: { enabled: true, days: 0 } })).status).toBe(400)
    // Chidi has had no sign-in for a while: flag him for inactivity after one day.
    await sql`update auth.users set last_sign_in_at = now() - interval '5 days' where email = 'chidi@example.com'`
    await sql`update enrolments set enrolled_at = now() - interval '10 days' where member_id = ${people.chidi!}`
    await sql`update sessions set starts_at = starts_at - interval '5 days', ends_at = ends_at - interval '5 days' where id in (select session_id from attendance_records where member_id = ${people.chidi!})`
    const saved = await put('/v1/settings/attention-rules', { ...current, inactivity: { enabled: true, days: 1 }, trainersCanResolve: true })
    expect((saved.body.settings as { flaggedNow: number }).flaggedNow).toBeGreaterThanOrEqual(1)
    expect(((await get('/v1/attention', trainerToken)).body.participants as unknown[]).length).toBeGreaterThanOrEqual(1)
    expect((await get(`/v1/attention/participants/${people.chidi}`, trainerToken)).body.canResolve).toBe(true)
    expect((await post(`/v1/attention/participants/${people.chidi}/resolve`, { note: 'Called; back next week.' }, trainerToken)).status).toBe(200)
    await put('/v1/settings/attention-rules', { ...current, trainersSee: false })
    expect((await get('/v1/attention', trainerToken)).body.participants).toEqual([])
    expect((await get('/v1/attention/count', trainerToken)).body.count).toBe(0)
    expect((await put('/v1/settings/attention-rules', current, trainerToken)).status).toBe(403)
  })
})
