import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/lib/db.js'
import { addDays } from '../src/lib/schedule.js'
import { createTestDatabase, TEST_DATABASE_URL } from './helpers/db.js'
import { as, client, testApp } from './helpers/app.js'

const day = (offset: number) => addDays(new Date().toISOString().slice(0, 10), offset)

describe.skipIf(!TEST_DATABASE_URL)('assignments and grading (T6, C4)', () => {
  let sql: Sql
  let drop: () => Promise<void>
  let req: ReturnType<typeof client>
  const owner = { id: randomUUID(), email: 'ada@aliwa.org' }
  const trainerUser = { id: randomUUID(), email: 'ngozi@aliwa.org' }
  const otherTrainerUser = { id: randomUUID(), email: 'tunde@aliwa.org' }
  const outsider = { id: randomUUID(), email: 'kofi@other.org' }
  let adminToken: string
  let trainerToken: string
  let otherTrainerToken: string
  let outsiderToken: string
  let pythonCc: string
  let sqlCc: string
  const people: Record<string, string> = {}

  const post = (path: string, body: unknown, token = trainerToken) => req('POST', path, { token, body })
  const get = (path: string, token = trainerToken) => req('GET', path, { token })
  const base = (over: Record<string, unknown> = {}) => ({
    cohortCourseId: pythonCc,
    title: 'Python Exercises 1',
    brief: 'Loops and functions.',
    links: [{ url: 'https://example.com/workbook.pdf' }],
    dueDate: day(5),
    dueTime: '23:59',
    submissionTypes: ['file', 'link'],
    latePolicy: 'accept_late',
    gradingScale: 'points',
    maxPoints: 100,
    publish: true,
    ...over,
  })
  const submit = async (assignmentId: string, memberId: string, at = "now() - interval '1 hour'", late = false) => {
    await sql.unsafe(
      `insert into submissions (organisation_id, assignment_id, member_id, link_url, note, is_late, submitted_at)
       select organisation_id, id, $1, 'https://github.com/x/y', 'Done', $2, ${at} from assignments where id = $3`,
      [memberId, late, assignmentId],
    )
  }

  beforeAll(async () => {
    ;({ sql, drop } = await createTestDatabase())
    req = client(testApp(sql).app)
    for (const u of [owner, trainerUser, otherTrainerUser, outsider]) await sql`insert into auth.users (id, email) values (${u.id}, ${u.email})`
    adminToken = as(owner.id, owner.email)
    trainerToken = as(trainerUser.id, trainerUser.email)
    otherTrainerToken = as(otherTrainerUser.id, otherTrainerUser.email)
    outsiderToken = as(outsider.id, outsider.email)
    await post('/v1/organisations', { organisationName: 'ALIWA Foundation', fullName: 'Ada Obi' }, adminToken)
    await post('/v1/organisations', { organisationName: 'Other', fullName: 'Kofi Mensah' }, outsiderToken)

    // Two trainers who have accepted their invitations.
    const trainers: string[] = []
    for (const [u, first, last] of [[trainerUser, 'Ngozi', 'Eze'], [otherTrainerUser, 'Tunde', 'Adeyemi']] as const) {
      const member = (await post('/v1/members', { email: u.email, firstName: first, lastName: last, role: 'trainer' }, adminToken)).body.member as { id: string }
      await sql`update organisation_members set user_id = ${u.id}, status = 'active' where id = ${member.id}`
      trainers.push(member.id)
    }
    const programmeId = ((await post('/v1/programmes', { name: 'Data & AI' }, adminToken)).body.programme as { id: string }).id
    const python = ((await post('/v1/courses', { programmeId, name: 'Python', defaultLeadMemberId: trainers[0] }, adminToken)).body.course as { id: string }).id
    const sqlCourse = ((await post('/v1/courses', { programmeId, name: 'SQL', defaultLeadMemberId: trainers[1] }, adminToken)).body.course as { id: string }).id
    const cohortId = ((await post('/v1/cohorts', { programmeId, name: 'Cohort 5', startsOn: day(-30), endsOn: day(60), deliveryMode: 'online', courseIds: [python, sqlCourse] }, adminToken)).body.cohort as { id: string }).id
    for (const [key, name] of [['amara', 'Amara Okafor'], ['bolaji', 'Bolaji Adeyemi'], ['chidi', 'Chidi Nwosu']] as const) {
      people[key] = ((await post('/v1/participants', { fullName: name, email: `${key}@example.com`, cohortId }, adminToken)).body.participant as { id: string }).id
    }
    const rows = await sql<{ id: string; name: string }[]>`select x.id, c.name from cohort_courses x join courses c on c.id = x.course_id where x.cohort_id = ${cohortId}`
    pythonCc = rows.find((r) => r.name === 'Python')!.id
    sqlCc = rows.find((r) => r.name === 'SQL')!.id
  })

  afterAll(async () => {
    await drop?.()
  })

  it('offers trainers only the courses they teach, and every scale', async () => {
    const res = await get('/v1/assignments/options')
    expect(res.body.courses).toEqual([expect.objectContaining({ id: pythonCc, courseName: 'Python', cohort: expect.objectContaining({ name: 'Cohort 5' }) })])
    expect(res.body.scales).toEqual(['points', 'percentage', 'letter', 'pass_fail', 'rubric'])
  })

  it('checks the form (T6.02)', async () => {
    const noPoints = await post('/v1/assignments', base({ maxPoints: null }))
    expect(noPoints.status).toBe(400)
    expect(noPoints.body.error!.details).toEqual([{ field: 'maxPoints', message: 'Enter the points it’s out of.' }])
    const noCriteria = await post('/v1/assignments', base({ gradingScale: 'rubric', maxPoints: null }))
    expect(noCriteria.body.error!.details).toEqual([{ field: 'criteria', message: 'Add at least one criterion.' }])
    const notMine = await post('/v1/assignments', base({ cohortCourseId: sqlCc }))
    expect(notMine.body.error!.details).toEqual([{ field: 'cohortCourseId', message: 'Choose a course you teach.' }])
    const past = await post('/v1/assignments', base({ dueDate: day(-1) }))
    expect(past.body.error!.details).toEqual([{ field: 'dueDate', message: 'Choose a due date in the future.' }])
  })

  it('publishes, drafts, and shows each trainer only their own (T6.01)', async () => {
    expect((await post('/v1/assignments', base())).status).toBe(201)
    await post('/v1/assignments', base({ title: 'Mini project', gradingScale: 'letter', maxPoints: null, publish: false }))
    await post('/v1/assignments', base({ cohortCourseId: sqlCc, title: 'SQL Exercises 1', gradingScale: 'pass_fail', maxPoints: null }), otherTrainerToken)

    const mine = await get('/v1/assignments')
    expect(mine.body.assignments).toEqual([
      expect.objectContaining({ title: 'Mini project', status: 'draft', scaleLabel: 'Letter grade', canGrade: false }),
      expect.objectContaining({ title: 'Python Exercises 1', status: 'open', scaleLabel: 'Points / 100', counts: expect.objectContaining({ expected: 3, submitted: 0 }) }),
    ])
    // Admins see every published assignment, not drafts.
    const all = await get('/v1/assignments', adminToken)
    expect((all.body.assignments as { title: string }[]).map((a) => a.title).sort()).toEqual(['Python Exercises 1', 'SQL Exercises 1'])
    // Another organisation sees nothing.
    expect((await get('/v1/assignments', outsiderToken)).body.assignments).toEqual([])
  })

  it('lists everyone with a status, and locks the scale once work is in (T6.03, T6.05)', async () => {
    const id = ((await get('/v1/assignments')).body.assignments as { id: string; title: string }[]).find((x) => x.title === 'Python Exercises 1')!.id
    await submit(id, people.amara!, "now() - interval '2 hours'")
    await submit(id, people.bolaji!, "now() - interval '1 hour'", true)

    const detail = await get(`/v1/assignments/${id}`)
    expect(detail.body.assignment).toMatchObject({ locked: true, dueTime: '23:59', links: [{ name: 'example.com/workbook.pdf', url: 'https://example.com/workbook.pdf' }] })
    expect((detail.body.participants as { name: string; status: string }[]).map((r) => [r.name, r.status])).toEqual([
      ['Amara Okafor', 'submitted'],
      ['Bolaji Adeyemi', 'late'],
      ['Chidi Nwosu', 'not_submitted'],
    ])
    expect(detail.body.queue).toEqual([people.amara, people.bolaji])

    const scaleChange = await req('PATCH', `/v1/assignments/${id}`, { token: trainerToken, body: base({ gradingScale: 'percentage', maxPoints: null }) })
    expect(scaleChange.status).toBe(409)
    expect(scaleChange.body.error!.code).toBe('assignment_locked')
    const ok = await req('PATCH', `/v1/assignments/${id}`, { token: trainerToken, body: base({ brief: 'Loops, functions and lists.', dueDate: day(6) }) })
    expect(ok.status).toBe(200)
    // Other trainers can't open it.
    expect((await get(`/v1/assignments/${id}`, otherTrainerToken)).status).toBe(404)
  })

  it('grades points with checks, then moves to the next (T6.04, T6.04b, T6.04x)', async () => {
    const id = ((await get('/v1/assignments')).body.assignments as { id: string; title: string }[]).find((x) => x.title === 'Python Exercises 1')!.id
    const view = await get(`/v1/assignments/${id}/submissions/${people.amara}`)
    expect(view.body).toMatchObject({
      participant: { name: 'Amara Okafor', status: 'submitted' },
      submission: { link: 'https://github.com/x/y', note: 'Done', late: false },
      grade: null,
      queue: { toGrade: 2, position: 1, previousMemberId: null, nextMemberId: people.bolaji },
    })
    const tooHigh = await req('PUT', `/v1/assignments/${id}/submissions/${people.amara}/grade`, { token: trainerToken, body: { points: 105 } })
    expect(tooHigh.body.error!.details).toEqual([{ field: 'points', message: 'Enter a number from 0 to 100.' }])
    const saved = await req('PUT', `/v1/assignments/${id}/submissions/${people.amara}/grade`, { token: trainerToken, body: { points: 78, feedback: 'Solid loops.' } })
    expect(saved.status).toBe(200)
    const after = await get(`/v1/assignments/${id}/submissions/${people.amara}`)
    expect(after.body.grade).toMatchObject({ points: 78, display: '78 / 100', feedback: 'Solid loops.', gradedBy: 'Ngozi Eze' })
    expect(after.body.queue).toMatchObject({ toGrade: 1, position: null, nextMemberId: people.bolaji })

    // Nothing to grade for someone who hasn't submitted.
    const none = await req('PUT', `/v1/assignments/${id}/submissions/${people.chidi}/grade`, { token: trainerToken, body: { points: 50 } })
    expect(none.body.error!.code).toBe('not_submitted')
    // The other trainer can't grade it.
    expect((await req('PUT', `/v1/assignments/${id}/submissions/${people.bolaji}/grade`, { token: otherTrainerToken, body: { points: 50 } })).status).toBe(404)

    const list = await get('/v1/assignments')
    expect((list.body.assignments as { title: string; counts: unknown }[]).find((x) => x.title === 'Python Exercises 1')!.counts).toMatchObject({ submitted: 2, graded: 1, toGrade: 1, late: 1 })
    const admin = await get(`/v1/assignments/${id}`, adminToken)
    expect((admin.body.participants as { name: string; grade: string | null }[])[0]).toMatchObject({ name: 'Amara Okafor', status: 'graded', grade: '78 / 100' })
  })

  it('grades a rubric: every criterion, scored 1–4', async () => {
    const created = await post(
      '/v1/assignments',
      base({
        title: 'Product metrics brief',
        gradingScale: 'rubric',
        maxPoints: null,
        criteria: [{ title: 'Metric choice', description: 'Picks metrics that match the goal' }, { title: 'Use of data' }],
      }),
    )
    const id = (created.body.assignment as { id: string }).id
    await submit(id, people.chidi!)
    const view = await get(`/v1/assignments/${id}/submissions/${people.chidi}`)
    const criteria = (view.body.assignment as { criteria: { id: string; title: string }[] }).criteria
    expect(criteria.map((c) => c.title)).toEqual(['Metric choice', 'Use of data'])
    const partial = await req('PUT', `/v1/assignments/${id}/submissions/${people.chidi}/grade`, { token: trainerToken, body: { rubric: [{ criterionId: criteria[0]!.id, score: 3 }] } })
    expect(partial.body.error!.message).toBe('Score every criterion.')
    await req('PUT', `/v1/assignments/${id}/submissions/${people.chidi}/grade`, {
      token: trainerToken,
      body: { rubric: [{ criterionId: criteria[0]!.id, score: 3 }, { criterionId: criteria[1]!.id, score: 4 }], feedback: 'Good.' },
    })
    const after = await get(`/v1/assignments/${id}/submissions/${people.chidi}`)
    expect(after.body.grade).toMatchObject({ display: '7 / 8' })
    const [g] = await sql<{ score_pct: string }[]>`select score_pct from grades g join submissions s on s.id = g.submission_id where s.assignment_id = ${id}`
    expect(Number(g!.score_pct)).toBe(87.5)
  })

  it('grades pass/fail, letter and percentage in their own scales', async () => {
    const make = async (title: string, gradingScale: string) =>
      ((await post('/v1/assignments', base({ title, gradingScale, maxPoints: null }))).body.assignment as { id: string }).id
    const pf = await make('Quiz', 'pass_fail')
    const letter = await make('Essay', 'letter')
    const pct = await make('Data cleaning quiz', 'percentage')
    for (const id of [pf, letter, pct]) await submit(id, people.amara!)
    const grade = (id: string, body: unknown) => req('PUT', `/v1/assignments/${id}/submissions/${people.amara}/grade`, { token: trainerToken, body })
    expect((await grade(pf, {})).body.error!.details).toEqual([{ field: 'passed', message: 'Choose Pass or Fail.' }])
    await grade(pf, { passed: true })
    await grade(letter, { letter: 'B' })
    expect((await grade(pct, { percentage: 105 })).body.error!.details).toEqual([{ field: 'percentage', message: 'Enter a number from 0 to 100.' }])
    await grade(pct, { percentage: 86 })
    const display = async (id: string) => ((await get(`/v1/assignments/${id}/submissions/${people.amara}`)).body.grade as { display: string }).display
    expect([await display(pf), await display(letter), await display(pct)]).toEqual(['Pass', 'B', '86%'])
  })

  it('keeps assistants to the organisation’s rules', async () => {
    const member = (await post('/v1/members', { email: 'sade@aliwa.org', firstName: 'Sade', lastName: 'Ola', role: 'assistant_trainer' }, adminToken)).body.member as { id: string }
    const userId = randomUUID()
    await sql`insert into auth.users (id, email) values (${userId}, 'sade@aliwa.org')`
    await sql`update organisation_members set user_id = ${userId}, status = 'active' where id = ${member.id}`
    await sql`insert into cohort_course_trainers (organisation_id, cohort_course_id, member_id) select organisation_id, id, ${member.id} from cohort_courses where id = ${pythonCc}`
    const token = as(userId, 'sade@aliwa.org')
    // Creating is off by default; grading is on.
    expect((await post('/v1/assignments', base({ title: 'Assistant’s' }), token)).status).toBe(403)
    const id = ((await get('/v1/assignments', token)).body.assignments as { id: string; title: string }[]).find((x) => x.title === 'Python Exercises 1')!.id
    expect((await req('PUT', `/v1/assignments/${id}/submissions/${people.bolaji}/grade`, { token, body: { points: 60 } })).status).toBe(200)
  })

  it('is closed to participants', async () => {
    const userId = randomUUID()
    await sql`insert into auth.users (id, email) values (${userId}, 'amara@example.com')`
    await sql`update organisation_members set user_id = ${userId}, status = 'active' where id = ${people.amara!}`
    expect((await get('/v1/assignments', as(userId, 'amara@example.com'))).status).toBe(403)
  })
})
