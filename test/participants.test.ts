import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/lib/db.js'
import { createTestDatabase, TEST_DATABASE_URL } from './helpers/db.js'
import { as, client, testApp } from './helpers/app.js'

function day(offset: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}

describe.skipIf(!TEST_DATABASE_URL)('participants (B1)', () => {
  let sql: Sql
  let drop: () => Promise<void>
  let req: ReturnType<typeof client>
  let t: ReturnType<typeof testApp>
  const owner = { id: randomUUID(), email: 'ada@aliwa.org' }
  const other = { id: randomUUID(), email: 'kofi@other.org' }
  let ownerToken: string
  let otherToken: string
  let programmeId: string
  let activeCohort: string
  let upcomingCohort: string
  let finishedCohort: string
  let amaraId: string

  const post = (path: string, body: unknown, token = ownerToken) => req('POST', path, { token, body })

  beforeAll(async () => {
    ;({ sql, drop } = await createTestDatabase())
    t = testApp(sql)
    req = client(t.app)
    await sql`insert into auth.users (id, email) values (${owner.id}, ${owner.email}), (${other.id}, ${other.email})`
    ownerToken = as(owner.id, owner.email)
    otherToken = as(other.id, other.email)
    await post('/v1/organisations', { organisationName: 'ALIWA Foundation', fullName: 'Ada Obi' })
    await post('/v1/organisations', { organisationName: 'Other Org', fullName: 'Kofi Mensah' }, otherToken)
    const programme = await post('/v1/programmes', { name: 'Data & AI Skills' })
    programmeId = (programme.body.programme as { id: string }).id
    const cohort = async (name: string, start: number, end: number) =>
      ((await post('/v1/cohorts', { programmeId, name, startsOn: day(start), endsOn: day(end), deliveryMode: 'online' })).body.cohort as { id: string }).id
    activeCohort = await cohort('Cohort 5', -10, 60)
    upcomingCohort = await cohort('Cohort 6', 30, 90)
    finishedCohort = await cohort('Cohort 3', -120, -30)
  })

  afterAll(async () => {
    await drop?.()
  })

  describe('add participant (B1.02)', () => {
    it('validates name, email and cohort', async () => {
      const res = await post('/v1/participants', { fullName: 'Amara', email: 'nope', cohortId: activeCohort })
      expect(res.status).toBe(400)
      const fields = (res.body.error!.details as { field: string }[]).map((d) => d.field)
      expect(fields).toEqual(expect.arrayContaining(['fullName', 'email']))
    })

    it('invites and enrols a new person', async () => {
      const res = await post('/v1/participants', { fullName: 'Amara  Okafor', email: 'Amara@Example.com', phone: '+234 803 555 0142', cohortId: activeCohort })
      expect(res.status).toBe(201)
      expect(res.body).toMatchObject({ invited: true, emailSent: true })
      amaraId = (res.body.participant as { id: string }).id
      expect(t.mail.sent.at(-1)!.to).toBe('amara@example.com')
      const list = await req('GET', '/v1/participants', { token: ownerToken })
      expect(list.body.participants).toEqual([
        expect.objectContaining({
          firstName: 'Amara',
          lastName: 'Okafor',
          phone: '+234 803 555 0142',
          status: 'invited',
          enrolment: expect.objectContaining({ status: 'active', cohort: expect.objectContaining({ name: 'Cohort 5', status: 'active' }) }),
        }),
      ])
      expect(list.body.summary).toEqual({ inActiveCohorts: 1, inUpcomingCohorts: 0 })
    })

    it('says when they are already in the cohort (B1.02b)', async () => {
      const res = await post('/v1/participants', { fullName: 'Amara Okafor', email: 'amara@example.com', cohortId: activeCohort })
      expect(res.status).toBe(409)
      expect(res.body.error).toMatchObject({ code: 'already_enrolled', details: { cohortName: 'Cohort 5' } })
    })

    it('allows one active cohort at a time by default', async () => {
      const res = await post('/v1/participants', { fullName: 'Amara Okafor', email: 'amara@example.com', cohortId: upcomingCohort })
      expect(res.status).toBe(409)
      expect(res.body.error).toMatchObject({ code: 'one_cohort_only', details: { cohortName: 'Cohort 5', memberId: amaraId } })
    })

    it("won't add to a finished cohort or use another organisation's email", async () => {
      expect((await post('/v1/participants', { fullName: 'Zed Ade', email: 'zed@example.com', cohortId: finishedCohort })).body.error!.code).toBe('cohort_closed')
      const taken = await post('/v1/participants', { fullName: 'Kofi Mensah', email: 'kofi@other.org', cohortId: activeCohort })
      expect(taken.body.error!.code).toBe('email_in_use')
      expect((await post('/v1/participants', { fullName: 'Zed Ade', email: 'zed@example.com', cohortId: activeCohort }, otherToken)).status).toBe(400)
    })
  })

  describe('import (B1.03)', () => {
    const rows = [
      { full_name: 'Aisha Lawal', email: 'aisha@example.com', phone: '' },
      { full_name: 'Kelechi Nnamdi', email: '' },
      { full_name: 'Amara Okafor', email: 'amara@example.com' },
      { full_name: 'Bolaji Adeyemi', email: 'BOLAJI@example.com' },
      { full_name: 'Bolaji Again', email: 'bolaji@example.com' },
      { full_name: 'Mononym', email: 'mono@example.com' },
      { full_name: 'Bad Email', email: 'bad@' },
    ]

    it('reviews rows without saving', async () => {
      const res = await post('/v1/participants/import/preview', { cohortId: activeCohort, rows })
      expect(res.status).toBe(200)
      const summary = (res.body.rows as { row: number; status: string; message: string | null }[]).map((r) => [r.row, r.status, r.message])
      expect(summary).toEqual([
        [1, 'ready', null],
        [2, 'error', 'Email missing'],
        [3, 'error', 'Already in Cohort 5'],
        [4, 'ready', null],
        [5, 'error', 'Same email as row 4'],
        [6, 'error', 'Last name missing'],
        [7, 'error', 'Email not valid'],
      ])
      const list = await req('GET', '/v1/participants', { token: ownerToken })
      expect((list.body.participants as unknown[]).length).toBe(1)
    })

    it('imports the ready rows and emails their invitations', async () => {
      const before = t.mail.sent.length
      const res = await post('/v1/participants/import', { cohortId: activeCohort, fileName: 'cohort-5.csv', rows })
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ added: 2, invited: 2, emailed: 2 })
      expect((res.body.skipped as unknown[]).length).toBe(5)
      expect(t.mail.sent.length - before).toBe(2)
      const cohortList = await req('GET', `/v1/participants?cohortId=${activeCohort}`, { token: ownerToken })
      expect((cohortList.body.participants as { email: string }[]).map((p) => p.email).sort()).toEqual(['aisha@example.com', 'amara@example.com', 'bolaji@example.com'])
      const [logged] = await sql`select data from audit_events where action = 'participants.imported'`
      expect(logged!.data).toMatchObject({ fileName: 'cohort-5.csv', added: 2, skipped: 5 })
    })

    it('caps a file at 500 rows', async () => {
      const big = Array.from({ length: 501 }, (_, i) => ({ full_name: `P ${i}`, email: `p${i}@example.com` }))
      expect((await post('/v1/participants/import/preview', { cohortId: activeCohort, rows: big })).status).toBe(400)
    })
  })

  describe('participant page (B1.04)', () => {
    it('shows details, enrolments and invitation history', async () => {
      const res = await req('GET', `/v1/participants/${amaraId}`, { token: ownerToken })
      expect(res.status).toBe(200)
      expect(res.body.participant).toMatchObject({ email: 'amara@example.com', status: 'invited', invitationExpiresAt: expect.any(String) })
      expect(res.body.enrolments).toEqual([expect.objectContaining({ status: 'active', cohort: expect.objectContaining({ name: 'Cohort 5' }) })])
      const actions = (res.body.history as { action: string }[]).map((h) => h.action)
      expect(actions).toEqual(expect.arrayContaining(['member.invited', 'participant.enrolled']))
      expect((await req('GET', `/v1/participants/${amaraId}`, { token: otherToken })).status).toBe(404)
    })

    it('edits details; a new email gets a fresh link', async () => {
      const before = t.mail.sent.length
      const res = await req('PATCH', `/v1/participants/${amaraId}`, {
        token: ownerToken,
        body: { fullName: 'Amara Grace Okafor', email: 'amara.okafor@example.com', phone: null },
      })
      expect(res.status).toBe(200)
      expect(res.body.emailSent).toBe(true)
      expect(t.mail.sent.length - before).toBe(1)
      expect(t.mail.sent.at(-1)!.to).toBe('amara.okafor@example.com')
      const detail = await req('GET', `/v1/participants/${amaraId}`, { token: ownerToken })
      expect(detail.body.participant).toMatchObject({ firstName: 'Amara Grace', lastName: 'Okafor', phone: null })
    })
  })

  describe('enrolment changes (B1.05)', () => {
    const enrolmentOf = async (memberId: string) => {
      const res = await req('GET', `/v1/participants/${memberId}`, { token: ownerToken })
      return res.body.enrolments as { id: string; status: string; cohort: { name: string }; reason: string | null }[]
    }

    it('defers into an upcoming cohort', async () => {
      const [current] = await enrolmentOf(amaraId)
      const res = await post(`/v1/participants/${amaraId}/enrolments/${current!.id}/defer`, {
        reason: 'Work commitments',
        note: 'Starting a new job',
        toCohortId: upcomingCohort,
        effectiveOn: day(0),
      })
      expect(res.status).toBe(200)
      const after = await enrolmentOf(amaraId)
      expect(after.map((e) => [e.cohort.name, e.status])).toEqual([
        ['Cohort 6', 'active'],
        ['Cohort 5', 'deferred'],
      ])
      expect(t.mail.sent.at(-1)!.subject).toContain('deferred')
      // A deferred enrolment can't be changed again.
      expect((await post(`/v1/participants/${amaraId}/enrolments/${current!.id}/withdraw`, { reason: 'Other' })).status).toBe(409)
    })

    it("won't defer into a cohort that has started", async () => {
      const list = await req('GET', '/v1/participants', { token: ownerToken })
      const aisha = (list.body.participants as { id: string; email: string }[]).find((p) => p.email === 'aisha@example.com')!
      const [enrolment] = await enrolmentOf(aisha.id)
      const res = await post(`/v1/participants/${aisha.id}/enrolments/${enrolment!.id}/defer`, { reason: 'Health', toCohortId: activeCohort })
      expect(res.status).toBe(400)
    })

    it('transfers to another cohort', async () => {
      const list = await req('GET', '/v1/participants', { token: ownerToken })
      const bolaji = (list.body.participants as { id: string; email: string }[]).find((p) => p.email === 'bolaji@example.com')!
      const [enrolment] = await enrolmentOf(bolaji.id)
      const res = await post(`/v1/participants/${bolaji.id}/enrolments/${enrolment!.id}/transfer`, { toCohortId: upcomingCohort, reason: 'Weekends only', notify: false })
      expect(res.status).toBe(200)
      expect((await enrolmentOf(bolaji.id)).map((e) => [e.cohort.name, e.status])).toEqual([
        ['Cohort 6', 'active'],
        ['Cohort 5', 'transferred'],
      ])
    })

    it('withdraws, and counts only active people in the cohort', async () => {
      const list = await req('GET', '/v1/participants', { token: ownerToken })
      const aisha = (list.body.participants as { id: string; email: string }[]).find((p) => p.email === 'aisha@example.com')!
      const [enrolment] = await enrolmentOf(aisha.id)
      expect((await post(`/v1/participants/${aisha.id}/enrolments/${enrolment!.id}/withdraw`, { reason: 'Found employment', note: 'Took a job offer' })).status).toBe(200)
      expect((await enrolmentOf(aisha.id))[0]).toMatchObject({ status: 'withdrawn', reason: 'Found employment' })

      const cohorts = await req('GET', '/v1/cohorts', { token: ownerToken })
      const counts = Object.fromEntries((cohorts.body.cohorts as { name: string; participants: number }[]).map((c) => [c.name, c.participants]))
      expect(counts).toMatchObject({ 'Cohort 5': 0, 'Cohort 6': 2 })
      const summary = (await req('GET', '/v1/participants', { token: ownerToken })).body.summary
      expect(summary).toEqual({ inActiveCohorts: 0, inUpcomingCohorts: 2 })
    })

    it("won't change a joined participant's email here", async () => {
      const list = await req('GET', '/v1/participants', { token: ownerToken })
      const bolaji = (list.body.participants as { id: string; email: string }[]).find((p) => p.email === 'bolaji@example.com')!
      const user = randomUUID()
      await sql`insert into auth.users (id, email) values (${user}, 'bolaji@example.com')`
      await sql`update organisation_members set status = 'active', user_id = ${user}, joined_at = now() where id = ${bolaji.id}`
      const res = await req('PATCH', `/v1/participants/${bolaji.id}`, { token: ownerToken, body: { fullName: 'Bolaji Adeyemi', email: 'new@example.com' } })
      expect(res.status).toBe(409)
      expect(res.body.error!.code).toBe('email_locked')
      const ok = await req('PATCH', `/v1/participants/${bolaji.id}`, { token: ownerToken, body: { fullName: 'Bolaji A. Adeyemi', email: 'bolaji@example.com', phone: '080' } })
      expect(ok.status).toBe(200)
    })
  })
})
