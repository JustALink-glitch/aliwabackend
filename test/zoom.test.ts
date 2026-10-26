import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/lib/db.js'
import { addDays } from '../src/lib/schedule.js'
import { syncZoom, type ZoomSyncDeps } from '../src/lib/zoom-sync.js'
import { tokenBox, ZoomError, type MeetingInput, type ZoomApi, type ZoomParticipant } from '../src/lib/zoom.js'
import { createTestDatabase, TEST_DATABASE_URL } from './helpers/db.js'
import { as, client, testApp } from './helpers/app.js'

const day = (offset: number) => addDays(new Date().toISOString().slice(0, 10), offset)

/** A Zoom stand-in that records what Synqop asked for. */
function fakeZoom() {
  const calls: string[] = []
  const meetings = new Map<string, MeetingInput>()
  const reports = new Map<string, ZoomParticipant[] | null>()
  let n = 0
  let refreshes = 0
  let failWith: ZoomError | null = null
  const check = () => {
    if (failWith) throw failWith
  }
  const api: ZoomApi = {
    authorizeUrl: (state) => `https://zoom.us/oauth/authorize?state=${encodeURIComponent(state)}`,
    async exchangeCode(code) {
      if (code !== 'good-code') throw new ZoomError(400, 'invalid_request', 'Bad code')
      return { accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 3600, scopes: ['meeting:write:meeting'] }
    },
    async refresh(token) {
      check()
      refreshes++
      return { accessToken: `access-r${refreshes}`, refreshToken: `${token}-r${refreshes}`, expiresIn: 3600, scopes: [] }
    },
    async revoke() {
      calls.push('revoke')
    },
    async me() {
      return { email: 'zoom@aliwa.org', accountId: 'acc-1' }
    },
    async createMeeting(_t, input) {
      check()
      const id = String(++n)
      meetings.set(id, input)
      calls.push(`create ${id}`)
      return { id, joinUrl: `https://zoom.us/j/${id}` }
    },
    async updateMeeting(_t, id, input) {
      check()
      meetings.set(id, input)
      calls.push(`update ${id}`)
    },
    async deleteMeeting(_t, id) {
      check()
      meetings.delete(id)
      calls.push(`delete ${id}`)
    },
    async addRegistrant(_t, id, person) {
      check()
      calls.push(`register ${id} ${person.email}`)
      return { registrantId: `r-${person.email}`, joinUrl: `https://zoom.us/w/${id}?tk=${person.email}` }
    },
    async participants(_t, id) {
      check()
      return reports.has(id) ? reports.get(id)! : null
    },
  }
  return {
    api,
    calls,
    meetings,
    reports,
    get refreshes() {
      return refreshes
    },
    fail(e: ZoomError | null) {
      failWith = e
    },
  }
}

