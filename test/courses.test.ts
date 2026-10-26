import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/lib/db.js'
import { addDays } from '../src/lib/schedule.js'
import { createTestDatabase, TEST_DATABASE_URL } from './helpers/db.js'
import { as, client, testApp } from './helpers/app.js'

const day = (offset: number) => addDays(new Date().toISOString().slice(0, 10), offset)

type Detail = {
  course: { name: string; plannedSessions: number | null; archivedAt: string | null; defaultLead: { name: string } | null }
  cohorts: { name: string; status: string; held: number; planned: number; trainers: { name: string; lead: boolean }[] }[]
  resources: { id: string; name: string; cohort: string | null; kind: string }[]
  assignments: { title: string; cohort: string }[]
  sessions: { cohort: string }[]
}

describe.skipIf(!TEST_DATABASE_URL)('course detail, edit, archive, resources (A2.02, A2.04–A2.06)', () => {
  let sql: Sql
  let drop: () => Promise<void>
  let t: ReturnType<typeof testApp>
  let req: ReturnType<typeof client>
  const owner = { id: randomUUID(), email: 'ada@aliwa.org' }
  let token: string
  let chidiToken: string
  const ids: Record<string, string> = {}
  const post = (path: string, body: unknown) => req('POST', path, { token, body })
  const get = (path: string, tk = token) => req('GET', path, { token: tk })
  const detail = async () => (await get(`/v1/courses/${ids.course}`)).body as Detail

  beforeAll(async () => {
    ;({ sql, drop } = await createTestDatabase())
    t = testApp(sql)
    req = client(t.app)
    await sql`insert into auth.users (id, email) values (${owner.id}, ${owner.email})`
    token = as(owner.id, owner.email)
    await post('/v1/organisations', { organisationName: 'ALIWA Foundation', fullName: 'Ada Obi' })
    ids.trainer = ((await post('/v1/members', { email: 'ngozi@aliwa.org', fullName: 'Ngozi Eze', role: 'trainer' })).body.member as { id: string }).id
    ids.programme = ((await post('/v1/programmes', { name: 'Data & AI' })).body.programme as { id: string }).id
    ids.course = ((await post('/v1/courses', { programmeId: ids.programme, name: 'Python for Data Analysis', plannedSessions: 10, defaultLeadMemberId: ids.trainer })).body.course as { id: string }).id
    await post('/v1/courses', { programmeId: ids.programme, name: 'SQL Basics' })
    for (const [key, name, start] of [
      ['c5', 'Cohort 5', -20],
      ['c6', 'Cohort 6', 10],
    ] as const) {
      ids[key] = ((await post('/v1/cohorts', { programmeId: ids.programme, name, startsOn: day(start), endsOn: day(start + 60), deliveryMode: 'online', courseIds: [ids.course] })).body
        .cohort as { id: string }).id
    }
    ids.chidi = ((await post('/v1/participants', { fullName: 'Chidi Nwosu', email: 'chidi@example.com', cohortId: ids.c6 })).body.participant as { id: string }).id
    await req('POST', `/v1/invitations/${t.mail.lastToken('chidi@example.com')}/accept`, { body: { password: 'a-strong-password' } })
    const [u] = await sql<{ user_id: string }[]>`select user_id from organisation_members where id = ${ids.chidi!}`
    chidiToken = as(u!.user_id, 'chidi@example.com')
    const [cc] = await sql<{ id: string }[]>`select id from cohort_courses where cohort_id = ${ids.c5!}`
    ids.cc5 = cc!.id
    const [cc6] = await sql<{ id: string }[]>`select id from cohort_courses where cohort_id = ${ids.c6!}`
    ids.cc6 = cc6!.id
    await sql`
      insert into sessions (organisation_id, cohort_course_id, title, starts_at, ends_at)
      select organisation_id, id, 'x', now() - interval '3 days', now() - interval '3 days' + interval '2 hours' from cohort_courses where id = ${ids.cc5!}
    `
  })

  afterAll(async () => {
    await drop?.()
  })

  it('shows where the course runs and what it has (A2.02)', async () => {
    const d = await detail()
    expect(d.course).toMatchObject({ name: 'Python for Data Analysis', plannedSessions: 10, defaultLead: { name: 'Ngozi Eze' }, archivedAt: null })
    expect(d.cohorts.map((x) => [x.name, x.status, x.held, x.planned, x.trainers])).toEqual([
      ['Cohort 5', 'active', 1, 10, [{ name: 'Ngozi Eze', lead: true }]],
      ['Cohort 6', 'upcoming', 0, 10, [{ name: 'Ngozi Eze', lead: true }]],
    ])
    expect(d.sessions.map((s) => s.cohort)).toEqual(['Cohort 5'])
    expect((await get(`/v1/courses/${randomUUID()}`)).status).toBe(404)
  })

  it('edits the course; cohorts that kept its session count follow it (A2.05)', async () => {
    await sql`update cohort_courses set planned_session_count = 12 where id = ${ids.cc6!}`
    const bad = await req('PATCH', `/v1/courses/${ids.course}`, { token, body: { name: 'SQL Basics', plannedSessions: 8 } })
    expect(bad.body.error!.details).toEqual([{ field: 'name', message: 'This programme already has a course with this name.' }])
    const ok = await req('PATCH', `/v1/courses/${ids.course}`, { token, body: { name: 'Python for Data', description: 'Pandas.', plannedSessions: 8, defaultLeadMemberId: null } })
    expect(ok.status).toBe(200)
    const d = await detail()
    expect(d.course).toMatchObject({ name: 'Python for Data', plannedSessions: 8, defaultLead: null })
    expect(d.cohorts.map((x) => [x.name, x.planned])).toEqual([
      ['Cohort 5', 8],
      ['Cohort 6', 12],
    ])
  })

  it('adds course-wide and session resources that participants see (A2.04)', async () => {
    const link = await post(`/v1/courses/${ids.course}/resources`, { kind: 'link', name: 'pandas documentation', url: 'https://pandas.pydata.org/docs', visible: true })
    expect(link.status).toBe(201)
    expect((await post(`/v1/courses/${ids.course}/resources`, { kind: 'link', name: 'x', url: 'not a link' })).body.error!.details).toEqual([
      { field: 'url', message: 'Paste the full link, starting with https://' },
    ])
    const upload = (await post(`/v1/courses/${ids.course}/resources/uploads`, { name: 'Week 1 slides.pdf', size: 2400, type: 'application/pdf' })).body as { upload: { path: string } }
    expect((await post(`/v1/courses/${ids.course}/resources`, { kind: 'file', name: 'Week 1 slides', path: upload.upload.path })).body.error!.details).toEqual([
      { field: 'path', message: 'The file didn’t finish uploading. Choose it again.' },
    ])
    t.files.put(upload.upload.path, 2400)
    expect((await post(`/v1/courses/${ids.course}/resources`, { kind: 'file', name: 'Week 1 slides', path: upload.upload.path, visible: false })).status).toBe(201)
    const [s] = await sql<{ id: string }[]>`select id from sessions where cohort_course_id = ${ids.cc5!}`
    await post(`/v1/courses/${ids.course}/resources`, { kind: 'link', name: 'Session 1 notebook', url: 'https://colab.example/1', sessionId: s!.id })
    expect((await post(`/v1/courses/${ids.course}/resources`, { kind: 'link', name: 'y', url: 'https://y.example', sessionId: randomUUID() })).status).toBe(400)

    const d = await detail()
    expect(d.resources.map((r) => [r.name, r.cohort])).toEqual([
      ['Week 1 slides', null],
      ['pandas documentation', null],
      ['Session 1 notebook', 'Cohort 5'],
    ])
    // Chidi (Cohort 6) sees the course-wide link, not the hidden file or Cohort 5's session link.
    const mine = (await get(`/v1/my/courses/${ids.cc6}`, chidiToken)).body as { resources: { name: string }[] }
    expect(mine.resources.map((r) => r.name)).toEqual(['pandas documentation'])
    const linkId = (link.body.resource as { id: string }).id
    expect(((await get(`/v1/my/resources/${linkId}`, chidiToken)).body as { url: string }).url).toBe('https://pandas.pydata.org/docs')
    // Staff see it on Cohort 5's session too.
    const session = (await get(`/v1/sessions/${s!.id}`)).body as { resources: { name: string }[] }
    expect(session.resources.map((r) => r.name).sort()).toEqual(['Session 1 notebook', 'Week 1 slides', 'pandas documentation'])
    expect((await req('DELETE', `/v1/courses/${ids.course}/resources/${linkId}`, { token })).status).toBe(204)
    expect((await detail()).resources).toHaveLength(2)
  })

  it('archives and restores (A2.06)', async () => {
    expect((await post(`/v1/courses/${ids.course}/archive`, {})).status).toBe(200)
    const list = (await get('/v1/courses')).body.courses as { name: string }[]
    expect(list.map((c) => c.name)).toEqual(['SQL Basics'])
    expect(((await get('/v1/courses?archived=1')).body.courses as { name: string }[]).map((c) => c.name)).toEqual(['Python for Data'])
    // Cohorts that run it keep it.
    expect((await detail()).cohorts).toHaveLength(2)
    expect((await req('PATCH', `/v1/courses/${ids.course}`, { token, body: { name: 'Python', plannedSessions: 8 } })).body.error!.code).toBe('archived')
    await post(`/v1/courses/${ids.course}/restore`, {})
    expect((await detail()).course.archivedAt).toBeNull()
  })
})
