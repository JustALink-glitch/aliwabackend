import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/lib/db.js'
import { addDays } from '../src/lib/schedule.js'
import { createTestDatabase, TEST_DATABASE_URL } from './helpers/db.js'
import { as, client, testApp } from './helpers/app.js'

const day = (offset: number) => addDays(new Date().toISOString().slice(0, 10), offset)

type Detail = {
  member: { status: string; email: string; phone: string | null; firstName: string }
  assignments: { course: { name: string }; cohort: { name: string }; lead: boolean; held: number; planned: number }[]
  reports: { status: string }[]
}

describe.skipIf(!TEST_DATABASE_URL)('trainer assign, edit, deactivate (B2.04–B2.06)', () => {
  let sql: Sql
  let drop: () => Promise<void>
  let t: ReturnType<typeof testApp>
  let req: ReturnType<typeof client>
  const owner = { id: randomUUID(), email: 'ada@aliwa.org' }
  let token: string
  let ngoziToken: string
  const ids: Record<string, string> = {}
  const post = (path: string, body: unknown) => req('POST', path, { token, body })
  const detail = async (id = ids.ngozi) => (await req('GET', `/v1/members/${id}`, { token })).body as Detail

  beforeAll(async () => {
    ;({ sql, drop } = await createTestDatabase())
    t = testApp(sql)
    req = client(t.app)
    await sql`insert into auth.users (id, email) values (${owner.id}, ${owner.email})`
    token = as(owner.id, owner.email)
    await post('/v1/organisations', { organisationName: 'ALIWA Foundation', fullName: 'Ada Obi' })
    for (const [key, name, email] of [
      ['ngozi', 'Ngozi Eze', 'ngozi@aliwa.org'],
      ['tunde', 'Tunde Adeyemi', 'tunde@aliwa.org'],
    ] as const) {
      ids[key] = ((await post('/v1/members', { email, fullName: name, role: 'trainer' })).body.member as { id: string }).id
    }
    await req('POST', `/v1/invitations/${t.mail.lastToken('ngozi@aliwa.org')}/accept`, { body: { password: 'a-strong-password' } })
    const [u] = await sql<{ user_id: string }[]>`select user_id from organisation_members where id = ${ids.ngozi!}`
    ngoziToken = as(u!.user_id, 'ngozi@aliwa.org')
    ids.programme = ((await post('/v1/programmes', { name: 'Data & AI' })).body.programme as { id: string }).id
    ids.python = ((await post('/v1/courses', { programmeId: ids.programme, name: 'Python', plannedSessions: 10, defaultLeadMemberId: ids.tunde })).body.course as { id: string }).id
    ids.cohort = ((await post('/v1/cohorts', { programmeId: ids.programme, name: 'Cohort 5', startsOn: day(-20), endsOn: day(60), deliveryMode: 'online', courseIds: [ids.python] })).body.cohort as {
      id: string
    }).id
  })

  afterAll(async () => {
    await drop?.()
  })

  it('assigns as lead, moving the old lead to assistant (B2.04)', async () => {
    const res = await post(`/v1/members/${ids.ngozi}/assignments`, { cohortId: ids.cohort, courseId: ids.python, role: 'lead' })
    expect(res.body).toEqual({ course: 'Python', cohort: 'Cohort 5', replaced: 'Tunde Adeyemi' })
    expect((await detail()).assignments.map((a) => [a.course.name, a.cohort.name, a.lead, a.planned])).toEqual([['Python', 'Cohort 5', true, 10]])
    expect((await detail(ids.tunde)).assignments.map((a) => a.lead)).toEqual([false])
    expect((await post(`/v1/members/${ids.ngozi}/assignments`, { cohortId: ids.cohort, courseId: randomUUID(), role: 'lead' })).body.error!.details).toEqual([
      { field: 'courseId', message: 'Choose a course this cohort runs.' },
    ])
    await sql`update organisation_settings set assistants_enabled = false`
    expect((await post(`/v1/members/${ids.tunde}/assignments`, { cohortId: ids.cohort, courseId: ids.python, role: 'assistant' })).body.error!.code).toBe('assistants_off')
    await sql`update organisation_settings set assistants_enabled = true`
    const [cc] = await sql<{ id: string }[]>`select id from cohort_courses where cohort_id = ${ids.cohort!}`
    expect((await req('DELETE', `/v1/members/${ids.tunde}/assignments/${cc!.id}`, { token })).status).toBe(204)
    expect((await detail(ids.tunde)).assignments).toEqual([])
  })

  it('edits details, changing the sign-in email (B2.05)', async () => {
    expect((await req('PATCH', `/v1/members/${ids.ngozi}`, { token, body: { fullName: 'Ngozi Eze', email: 'ada@aliwa.org', phone: null } })).body.error!.code).toBe('email_in_use')
    const ok = await req('PATCH', `/v1/members/${ids.ngozi}`, { token, body: { fullName: 'Ngozi A. Eze', email: 'ngozi.eze@aliwa.org', phone: '+234 802 555 0187' } })
    expect(ok.status).toBe(200)
    expect((await detail()).member).toMatchObject({ firstName: 'Ngozi A.', email: 'ngozi.eze@aliwa.org', phone: '+234 802 555 0187' })
    expect(await sql`select email from auth.users where email = 'ngozi.eze@aliwa.org'`).toHaveLength(1)
    expect(t.mail.sent.at(-1)).toMatchObject({ to: 'ngozi.eze@aliwa.org', subject: 'Your Synqop sign-in email changed' })
  })

  it('deactivates and reactivates (B2.06)', async () => {
    const [s] = await sql<{ id: string }[]>`
      insert into sessions (organisation_id, cohort_course_id, title, starts_at, ends_at, trainer_member_id)
      select organisation_id, id, 'x', now() + interval '2 days', now() + interval '2 days 2 hours', ${ids.ngozi!} from cohort_courses where cohort_id = ${ids.cohort!} returning id
    `
    expect((await post(`/v1/members/${ids.tunde}/deactivate`, { notify: false })).body.error!.code).toBe('not_active')
    expect((await post(`/v1/members/${ids.ngozi}/deactivate`, { notify: true })).status).toBe(200)
    expect(t.mail.sent.at(-1)!.subject).toBe('Your access to ALIWA Foundation has ended')
    expect((await req('GET', '/v1/me', { token: ngoziToken })).body.error!.code).toBe('access_ended')
    expect(await sql`select trainer_member_id from sessions where id = ${s!.id}`).toEqual([{ trainer_member_id: null }])
    // Still assigned, so reactivating brings her courses back.
    expect((await detail()).member.status).toBe('deactivated')
    expect((await post(`/v1/members/${ids.ngozi}/assignments`, { cohortId: ids.cohort, courseId: ids.python, role: 'lead' })).body.error!.code).toBe('deactivated')
    expect((await post(`/v1/members/${ids.ngozi}/reactivate`, {})).status).toBe(200)
    expect((await req('GET', '/v1/me', { token: ngoziToken })).status).toBe(200)
    expect((await detail()).assignments).toHaveLength(1)
  })
})
