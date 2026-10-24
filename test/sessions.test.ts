import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/lib/db.js'
import { addDays, weekdayOf } from '../src/lib/schedule.js'
import { createTestDatabase, TEST_DATABASE_URL } from './helpers/db.js'
import { as, client, testApp } from './helpers/app.js'

const today = () => new Date().toISOString().slice(0, 10)
const day = (offset: number) => addDays(today(), offset)

describe.skipIf(!TEST_DATABASE_URL)('sessions (C1)', () => {
  let sql: Sql
  let drop: () => Promise<void>
  let req: ReturnType<typeof client>
  let t: ReturnType<typeof testApp>
  const owner = { id: randomUUID(), email: 'ada@aliwa.org' }
  let token: string
  let cohortId: string
  let courseId: string
  let otherCourseId: string
  let trainerId: string
  let firstId: string
  let ids: string[] = []

  const post = (path: string, body: unknown) => req('POST', path, { token, body })
  const base = () => ({ cohortId, courseId, trainerMemberId: trainerId, start: '10:00', end: '12:00', mode: 'online' as const })

  beforeAll(async () => {
    ;({ sql, drop } = await createTestDatabase())
    t = testApp(sql)
    req = client(t.app)
    await sql`insert into auth.users (id, email) values (${owner.id}, ${owner.email})`
    token = as(owner.id, owner.email)
    await post('/v1/organisations', { organisationName: 'ALIWA Foundation', fullName: 'Ada Obi' })
    trainerId = ((await post('/v1/members', { email: 'ngozi@aliwa.org', firstName: 'Ngozi', lastName: 'Eze', role: 'trainer' })).body.member as { id: string }).id
    const programmeId = ((await post('/v1/programmes', { name: 'Data & AI' })).body.programme as { id: string }).id
    courseId = ((await post('/v1/courses', { programmeId, name: 'Python', plannedSessions: 10, defaultLeadMemberId: trainerId })).body.course as { id: string }).id
    otherCourseId = ((await post('/v1/courses', { programmeId, name: 'SQL' })).body.course as { id: string }).id
    cohortId = ((await post('/v1/cohorts', { programmeId, name: 'Cohort 5', startsOn: day(-30), endsOn: day(60), deliveryMode: 'online', courseIds: [courseId] })).body.cohort as { id: string }).id
    await post('/v1/participants', { fullName: 'Amara Okafor', email: 'amara@example.com', cohortId })
  })

  afterAll(async () => {
    await drop?.()
  })

  describe('scheduling (C1.02)', () => {
    it('checks the course, trainer, times and place', async () => {
      const notInCohort = await post('/v1/sessions', { ...base(), courseId: otherCourseId, date: day(1) })
      expect(notInCohort.body.error!.details).toEqual([expect.objectContaining({ field: 'courseId' })])
      const backwards = await post('/v1/sessions', { ...base(), date: day(1), start: '12:00', end: '10:00' })
      expect(backwards.body.error!.details).toEqual([expect.objectContaining({ field: 'end' })])
      const noPlace = await post('/v1/sessions', { ...base(), date: day(1), mode: 'in_person' })
      expect(noPlace.body.error!.details).toEqual([expect.objectContaining({ field: 'location' })])
      const badLink = await post('/v1/sessions', { ...base(), date: day(1), joinUrl: 'zoom.us/j/1' })
      expect(badLink.status).toBe(400)
      const notTrainer = await post('/v1/sessions', { ...base(), trainerMemberId: randomUUID(), date: day(1) })
      expect(notTrainer.body.error!.details).toEqual([expect.objectContaining({ field: 'trainerMemberId' })])
    })

    it('keeps sessions inside the cohort dates', async () => {
      const res = await post('/v1/sessions', { ...base(), date: day(50), repeat: { weekdays: [weekdayOf(day(50))], count: 4 } })
      expect(res.status).toBe(400)
      expect(res.body.error!.message).toBe('Some fields need attention.')
      expect((res.body.error!.details as { message: string }[])[0]!.message).toContain('2 of 4 sessions fall outside Cohort 5')
    })

    it('creates a weekly series at local times', async () => {
      const start = day(1)
      const res = await post('/v1/sessions', {
        ...base(),
        date: start,
        joinUrl: 'https://zoom.us/j/83455219087',
        repeat: { weekdays: [weekdayOf(start), weekdayOf(day(3))], count: 4 },
      })
      expect(res.status).toBe(201)
      expect(res.body.created).toBe(4)
      firstId = res.body.firstSessionId as string

      const list = await req('GET', `/v1/sessions?from=${day(0)}&to=${day(14)}`, { token })
      const sessions = list.body.sessions as { id: string; startsAt: string; number: number; total: number; joinUrl: string; series: { sessions: number } }[]
      expect(sessions).toHaveLength(4)
      ids = sessions.map((s) => s.id)
      // Africa/Lagos is UTC+1, so 10:00 there is 09:00 UTC.
      expect(sessions[0]!.startsAt).toBe(`${start}T09:00:00.000Z`)
      expect(sessions.map((s) => s.number)).toEqual([1, 2, 3, 4])
      expect(sessions[0]).toMatchObject({ total: 10, joinUrl: 'https://zoom.us/j/83455219087', series: { sessions: 4 } })
    })

    it('shows a session with its trainer, series and who is expected', async () => {
      const res = await req('GET', `/v1/sessions/${firstId}`, { token })
      expect(res.body.session).toMatchObject({
        title: 'Python',
        status: 'scheduled',
        number: 1,
        expected: 1,
        trainer: { id: trainerId, name: 'Ngozi Eze', isLead: true },
        series: { weekdays: expect.any(Array) },
        attendance: { recorded: 0 },
        report: { submittedAt: null },
      })
      // The cohort's next session date shows on the cohort page.
      const cohort = await req('GET', `/v1/cohorts/${cohortId}`, { token })
      expect((cohort.body.courses as { firstSessionAt: string | null }[])[0]!.firstSessionAt).not.toBeNull()
    })
  })

  describe('editing (C1.04, C1.06)', () => {
    it('moves only this session to another date', async () => {
      const res = await req('PATCH', `/v1/sessions/${ids[1]}`, {
        token,
        body: { scope: 'this', date: day(5), start: '14:00', end: '16:00', mode: 'in_person', location: 'Lab 2', trainerMemberId: trainerId },
      })
      expect(res.status).toBe(200)
      expect(res.body.updated).toBe(1)
      const moved = await req('GET', `/v1/sessions/${ids[1]}`, { token })
      expect(moved.body.session).toMatchObject({ startsAt: `${day(5)}T13:00:00.000Z`, mode: 'in_person', location: 'Lab 2', joinUrl: null })
    })

    it('changes the time for this and following sessions, keeping their dates', async () => {
      const before = await req('GET', `/v1/sessions/${ids[2]}`, { token })
      const date = (before.body.session as { startsAt: string }).startsAt.slice(0, 10)
      const res = await req('PATCH', `/v1/sessions/${ids[2]}`, {
        token,
        body: { scope: 'following', date, start: '11:00', end: '13:00', mode: 'online', trainerMemberId: trainerId, notify: true },
      })
      expect(res.body.updated).toBeGreaterThanOrEqual(2)
      const list = await req('GET', `/v1/sessions?from=${day(0)}&to=${day(14)}`, { token })
      const byId = Object.fromEntries((list.body.sessions as { id: string; startsAt: string }[]).map((s) => [s.id, s.startsAt]))
      expect(byId[ids[0]!]!.slice(11, 16)).toBe('09:00')
      expect(byId[ids[2]!]!.slice(11, 16)).toBe('10:00')
      expect(byId[ids[3]!]!.slice(11, 16)).toBe('10:00')
      expect(t.mail.sent.at(-1)!.subject).toBe('Python: session changed')
    })

    it('changes dates one session at a time', async () => {
      const res = await req('PATCH', `/v1/sessions/${ids[3]}`, {
        token,
        body: { scope: 'all', date: day(40), start: '10:00', end: '12:00', mode: 'online' },
      })
      expect(res.body.error!.details).toEqual([expect.objectContaining({ field: 'date' })])
    })
  })

  describe('cancelling (C1.05) and held sessions', () => {
    it('needs a reason, then cancels and emails participants and the trainer', async () => {
      expect((await post(`/v1/sessions/${ids[0]}/cancel`, { reason: ' ' })).status).toBe(400)
      const before = t.mail.sent.length
      const res = await post(`/v1/sessions/${ids[0]}/cancel`, { reason: 'Public holiday' })
      expect(res.body).toEqual({ cancelled: true, emailed: 2 })
      expect(t.mail.sent.length - before).toBe(2)
      expect(t.mail.sent.at(-1)!.text).toContain('Public holiday')
      const detail = await req('GET', `/v1/sessions/${ids[0]}`, { token })
      expect(detail.body.session).toMatchObject({ status: 'cancelled', number: null, cancelled: { reason: 'Public holiday', by: 'Ada Obi' } })
      // The remaining sessions renumber from 1.
      const list = await req('GET', `/v1/sessions?from=${day(0)}&to=${day(14)}`, { token })
      expect((list.body.sessions as { number: number | null }[]).filter((s) => s.number).map((s) => s.number)).toEqual([1, 2, 3])
    })

    it('never changes held sessions, and asks for their attendance', async () => {
      const [cc] = await sql<{ id: string }[]>`select id from cohort_courses where cohort_id = ${cohortId}`
      const [held] = await sql<{ id: string }[]>`
        insert into sessions (organisation_id, cohort_course_id, title, starts_at, ends_at)
        select organisation_id, id, 'Python', now() - interval '2 days', now() - interval '2 days' + interval '2 hours'
        from cohort_courses where id = ${cc!.id} returning id
      `
      expect((await post(`/v1/sessions/${held!.id}/cancel`, { reason: 'x' })).status).toBe(409)
      expect((await req('PATCH', `/v1/sessions/${held!.id}`, { token, body: { date: day(-2), start: '10:00', end: '12:00', mode: 'online' } })).status).toBe(409)
      const list = await req('GET', `/v1/sessions?from=${day(0)}&to=${day(7)}`, { token })
      expect((list.body.attendanceToConfirm as { id: string }[]).map((s) => s.id)).toEqual([held!.id])
      const cohorts = await req('GET', '/v1/cohorts', { token })
      expect((cohorts.body.cohorts as { heldSessions: number }[])[0]!.heldSessions).toBe(1)
    })
  })
})