describe.skipIf(!TEST_DATABASE_URL)('Zoom (F1.07, C1.02, C2.01, C2.04)', () => {
  let sql: Sql
  let drop: () => Promise<void>
  const zoom = fakeZoom()
  const box = tokenBox('zoom-client-secret-for-tests')
  let t: ReturnType<typeof testApp>
  let req: ReturnType<typeof client>
  let deps: ZoomSyncDeps
  const owner = { id: randomUUID(), email: 'ada@aliwa.org' }
  let token: string
  let chidiToken: string
  const ids: Record<string, string> = {}
  const post = (path: string, body: unknown, tk = token) => req('POST', path, { token: tk, body })
  const get = (path: string, tk = token) => req('GET', path, { token: tk })
  const sync = (now = new Date()) => syncZoom(deps, ids.org!, now)
  const at = (h: number) => new Date(Date.now() + h * 3_600_000)

  beforeAll(async () => {
    ;({ sql, drop } = await createTestDatabase())
    t = testApp(sql, { zoom: zoom.api, zoomBox: box })
    req = client(t.app)
    deps = { sql, mailer: t.mail.mailer, appUrl: 'http://localhost:5173', zoom: zoom.api, box }
    await sql`insert into auth.users (id, email) values (${owner.id}, ${owner.email})`
    token = as(owner.id, owner.email)
    await post('/v1/organisations', { organisationName: 'ALIWA Foundation', fullName: 'Ada Obi' })
    const [org] = await sql<{ id: string }[]>`select id from organisations`
    ids.org = org!.id
    const trainer = (await post('/v1/members', { email: 'ngozi@aliwa.org', fullName: 'Ngozi Eze', role: 'trainer' })).body.member as { id: string }
    await req('POST', `/v1/invitations/${t.mail.lastToken('ngozi@aliwa.org')}/accept`, { body: { password: 'a-strong-password' } })
    ids.trainer = trainer.id
    const programme = ((await post('/v1/programmes', { name: 'Data & AI' })).body.programme as { id: string }).id
    ids.course = ((await post('/v1/courses', { programmeId: programme, name: 'Python for Data Analysis', defaultLeadMemberId: trainer.id })).body.course as { id: string }).id
    ids.cohort = ((await post('/v1/cohorts', { programmeId: programme, name: 'Cohort 5', startsOn: day(-20), endsOn: day(60), deliveryMode: 'online', courseIds: [ids.course] })).body
      .cohort as { id: string }).id
    for (const [key, name, email] of [
      ['chidi', 'Chidi Nwosu', 'chidi@example.com'],
      ['amara', 'Amara Okafor', 'amara@example.com'],
      ['tobi', 'Tobi Adewale', 'tobi@example.com'],
      ['bisi', 'Bisi Ade', 'bisi@example.com'],
    ] as const) {
      ids[key] = ((await post('/v1/participants', { fullName: name, email, cohortId: ids.cohort })).body.participant as { id: string }).id
    }
    await req('POST', `/v1/invitations/${t.mail.lastToken('chidi@example.com')}/accept`, { body: { password: 'a-strong-password' } })
    const [u] = await sql<{ user_id: string }[]>`select user_id from organisation_members where id = ${ids.chidi!}`
    chidiToken = as(u!.user_id, 'chidi@example.com')
  })

  afterAll(async () => {
    await drop?.()
  })

  it('connects with OAuth and keeps tokens encrypted (F1.07)', async () => {
    expect(((await get('/v1/settings/attendance')).body.settings as { zoom: unknown }).zoom).toMatchObject({ available: true, connected: false })
    const { url } = (await post('/v1/zoom/connect', {})).body as { url: string }
    const state = new URL(url).searchParams.get('state')!
    // Tampered or missing state, or a refused code, never connects.
    expect((await t.app.request(`/v1/zoom/callback?code=good-code&state=${state}x`)).headers.get('location')).toBe('http://localhost:5173/admin/settings/attendance?zoom=error')
    expect((await t.app.request(`/v1/zoom/callback?error=access_denied`)).headers.get('location')).toMatch(/zoom=cancelled$/)
    expect((await t.app.request(`/v1/zoom/callback?code=bad&state=${encodeURIComponent(state)}`)).headers.get('location')).toMatch(/zoom=error$/)
    const ok = await t.app.request(`/v1/zoom/callback?code=good-code&state=${encodeURIComponent(state)}`)
    expect(ok.status).toBe(302)
    expect(ok.headers.get('location')).toBe('http://localhost:5173/admin/settings/attendance?zoom=connected')
    const [conn] = await sql<{ refresh_token_enc: string; zoom_user_email: string }[]>`select refresh_token_enc, zoom_user_email from zoom_connections`
    expect(conn!.refresh_token_enc).not.toContain('refresh-1')
    expect(box.open(conn!.refresh_token_enc)).toBe('refresh-1')
    expect(((await get('/v1/settings/attendance')).body.settings as { zoom: unknown }).zoom).toMatchObject({ connected: true, email: 'zoom@aliwa.org', problem: null })
    // Without Zoom keys on the server, connecting says so.
    expect((await client(testApp(sql).app)('POST', '/v1/zoom/connect', { token, body: {} })).body.error!.code).toBe('zoom_not_configured')
  })

  it('creates a meeting for each online session and registers participants for personal links (C1.02)', async () => {
    const res = await post('/v1/sessions', { cohortId: ids.cohort, courseId: ids.course, date: day(2), start: '10:00', end: '12:00', mode: 'online' })
    ids.session = (res.body as { firstSessionId: string }).firstSessionId
    await post('/v1/sessions', { cohortId: ids.cohort, courseId: ids.course, date: day(3), start: '10:00', end: '12:00', mode: 'online', joinUrl: 'https://meet.example/x' })
    expect(((await get(`/v1/sessions/${ids.session}`)).body.session as { zoom: unknown }).zoom).toMatchObject({ pending: true, managed: false })
    const counts = await sync()
    expect(counts).toMatchObject({ created: 1, registered: 4 })
    expect(zoom.meetings.get('1')).toMatchObject({ topic: 'Python for Data Analysis · Cohort 5', durationMinutes: 120, registration: true, timeZone: 'Africa/Lagos' })
    const detail = (await get(`/v1/sessions/${ids.session}`)).body.session as { joinUrl: string; zoom: unknown }
    expect(detail).toMatchObject({ joinUrl: 'https://zoom.us/j/1', zoom: { managed: true, pending: false } })
    // Chidi joins with his own link; a session with a pasted link is left alone.
    const mine = await sql`update sessions set starts_at = now() - interval '5 minutes', ends_at = now() + interval '2 hours' where id = ${ids.session!} returning id`
    expect(mine).toHaveLength(1)
    expect(((await get(`/v1/my/sessions/${ids.session}`, chidiToken)).body.session as { joinUrl: string }).joinUrl).toBe('https://zoom.us/w/1?tk=chidi@example.com')
    await sql`update sessions set starts_at = ${at(48)}, ends_at = ${at(50)} where id = ${ids.session!}`
    expect(zoom.calls.filter((c) => c.startsWith('create'))).toEqual(['create 1'])
    expect((await sync()).registered).toBe(0)
  })

  it('moves the meeting when the time changes and removes it when cancelled or replaced', async () => {
    await req('PATCH', `/v1/sessions/${ids.session}`, { token, body: { date: day(2), start: '11:00', end: '12:30', mode: 'online', joinUrl: 'https://zoom.us/j/1' } })
    expect((await sync()).updated).toBe(1)
    expect(zoom.meetings.get('1')!.durationMinutes).toBe(90)
    // Pasting another link replaces Synqop's meeting.
    await req('PATCH', `/v1/sessions/${ids.session}`, { token, body: { date: day(2), start: '11:00', end: '12:30', mode: 'online', joinUrl: 'https://meet.example/own' } })
    expect((await sync()).deleted).toBe(1)
    expect(await sql`select zoom_join_url, zoom_managed from sessions where id = ${ids.session!}`).toEqual([{ zoom_join_url: 'https://meet.example/own', zoom_managed: false }])
    expect(await sql`select 1 from session_join_links where session_id = ${ids.session!}`).toHaveLength(0)
    // A new session gets a meeting; cancelling removes it.
    const s2 = ((await post('/v1/sessions', { cohortId: ids.cohort, courseId: ids.course, date: day(4), start: '10:00', end: '12:00', mode: 'online' })).body as { firstSessionId: string }).firstSessionId
    await sync()
    await post(`/v1/sessions/${s2}/cancel`, { reason: 'Holiday', notify: false })
    expect((await sync()).deleted).toBe(1)
    expect(zoom.calls.at(-1)).toBe('delete 2')
  })

  it('refreshes tokens, and marks the connection broken when Zoom stops accepting it', async () => {
    await sql`update zoom_connections set access_token_expires_at = now() - interval '1 minute'`
    await post('/v1/sessions', { cohortId: ids.cohort, courseId: ids.course, date: day(5), start: '10:00', end: '12:00', mode: 'online' })
    await sync()
    expect(zoom.refreshes).toBe(1)
    const [conn] = await sql<{ refresh_token_enc: string }[]>`select refresh_token_enc from zoom_connections`
    expect(box.open(conn!.refresh_token_enc)).toBe('refresh-1-r1')

    zoom.fail(new ZoomError(401, 'invalid_token', 'Invalid access token'))
    await post('/v1/sessions', { cohortId: ids.cohort, courseId: ids.course, date: day(6), start: '10:00', end: '12:00', mode: 'online' })
    await sync()
    zoom.fail(null)
    const settings = (await get('/v1/settings/attendance')).body.settings as { zoom: { problem: string } }
    expect(settings.zoom.problem).toMatch(/Connect Zoom again/)
    // While broken nothing is sent; connecting again clears it.
    expect((await sync()).created).toBe(0)
    await sql`update zoom_connections set broken_at = null, broken_reason = null`
  })

  it('imports attendance after the meeting, keeping hand-made marks (C2.01)', async () => {
    const id = ((await post('/v1/sessions', { cohortId: ids.cohort, courseId: ids.course, date: day(1), start: '10:00', end: '12:00', mode: 'online' })).body as { firstSessionId: string })
      .firstSessionId
    await sync()
    const [m] = await sql<{ zoom_meeting_id: string }[]>`select zoom_meeting_id from sessions where id = ${id}`
    // The session happened: 10:00–12:00, ended 30 minutes ago.
    const start = at(-2.5)
    const end = at(-0.5)
    await sql`update sessions set starts_at = ${start}, ends_at = ${end} where id = ${id}`
    await sql`insert into attendance_records (organisation_id, session_id, member_id, status, source) values (${ids.org!}, ${id}, ${ids.amara!}, 'excused', 'manual')`
    const mins = (x: number) => new Date(start.getTime() + x * 60_000)
    // Not ready yet: tried again next run.
    zoom.reports.set(m!.zoom_meeting_id, null)
    expect((await sync()).imported).toBe(0)
    zoom.reports.set(m!.zoom_meeting_id, [
      { name: 'Chidi N', email: 'CHIDI@example.com', joinTime: mins(15), leaveTime: mins(60), durationSeconds: 45 * 60 },
      { name: 'Chidi N', email: 'chidi@example.com', joinTime: mins(65), leaveTime: mins(120), durationSeconds: 55 * 60 },
      { name: 'Amara', email: 'amara@example.com', joinTime: mins(0), leaveTime: mins(30), durationSeconds: 30 * 60 },
      { name: 'Ngozi Eze', email: 'ngozi@aliwa.org', joinTime: mins(0), leaveTime: mins(120), durationSeconds: 120 * 60 },
      { name: 'Tobi A', email: 'tobi.a.dev@gmail.com', joinTime: mins(2), leaveTime: mins(114), durationSeconds: 112 * 60 },
      { name: 'Guest 4721', email: null, joinTime: mins(30), leaveTime: mins(71), durationSeconds: 41 * 60 },
    ])
    expect((await sync()).imported).toBe(1)
    const register = (await get(`/v1/sessions/${id}/attendance`)).body as { zoom: unknown; register: { name: string; status: string; source: string; minutesInMeeting: number | null; late: boolean }[] }
    expect(register.zoom).toMatchObject({ meeting: true, unmatched: 2 })
    expect(register.register.map((r) => [r.name, r.status, r.source, r.minutesInMeeting, r.late])).toEqual([
      ['Amara Okafor', 'excused', 'manual', null, false],
      ['Bisi Ade', 'absent', 'zoom', null, false],
      ['Chidi Nwosu', 'present', 'zoom', 100, true],
      ['Tobi Adewale', 'absent', 'zoom', null, false],
    ])
    // Admins and the trainer hear there are names to match.
    expect(await sql`select title, link_path from notifications where event = 'zoom_review' order by link_path`).toEqual([
      { title: '2 Zoom attendees to review', link_path: `/admin/courses/sessions/${id}/attendance/zoom` },
      { title: '2 Zoom attendees to review', link_path: `/trainer/sessions/${id}/attendance/zoom` },
    ])
    expect((await sync()).imported).toBe(0)
    ids.held = id
  })

  it('matches or ignores the names Zoom couldn’t link (C2.04)', async () => {
    const view = (await get(`/v1/sessions/${ids.held}/attendance/zoom`)).body as { attendees: { id: string; name: string; minutes: number; suggestedMemberId: string | null }[] }
    expect(view.attendees.map((a) => [a.name, a.minutes, a.suggestedMemberId])).toEqual([
      ['Guest 4721', 41, null],
      ['Tobi A', 112, ids.tobi],
    ])
    const [guest, tobi] = view.attendees
    expect((await post(`/v1/sessions/${ids.held}/attendance/zoom`, { matches: [{ id: tobi!.id, memberId: randomUUID() }] })).status).toBe(400)
    const saved = await post(`/v1/sessions/${ids.held}/attendance/zoom`, { matches: [{ id: tobi!.id, memberId: ids.tobi }], ignore: [guest!.id] })
    expect(saved.body).toEqual({ matched: 1, ignored: 1, kept: 0 })
    const register = (await get(`/v1/sessions/${ids.held}/attendance`)).body as { zoom: { unmatched: number }; register: { name: string; status: string; minutesInMeeting: number | null }[] }
    expect(register.zoom.unmatched).toBe(0)
    expect(register.register.find((r) => r.name === 'Tobi Adewale')).toMatchObject({ status: 'present', minutesInMeeting: 112 })
  })

  it('disconnects', async () => {
    expect((await req('DELETE', '/v1/zoom/connection', { token })).status).toBe(204)
    expect(zoom.calls.at(-1)).toBe('revoke')
    expect(((await get('/v1/settings/attendance')).body.settings as { zoom: unknown }).zoom).toMatchObject({ connected: false })
  })
})
