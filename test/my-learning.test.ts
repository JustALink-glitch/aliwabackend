import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/lib/db.js'
import { addDays } from '../src/lib/schedule.js'
import { createTestDatabase, TEST_DATABASE_URL } from './helpers/db.js'
import { as, client, testApp } from './helpers/app.js'

const day = (offset: number) => addDays(new Date().toISOString().slice(0, 10), offset)

describe.skipIf(!TEST_DATABASE_URL)('participant learning (P2, P3, P4, P8)', () => {
  let sql: Sql
  let drop: () => Promise<void>
  let req: ReturnType<typeof client>
  const admin = { id: randomUUID(), email: 'ada@aliwa.org' }
  let adminToken: string
  const tokens: Record<string, string> = {}
  const people: Record<string, string> = {}
  let cohortId: string
  let laterCohortId: string
  let cc: string
  let courseId: string
  let sqlCc: string
  const sessions: Record<string, string> = {}

  const post = (path: string, body: unknown, token = adminToken) => req('POST', path, { token, body })
  const get = (path: string, token: string) => req('GET', path, { token })

  async function addSession(key: string, cohortCourseId: string, startHoursFromNow: number, extra: { mode?: string; location?: string; joinUrl?: string } = {}) {
    const [row] = await sql<{ id: string }[]>`
      insert into sessions (organisation_id, cohort_course_id, title, starts_at, ends_at, mode, location, zoom_join_url)
      select organisation_id, id, 'x', now() + ${startHoursFromNow} * interval '1 hour', now() + ${startHoursFromNow + 2} * interval '1 hour',
             ${extra.mode ?? 'online'}, ${extra.location ?? null}, ${extra.joinUrl ?? null}
      from cohort_courses where id = ${cohortCourseId} returning id
    `
    sessions[key] = row!.id
  }

  beforeAll(async () => {
    ;({ sql, drop } = await createTestDatabase())
    req = client(testApp(sql).app)
    await sql`insert into auth.users (id, email) values (${admin.id}, ${admin.email})`
    adminToken = as(admin.id, admin.email)
    await post('/v1/organisations', { organisationName: 'ALIWA Foundation', fullName: 'Ada Obi' })
    const trainer = (await post('/v1/members', { email: 'ngozi@aliwa.org', firstName: 'Ngozi', lastName: 'Eze', role: 'trainer' })).body.member as { id: string }
    const programmeId = ((await post('/v1/programmes', { name: 'Data & AI Skills' })).body.programme as { id: string }).id
    courseId = ((await post('/v1/courses', { programmeId, name: 'Python for Data Analysis', plannedSessions: 10, defaultLeadMemberId: trainer.id })).body.course as { id: string }).id
    const sqlCourse = ((await post('/v1/courses', { programmeId, name: 'SQL for Data Analysis' })).body.course as { id: string }).id
    cohortId = ((await post('/v1/cohorts', { programmeId, name: 'Cohort 5', startsOn: day(-20), endsOn: day(60), deliveryMode: 'both', courseIds: [courseId, sqlCourse] })).body.cohort as { id: string }).id
    laterCohortId = ((await post('/v1/cohorts', { programmeId, name: 'Cohort 6', startsOn: day(7), endsOn: day(90), deliveryMode: 'online', courseIds: [courseId] })).body.cohort as { id: string }).id
    for (const [key, n, c] of [['chidi', 'Chidi Nwosu', cohortId], ['emeka', 'Emeka Nwosu', laterCohortId], ['bisi', 'Bisi Ade', cohortId]] as const) {
      people[key] = ((await post('/v1/participants', { fullName: n, email: `${key}@example.com`, cohortId: c })).body.participant as { id: string }).id
      const userId = randomUUID()
      await sql`insert into auth.users (id, email) values (${userId}, ${`${key}@example.com`})`
      await sql`update organisation_members set user_id = ${userId}, status = 'active' where id = ${people[key]!}`
      tokens[key] = as(userId, `${key}@example.com`)
    }
    const rows = await sql<{ id: string; cohort_id: string; course_id: string }[]>`select id, cohort_id, course_id from cohort_courses`
    cc = rows.find((r) => r.cohort_id === cohortId && r.course_id === courseId)!.id
    sqlCc = rows.find((r) => r.cohort_id === cohortId && r.course_id === sqlCourse)!.id

    // Two held sessions (one present, one excused), one live now, one tomorrow in person, one cancelled, one next week.
    await addSession('held1', cc, -72)
    await addSession('held2', sqlCc, -48, { mode: 'in_person', location: 'Lab 2' })
    await addSession('live', cc, -1, { joinUrl: 'https://zoom.us/j/123' })
    await addSession('tomorrow', sqlCc, 20, { mode: 'in_person', location: 'Lab 2, Yaba hub' })
    await addSession('cancelled', cc, 30)
    await sql`update sessions set cancelled_at = now(), cancellation_reason = 'Trainer unwell' where id = ${sessions.cancelled!}`
    await addSession('nextWeek', cc, 24 * 7, { joinUrl: 'https://zoom.us/j/999' })
    await req('PUT', `/v1/sessions/${sessions.held1}/attendance`, { token: adminToken, body: { marks: [{ memberId: people.chidi, status: 'present' }] } })
    await req('PUT', `/v1/sessions/${sessions.held2}/attendance`, { token: adminToken, body: { marks: [{ memberId: people.chidi, status: 'excused' }] } })
    await sql`insert into resources (organisation_id, cohort_course_id, session_id, kind, name, url) select organisation_id, id, ${sessions.live!}, 'link', 'pandas documentation', 'https://pandas.pydata.org' from cohort_courses where id = ${cc}`
  })

  afterAll(async () => {
    await drop?.()
  })

  it('builds the dashboard (P2.01)', async () => {
    const res = await get('/v1/my/overview', tokens.chidi!)
    expect(res.body).toMatchObject({
      enrolment: { cohort: { name: 'Cohort 5', status: 'active' }, programme: 'Data & AI Skills' },
      deferred: null,
      nextSession: { id: sessions.live, status: 'in_progress', joinUrl: 'https://zoom.us/j/123', trainer: 'Ngozi Eze' },
      attendance: { present: 1, excused: 1, recorded: 2, rate: 50 },
      progress: { held: 2 },
    })
    expect((res.body.upcoming as { id: string }[]).map((s) => s.id)).toEqual([sessions.live, sessions.tomorrow, sessions.nextWeek])
    expect((res.body.recentAttendance as { attendance: { status: string } }[]).map((s) => s.attendance.status)).toEqual(['excused', 'present'])
  })

  it('shows "before you start" and deferred states (P2.01e, P2.01d)', async () => {
    const before = await get('/v1/my/overview', tokens.emeka!)
    expect(before.body).toMatchObject({ enrolment: { cohort: { name: 'Cohort 6', status: 'upcoming' } }, nextSession: null })

    const enrolment = (await get(`/v1/participants/${people.bisi}`, adminToken)).body.enrolments as { id: string }[]
    await post(`/v1/participants/${people.bisi}/enrolments/${enrolment[0]!.id}/defer`, { reason: 'Personal', notify: false })
    const deferred = await get('/v1/my/overview', tokens.bisi!)
    expect(deferred.body).toMatchObject({ enrolment: null, deferred: { cohort: 'Cohort 5' } })
  })

  it('lists sessions with my attendance; join links only near the time (P4.01, P4.02)', async () => {
    const res = await get('/v1/my/sessions', tokens.chidi!)
    const byId = Object.fromEntries((res.body.sessions as { id: string }[]).map((s) => [s.id, s])) as unknown as Record<string, { status: string; joinUrl: string | null; attendance: { status: string } | null; number: number | null; cancellationReason: string | null }>
    expect(byId[sessions.held1!]).toMatchObject({ status: 'held', attendance: { status: 'present' }, number: 1 })
    expect(byId[sessions.cancelled!]).toMatchObject({ status: 'cancelled', number: null, cancellationReason: 'Trainer unwell' })
    expect(byId[sessions.nextWeek!]!.joinUrl).toBeNull()
    expect(res.body.attendance).toMatchObject({ rate: 50 })

    const detail = await get(`/v1/my/sessions/${sessions.live}`, tokens.chidi!)
    expect(detail.body).toMatchObject({ session: { joinUrl: 'https://zoom.us/j/123', course: { name: 'Python for Data Analysis' } }, resources: [{ name: 'pandas documentation', kind: 'link', url: 'https://pandas.pydata.org' }] })
    // Someone in another cohort can't open it.
    expect((await get(`/v1/my/sessions/${sessions.live}`, tokens.emeka!)).status).toBe(404)
  })

  it('lists my courses and opens one (P3.01, P3.02)', async () => {
    const res = await get('/v1/my/courses', tokens.chidi!)
    const courses = res.body.courses as { name: string; trainer: string | null; attendance: { present: number; excused: number; recorded: number }; nextSession: { id: string } | null }[]
    expect(courses.map((c) => c.name)).toEqual(['Python for Data Analysis', 'SQL for Data Analysis'])
    expect(courses[0]).toMatchObject({ trainer: 'Ngozi Eze', attendance: { present: 1, recorded: 1 }, nextSession: { id: sessions.live } })
    expect(courses[1]).toMatchObject({ trainer: null, attendance: { present: 0, excused: 1, recorded: 1 }, nextSession: { id: sessions.tomorrow } })

    const detail = await get(`/v1/my/courses/${cc}`, tokens.chidi!)
    expect(detail.body).toMatchObject({ course: { name: 'Python for Data Analysis', trainer: { name: 'Ngozi Eze' } }, resources: [{ name: 'pandas documentation' }] })
    expect((detail.body.sessions as unknown[]).length).toBe(4)
    expect((await get(`/v1/my/courses/${cc}`, tokens.emeka!)).status).toBe(404)
  })

  it('updates my profile and notification preferences (P8.01)', async () => {
    const bad = await req('PATCH', '/v1/me', { token: tokens.chidi!, body: { fullName: 'Chidi', phone: 'call me' } })
    expect(bad.status).toBe(400)
    await req('PATCH', '/v1/me', { token: tokens.chidi!, body: { fullName: 'Chidiebere Nwosu', phone: '+234 806 555 0121' } })
    const me = await get('/v1/me', tokens.chidi!)
    expect(me.body.membership).toMatchObject({ firstName: 'Chidiebere', lastName: 'Nwosu', phone: '+234 806 555 0121' })

    const prefs = await get('/v1/me/notification-preferences', tokens.chidi!)
    expect((prefs.body.preferences as { event: string; email: boolean }[]).find((p) => p.event === 'new_resource')).toMatchObject({ email: false, inApp: true })
    await req('PUT', '/v1/me/notification-preferences', { token: tokens.chidi!, body: { preferences: [{ event: 'assignment_due', email: false, inApp: true }, { event: 'made_up', email: true, inApp: true }] } })
    const after = await get('/v1/me/notification-preferences', tokens.chidi!)
    expect((after.body.preferences as { event: string; email: boolean }[]).find((p) => p.event === 'assignment_due')).toMatchObject({ email: false })
    expect((after.body.preferences as unknown[]).length).toBe(5)
  })
})
