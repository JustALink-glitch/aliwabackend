import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/lib/db.js'
import { createTestDatabase, TEST_DATABASE_URL } from './helpers/db.js'
import { as, client, testApp } from './helpers/app.js'

/** Dates relative to the real today: cohort status uses the database clock. */
function day(offset: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}

describe.skipIf(!TEST_DATABASE_URL)('programmes, courses and cohorts (A1–A3)', () => {
  let sql: Sql
  let drop: () => Promise<void>
  let req: ReturnType<typeof client>
  const owner = { id: randomUUID(), email: 'ada@aliwa.org' }
  const other = { id: randomUUID(), email: 'kofi@other.org' }
  let ownerToken: string
  let otherToken: string
  let trainerId: string
  let adminMemberId: string

  let programmeId: string
  let courseId: string
  let activeCohortId: string
  let upcomingCohortId: string

  beforeAll(async () => {
    ;({ sql, drop } = await createTestDatabase())
    const t = testApp(sql)
    req = client(t.app)
    await sql`insert into auth.users (id, email) values (${owner.id}, ${owner.email}), (${other.id}, ${other.email})`
    ownerToken = as(owner.id, owner.email)
    otherToken = as(other.id, other.email)
    await req('POST', '/v1/organisations', { token: ownerToken, body: { organisationName: 'ALIWA Foundation', fullName: 'Ada Obi' } })
    await req('POST', '/v1/organisations', { token: otherToken, body: { organisationName: 'Other Org', fullName: 'Kofi Mensah' } })
    const trainer = await req('POST', '/v1/members', {
      token: ownerToken,
      body: { email: 'ngozi@aliwa.org', firstName: 'Ngozi', lastName: 'Eze', role: 'trainer' },
    })
    trainerId = (trainer.body.member as { id: string }).id
    const me = await req('GET', '/v1/me', { token: ownerToken })
    adminMemberId = (me.body.membership as { id: string }).id
  })

  afterAll(async () => {
    await drop?.()
  })

  describe('programmes', () => {
    it('starts empty and offers default outcomes', async () => {
      const res = await req('GET', '/v1/programmes', { token: ownerToken })
      expect(res.status).toBe(200)
      expect(res.body.programmes).toEqual([])
      expect(res.body.defaultOutcomes).toContain('Employed')
    })

    it('validates the name and the lead', async () => {
      const blank = await req('POST', '/v1/programmes', { token: ownerToken, body: { name: ' ' } })
      expect(blank.status).toBe(400)
      const trainerLead = await req('POST', '/v1/programmes', { token: ownerToken, body: { name: 'X', leadMemberId: trainerId } })
      expect(trainerLead.status).toBe(400)
      expect(trainerLead.body.error!.details).toEqual([expect.objectContaining({ field: 'leadMemberId' })])
    })

    it('creates a draft programme with a lead and outcomes', async () => {
      const res = await req('POST', '/v1/programmes', {
        token: ownerToken,
        body: {
          name: 'Data & AI Skills Programme',
          description: 'Python, SQL and machine learning',
          leadMemberId: adminMemberId,
          outcomes: ['Employed', 'Internship', 'employed'],
        },
      })
      expect(res.status).toBe(201)
      expect(res.body.programme).toMatchObject({ status: 'draft', lead: { name: 'Ada O.' }, cohorts: { total: 0 } })
      programmeId = (res.body.programme as { id: string }).id

      const detail = await req('GET', `/v1/programmes/${programmeId}`, { token: ownerToken })
      expect(detail.body.outcomes).toEqual(['Employed', 'Internship'])
    })

    it('rejects a duplicate name, whatever the case', async () => {
      const res = await req('POST', '/v1/programmes', { token: ownerToken, body: { name: 'data & ai skills programme' } })
      expect(res.status).toBe(409)
      expect(res.body.error!.code).toBe('name_taken')
    })

    it('edits name and outcomes', async () => {
      const res = await req('PATCH', `/v1/programmes/${programmeId}`, {
        token: ownerToken,
        body: { name: 'Data & AI Skills Programme', description: '', leadMemberId: null, outcomes: ['Internship', 'Freelancing'] },
      })
      expect(res.status).toBe(200)
      expect(res.body.programme).toMatchObject({ description: null, lead: null })
      const detail = await req('GET', `/v1/programmes/${programmeId}`, { token: ownerToken })
      expect(detail.body.outcomes).toEqual(['Internship', 'Freelancing'])
    })

    it('is private to the organisation and to admins', async () => {
      expect((await req('GET', `/v1/programmes/${programmeId}`, { token: otherToken })).status).toBe(404)
      expect((await req('GET', '/v1/programmes', { token: otherToken })).body.programmes).toEqual([])
    })
  })

  describe('courses', () => {
    it('creates a course with a default lead trainer (even before they accept)', async () => {
      const res = await req('POST', '/v1/courses', {
        token: ownerToken,
        body: { programmeId, name: 'Python for Data Analysis', plannedSessions: 10, defaultLeadMemberId: trainerId },
      })
      expect(res.status).toBe(201)
      courseId = (res.body.course as { id: string }).id

      const list = await req('GET', `/v1/courses?programmeId=${programmeId}`, { token: ownerToken })
      expect(list.body.courses).toEqual([
        expect.objectContaining({ name: 'Python for Data Analysis', plannedSessions: 10, defaultLead: { id: trainerId, name: 'Ngozi Eze' }, cohorts: [] }),
      ])
    })

    it('only takes trainers as lead', async () => {
      const res = await req('POST', '/v1/courses', {
        token: ownerToken,
        body: { programmeId, name: 'SQL', defaultLeadMemberId: adminMemberId },
      })
      expect(res.status).toBe(400)
    })
  })

  describe('cohorts', () => {
    it('validates dates', async () => {
      const res = await req('POST', '/v1/cohorts', {
        token: ownerToken,
        body: { programmeId, name: 'Backwards', startsOn: day(10), endsOn: day(1), deliveryMode: 'online' },
      })
      expect(res.status).toBe(400)
      expect(res.body.error!.details).toEqual([expect.objectContaining({ field: 'endsOn' })])
    })

    it('creates an active cohort running the course, with the course lead as trainer', async () => {
      const res = await req('POST', '/v1/cohorts', {
        token: ownerToken,
        body: {
          programmeId,
          name: 'Cohort 5 — Oct 2026',
          startsOn: day(-10),
          endsOn: day(60),
          deliveryMode: 'both',
          usualLocation: 'Yaba hub',
          courseIds: [courseId],
        },
      })
      expect(res.status).toBe(201)
      expect(res.body.cohort).toMatchObject({ status: 'active', plannedSessions: 10, heldSessions: 0, courseNames: ['Python for Data Analysis'] })
      activeCohortId = (res.body.cohort as { id: string }).id

      const detail = await req('GET', `/v1/cohorts/${activeCohortId}`, { token: ownerToken })
      expect(detail.body.courses).toEqual([
        expect.objectContaining({ name: 'Python for Data Analysis', trainers: [expect.objectContaining({ id: trainerId, isLead: true })] }),
      ])

      const trainers = await req('GET', '/v1/members?role=trainer', { token: ownerToken })
      expect(trainers.body.members).toEqual([
        expect.objectContaining({
          teaching: { cohorts: [{ id: activeCohortId, name: 'Cohort 5 — Oct 2026' }], courses: [{ id: courseId, name: 'Python for Data Analysis' }] },
        }),
      ])
    })

    it('creates an upcoming cohort and adds new courses to it', async () => {
      const res = await req('POST', '/v1/cohorts', {
        token: ownerToken,
        body: { programmeId, name: 'Cohort 6 — Jan 2027', startsOn: day(30), endsOn: day(90), deliveryMode: 'online' },
      })
      expect(res.body.cohort).toMatchObject({ status: 'upcoming', courseNames: [] })
      upcomingCohortId = (res.body.cohort as { id: string }).id

      const course = await req('POST', '/v1/courses', {
        token: ownerToken,
        body: { programmeId, name: 'SQL for Data Analysis', plannedSessions: 8, cohortIds: [activeCohortId, upcomingCohortId] },
      })
      expect(course.status).toBe(201)
      const list = await req('GET', '/v1/cohorts', { token: ownerToken })
      const byId = Object.fromEntries((list.body.cohorts as { id: string; plannedSessions: number }[]).map((c) => [c.id, c]))
      expect(byId[activeCohortId]!.plannedSessions).toBe(18)
      expect(byId[upcomingCohortId]!.plannedSessions).toBe(8)
    })

    it('shows the programme as active with its cohort counts', async () => {
      const res = await req('GET', `/v1/programmes/${programmeId}`, { token: ownerToken })
      expect(res.body.programme).toMatchObject({ status: 'active', cohorts: { total: 2, active: 1, upcoming: 1 } })
      expect((res.body.cohorts as unknown[]).length).toBe(2)
      expect((res.body.courses as unknown[]).length).toBe(2)
    })

    it('edits a cohort and removes a course without sessions', async () => {
      const res = await req('PATCH', `/v1/cohorts/${upcomingCohortId}`, {
        token: ownerToken,
        body: { name: 'Cohort 6 — Jan 2027', startsOn: day(31), endsOn: day(91), deliveryMode: 'in_person', usualLocation: 'Lab 1', courseIds: [courseId] },
      })
      expect(res.status).toBe(200)
      expect(res.body.cohort).toMatchObject({ deliveryMode: 'in_person', usualLocation: 'Lab 1', courseNames: ['Python for Data Analysis'] })
    })

    it("can't remove a course that has sessions", async () => {
      const [cc] = await sql<{ id: string }[]>`select id from cohort_courses where cohort_id = ${upcomingCohortId}`
      await sql`
        insert into sessions (organisation_id, cohort_course_id, title, starts_at, ends_at)
        select organisation_id, id, 'Intro', now() + interval '31 days', now() + interval '31 days 2 hours' from cohort_courses where id = ${cc!.id}
      `
      const res = await req('PATCH', `/v1/cohorts/${upcomingCohortId}`, {
        token: ownerToken,
        body: { name: 'Cohort 6 — Jan 2027', startsOn: day(31), endsOn: day(91), deliveryMode: 'online', courseIds: [] },
      })
      expect(res.status).toBe(409)
      expect(res.body.error!.code).toBe('course_has_sessions')
    })

    it("won't archive a programme with running cohorts", async () => {
      const res = await req('POST', `/v1/programmes/${programmeId}/archive`, { token: ownerToken })
      expect(res.status).toBe(409)
      expect(res.body.error!.code).toBe('cohorts_running')
      expect((res.body.error!.details as { cohorts: { name: string }[] }).cohorts.map((c) => c.name)).toEqual([
        'Cohort 5 — Oct 2026',
        'Cohort 6 — Jan 2027',
      ])
    })

    it("won't archive an active cohort, but cancels an upcoming one", async () => {
      expect((await req('POST', `/v1/cohorts/${activeCohortId}/archive`, { token: ownerToken })).status).toBe(409)
      const res = await req('POST', `/v1/cohorts/${upcomingCohortId}/archive`, { token: ownerToken })
      expect(res.status).toBe(200)
      expect(res.body.cohort).toMatchObject({ status: 'archived' })
      expect((await req('PATCH', `/v1/cohorts/${upcomingCohortId}`, {
        token: ownerToken,
        body: { name: 'X', startsOn: day(1), endsOn: day(2), deliveryMode: 'online' },
      })).status).toBe(409)
      const restored = await req('POST', `/v1/cohorts/${upcomingCohortId}/restore`, { token: ownerToken })
      expect(restored.body.cohort).toMatchObject({ status: 'upcoming' })
    })

    it('archives a finished programme with its cohorts, and restores them together', async () => {
      // Finish the active cohort and cancel the upcoming one.
      await sql`update cohorts set starts_on = ${day(-60)}, ends_on = ${day(-1)} where id = ${activeCohortId}`
      await req('POST', `/v1/cohorts/${upcomingCohortId}/archive`, { token: ownerToken })

      const res = await req('POST', `/v1/programmes/${programmeId}/archive`, { token: ownerToken })
      expect(res.status).toBe(200)
      expect(res.body.programme).toMatchObject({ status: 'archived' })
      const cohorts = await req('GET', '/v1/cohorts', { token: ownerToken })
      expect((cohorts.body.cohorts as { status: string }[]).every((c) => c.status === 'archived')).toBe(true)
      expect((await req('POST', `/v1/cohorts/${activeCohortId}/restore`, { token: ownerToken })).body.error!.code).toBe('programme_archived')

      const restore = await req('POST', `/v1/programmes/${programmeId}/restore`, { token: ownerToken })
      expect(restore.body.programme).toMatchObject({ status: 'active' })
      const after = await req('GET', '/v1/cohorts', { token: ownerToken })
      const statuses = Object.fromEntries((after.body.cohorts as { id: string; status: string }[]).map((c) => [c.id, c.status]))
      // The finished cohort comes back; the one cancelled earlier stays archived.
      expect(statuses[activeCohortId]).toBe('completed')
      expect(statuses[upcomingCohortId]).toBe('archived')
    })

    it('trainers cannot manage programmes or cohorts', async () => {
      const trainerUser = randomUUID()
      await sql`insert into auth.users (id, email) values (${trainerUser}, 'ngozi@aliwa.org')`
      await sql`update organisation_members set status = 'active', user_id = ${trainerUser}, joined_at = now() where id = ${trainerId}`
      const trainerToken = as(trainerUser, 'ngozi@aliwa.org')
      expect((await req('GET', '/v1/programmes', { token: trainerToken })).status).toBe(403)
      expect((await req('GET', '/v1/cohorts', { token: trainerToken })).status).toBe(403)
    })
  })
})
