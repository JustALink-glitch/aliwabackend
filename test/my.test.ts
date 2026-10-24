import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/lib/db.js'
import { addDays } from '../src/lib/schedule.js'
import { createTestDatabase, TEST_DATABASE_URL } from './helpers/db.js'
import { as, client, testApp } from './helpers/app.js'

const day = (offset: number) => addDays(new Date().toISOString().slice(0, 10), offset)

describe.skipIf(!TEST_DATABASE_URL)('participant work (P5, P6) and files', () => {
  let sql: Sql
  let drop: () => Promise<void>
  let req: ReturnType<typeof client>
  let files: ReturnType<typeof testApp>['files']
  const admin = { id: randomUUID(), email: 'ada@aliwa.org' }
  const trainerUser = { id: randomUUID(), email: 'ngozi@aliwa.org' }
  let adminToken: string
  let trainerToken: string
  const tokens: Record<string, string> = {}
  const people: Record<string, string> = {}
  let cc: string
  let otherCohortCc: string
  let orgId: string

  const post = (path: string, body: unknown, token = trainerToken) => req('POST', path, { token, body })
  const get = (path: string, token: string) => req('GET', path, { token })
  const assignment = async (over: Record<string, unknown> = {}) =>
    ((
      await post('/v1/assignments', {
        cohortCourseId: cc,
        title: 'Python Exercises 2',
        dueDate: day(3),
        dueTime: '23:59',
        submissionTypes: ['file', 'link'],
        latePolicy: 'accept_late',
        gradingScale: 'points',
        maxPoints: 100,
        publish: true,
        ...over,
      })
    ).body.assignment as { id: string }).id
  /** Moves the due time into the past, as if the deadline had passed. */
  const pastDue = (id: string) => sql`update assignments set due_at = now() - interval '1 hour' where id = ${id}`

  beforeAll(async () => {
    ;({ sql, drop } = await createTestDatabase())
    const t = testApp(sql)
    req = client(t.app)
    files = t.files
    for (const u of [admin, trainerUser]) await sql`insert into auth.users (id, email) values (${u.id}, ${u.email})`
    adminToken = as(admin.id, admin.email)
    trainerToken = as(trainerUser.id, trainerUser.email)
    await post('/v1/organisations', { organisationName: 'ALIWA Foundation', fullName: 'Ada Obi' }, adminToken)
    const trainer = (await post('/v1/members', { email: trainerUser.email, firstName: 'Ngozi', lastName: 'Eze', role: 'trainer' }, adminToken)).body.member as { id: string }
    await sql`update organisation_members set user_id = ${trainerUser.id}, status = 'active' where id = ${trainer.id}`
    const programmeId = ((await post('/v1/programmes', { name: 'Data & AI' }, adminToken)).body.programme as { id: string }).id
    const courseId = ((await post('/v1/courses', { programmeId, name: 'Python', defaultLeadMemberId: trainer.id }, adminToken)).body.course as { id: string }).id
    const cohort = ((await post('/v1/cohorts', { programmeId, name: 'Cohort 5', startsOn: day(-30), endsOn: day(60), deliveryMode: 'online', courseIds: [courseId] }, adminToken)).body.cohort as { id: string }).id
    const other = ((await post('/v1/cohorts', { programmeId, name: 'Cohort 6', startsOn: day(-30), endsOn: day(60), deliveryMode: 'online', courseIds: [courseId] }, adminToken)).body.cohort as { id: string }).id
    for (const [key, name, c] of [['chidi', 'Chidi Nwosu', cohort], ['amara', 'Amara Okafor', cohort], ['kemi', 'Kemi Bello', other]] as const) {
      people[key] = ((await post('/v1/participants', { fullName: name, email: `${key}@example.com`, cohortId: c }, adminToken)).body.participant as { id: string }).id
      const userId = randomUUID()
      await sql`insert into auth.users (id, email) values (${userId}, ${`${key}@example.com`})`
      await sql`update organisation_members set user_id = ${userId}, status = 'active' where id = ${people[key]!}`
      tokens[key] = as(userId, `${key}@example.com`)
    }
    const rows = await sql<{ id: string; cohort_id: string; organisation_id: string }[]>`select id, cohort_id, organisation_id from cohort_courses`
    cc = rows.find((r) => r.cohort_id === cohort)!.id
    otherCohortCc = rows.find((r) => r.cohort_id === other)!.id
    orgId = rows[0]!.organisation_id
  })

  afterAll(async () => {
    await drop?.()
  })

  it('lists only published work in my cohorts (P5.01)', async () => {
    await assignment()
    await assignment({ title: 'Draft one', publish: false })
    await assignment({ cohortCourseId: otherCohortCc, title: 'Other cohort' })
    const res = await get('/v1/my/assignments', tokens.chidi!)
    expect((res.body.assignments as { title: string; status: string; trainer: string }[]).map((a) => [a.title, a.status, a.trainer])).toEqual([
      ['Python Exercises 2', 'not_submitted', 'Ngozi Eze'],
    ])
    // Staff can't use participant routes, and participants can't use staff ones.
    expect((await get('/v1/my/assignments', trainerToken)).status).toBe(403)
    expect((await get('/v1/assignments', tokens.chidi!)).status).toBe(403)
  })

  it('submits a file through a signed upload, and only my own path counts (P5.02)', async () => {
    const id = await assignment({ title: 'Notebook' })
    const upload = await post(`/v1/my/assignments/${id}/uploads`, { name: 'my notebook (v2).ipynb', size: 2048, type: 'application/json' }, tokens.chidi!)
    const path = (upload.body.upload as { path: string }).path
    expect(path).toMatch(new RegExp(`^${orgId}/submissions/${id}/${people.chidi}/[0-9a-f-]+/my-notebook-v2.ipynb$`))
    expect((await post(`/v1/my/assignments/${id}/uploads`, { name: 'big.zip', size: 30 * 1024 * 1024 }, tokens.chidi!)).body.error!.details).toEqual([
      { field: 'size', message: 'Files can be up to 25 MB.' },
    ])

    const notUploaded = await req('PUT', `/v1/my/assignments/${id}/submission`, { token: tokens.chidi!, body: { type: 'file', file: { path, name: 'notebook.ipynb' } } })
    expect(notUploaded.body.error!.details).toEqual([{ field: 'file', message: 'The upload didn’t finish. Choose the file again.' }])
    files.put(path, 2048, 'application/json')
    // Someone else can't claim my upload.
    const stolen = await req('PUT', `/v1/my/assignments/${id}/submission`, { token: tokens.amara!, body: { type: 'file', file: { path, name: 'x' } } })
    expect(stolen.body.error!.details).toEqual([{ field: 'file', message: 'Upload the file again.' }])

    const ok = await req('PUT', `/v1/my/assignments/${id}/submission`, { token: tokens.chidi!, body: { type: 'file', file: { path, name: 'notebook.ipynb' }, note: 'Q9 was hard' } })
    expect(ok.body).toEqual({ ok: true, late: false })
    const mine = await get(`/v1/my/assignments/${id}`, tokens.chidi!)
    expect(mine.body).toMatchObject({ assignment: { status: 'submitted', canSubmit: true }, submission: { note: 'Q9 was hard', files: [{ name: 'notebook.ipynb', size: 2048 }] } })

    // Download: mine yes, Amara no; the trainer can download it too.
    const fileId = (mine.body.submission as { files: { id: string }[] }).files[0]!.id
    expect((await get(`/v1/my/assignments/${id}/files/${fileId}`, tokens.chidi!)).body.url).toContain(path)
    expect((await get(`/v1/my/assignments/${id}/files/${fileId}`, tokens.amara!)).status).toBe(404)
    expect((await get(`/v1/assignments/${id}/files/${fileId}`, trainerToken)).body.url).toContain('download=notebook.ipynb')

    // Replacing before the due time swaps the file and deletes the old one.
    await req('PUT', `/v1/my/assignments/${id}/submission`, { token: tokens.chidi!, body: { type: 'link', link: 'https://github.com/chidi/py2' } })
    expect(files.removed).toContain(path)
    const after = await get(`/v1/my/assignments/${id}`, tokens.chidi!)
    expect(after.body.submission).toMatchObject({ link: 'https://github.com/chidi/py2', files: [], note: null })
  })

  it('takes only the allowed kinds of work', async () => {
    const id = await assignment({ title: 'Links only', submissionTypes: ['link'] })
    const text = await req('PUT', `/v1/my/assignments/${id}/submission`, { token: tokens.chidi!, body: { type: 'text', text: 'my answer' } })
    expect(text.body.error!.details).toEqual([{ field: 'type', message: 'This assignment doesn’t take this kind of submission.' }])
    expect((await post(`/v1/my/assignments/${id}/uploads`, { name: 'a.pdf', size: 10 }, tokens.chidi!)).status).toBe(400)
    const bad = await req('PUT', `/v1/my/assignments/${id}/submission`, { token: tokens.chidi!, body: { type: 'link', link: 'github.com/x' } })
    expect(bad.status).toBe(400)
  })

  it('marks late work late, closes when late work is off, and stops replacing after the due time (P5.02x, P5.02c)', async () => {
    const late = await assignment({ title: 'Late allowed', submissionTypes: ['text'] })
    const closed = await assignment({ title: 'No late work', submissionTypes: ['text'], latePolicy: 'closed' })
    await req('PUT', `/v1/my/assignments/${late}/submission`, { token: tokens.amara!, body: { type: 'text', text: 'On time' } })
    await pastDue(late)
    await pastDue(closed)

    const list = await get('/v1/my/assignments', tokens.chidi!)
    const status = (title: string) => (list.body.assignments as { title: string; status: string }[]).find((a) => a.title === title)!.status
    expect([status('Late allowed'), status('No late work')]).toEqual(['overdue', 'closed'])

    const chidiLate = await req('PUT', `/v1/my/assignments/${late}/submission`, { token: tokens.chidi!, body: { type: 'text', text: 'Sorry, late' } })
    expect(chidiLate.body).toEqual({ ok: true, late: true })
    const blocked = await req('PUT', `/v1/my/assignments/${closed}/submission`, { token: tokens.chidi!, body: { type: 'text', text: 'x' } })
    expect(blocked.body.error!.code).toBe('submissions_closed')
    // Amara already handed in on time, so she can't replace it now.
    const replace = await req('PUT', `/v1/my/assignments/${late}/submission`, { token: tokens.amara!, body: { type: 'text', text: 'Better' } })
    expect(replace.body.error!.code).toBe('replace_closed')
    const amara = await get(`/v1/my/assignments/${late}`, tokens.amara!)
    expect(amara.body.assignment).toMatchObject({ status: 'submitted', canSubmit: false, cantSubmitBecause: 'replace_closed' })
  })

  it('shows grades and feedback as soon as the trainer saves (P6.01, P6.02b)', async () => {
    const id = await assignment({
      title: 'SQL Exercises 1',
      submissionTypes: ['text'],
      gradingScale: 'rubric',
      maxPoints: null,
      criteria: [{ title: 'Correct results', description: 'Every query returns what the question asks for' }, { title: 'Readability' }],
    })
    await req('PUT', `/v1/my/assignments/${id}/submission`, { token: tokens.chidi!, body: { type: 'text', text: 'SELECT 1;' } })
    let grades = await get('/v1/my/grades', tokens.chidi!)
    expect((grades.body.grades as { title: string; grade: string | null }[]).find((g) => g.title === 'SQL Exercises 1')).toMatchObject({ grade: null, status: 'submitted' })

    const view = await get(`/v1/assignments/${id}/submissions/${people.chidi}`, trainerToken)
    const criteria = (view.body.assignment as { criteria: { id: string }[] }).criteria
    await req('PUT', `/v1/assignments/${id}/submissions/${people.chidi}/grade`, {
      token: trainerToken,
      body: { rubric: [{ criterionId: criteria[0]!.id, score: 4 }, { criterionId: criteria[1]!.id, score: 2 }], feedback: 'Use aliases.' },
    })
    grades = await get('/v1/my/grades', tokens.chidi!)
    expect((grades.body.grades as { title: string }[])[0]).toMatchObject({ title: 'SQL Exercises 1', grade: '6 / 8', status: 'graded', hasFeedback: true })
    const detail = await get(`/v1/my/assignments/${id}`, tokens.chidi!)
    expect(detail.body.grade).toMatchObject({ display: '6 / 8', feedback: 'Use aliases.', gradedBy: 'Ngozi Eze', rubric: expect.arrayContaining([{ criterionId: criteria[0]!.id, score: 4 }]) })
    expect(detail.body.assignment).toMatchObject({ canSubmit: false, cantSubmitBecause: 'graded' })
    const again = await req('PUT', `/v1/my/assignments/${id}/submission`, { token: tokens.chidi!, body: { type: 'text', text: 'v2' } })
    expect(again.body.error!.code).toBe('graded')
  })

  it('lets trainers attach files to an assignment, and keeps or removes them on edit (T6.02)', async () => {
    const up = await post('/v1/assignments/uploads', { name: 'brief.pdf', size: 5000 })
    const path = (up.body.upload as { path: string }).path
    expect(path.startsWith(`${orgId}/materials/`)).toBe(true)
    expect((await post('/v1/assignments/uploads', { name: 'x.pdf', size: 10 }, tokens.chidi!)).status).toBe(403)

    const missing = await post('/v1/assignments', {
      cohortCourseId: cc, title: 'With brief', dueDate: day(3), dueTime: '23:59', submissionTypes: ['text'], latePolicy: 'accept_late',
      gradingScale: 'pass_fail', publish: true, files: [{ path, name: 'brief.pdf' }],
    })
    expect(missing.body.error!.details).toEqual([{ field: 'files.0', message: 'brief.pdf didn’t finish uploading. Attach it again.' }])
    files.put(path, 5000)
    const id = ((await post('/v1/assignments', {
      cohortCourseId: cc, title: 'With brief', dueDate: day(3), dueTime: '23:59', submissionTypes: ['text'], latePolicy: 'accept_late',
      gradingScale: 'pass_fail', publish: true, files: [{ path, name: 'brief.pdf' }],
    })).body.assignment as { id: string }).id

    const detail = await get(`/v1/assignments/${id}`, trainerToken)
    const attached = (detail.body.assignment as { files: { id: string; name: string; size: number }[] }).files
    expect(attached).toEqual([{ id: expect.any(String), name: 'brief.pdf', size: 5000 }])
    // Participants in the cohort can download it from the brief.
    const mine = await get(`/v1/my/assignments/${id}`, tokens.chidi!)
    expect((mine.body.assignment as { files: unknown[] }).files).toEqual(attached)
    expect((await get(`/v1/my/assignments/${id}/files/${attached[0]!.id}`, tokens.chidi!)).body.url).toContain('download=brief.pdf')
    expect((await get(`/v1/my/assignments/${id}/files/${attached[0]!.id}`, tokens.kemi!)).status).toBe(404)

    // Editing without the file removes it from the assignment and storage.
    await req('PATCH', `/v1/assignments/${id}`, {
      token: trainerToken,
      body: { cohortCourseId: cc, title: 'With brief', dueDate: day(3), dueTime: '23:59', submissionTypes: ['text'], latePolicy: 'accept_late', gradingScale: 'pass_fail', files: [] },
    })
    expect(((await get(`/v1/assignments/${id}`, trainerToken)).body.assignment as { files: unknown[] }).files).toEqual([])
    expect(files.removed).toContain(path)
  })
})
