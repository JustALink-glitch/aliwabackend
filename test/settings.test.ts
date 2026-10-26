import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/lib/db.js'
import { createTestDatabase, TEST_DATABASE_URL } from './helpers/db.js'
import { as, client, testApp } from './helpers/app.js'

type Member = { id: string; role: string; status: string; firstName: string; lastName: string; lastActiveAt: string | null }

describe.skipIf(!TEST_DATABASE_URL)('settings part A (F1.01, F1.02, F1.04, F1.07, F1.09, G1.04)', () => {
  let sql: Sql
  let drop: () => Promise<void>
  let t: ReturnType<typeof testApp>
  let req: ReturnType<typeof client>
  const owner = { id: randomUUID(), email: 'ada@aliwa.org' }
  let token: string
  const put = (path: string, body: unknown, tk = token) => req('PUT', path, { token: tk, body })
  const get = (path: string, tk = token) => req('GET', path, { token: tk })

  /** Invites someone and has them join with a password. */
  async function join(email: string, role: string) {
    const invited = await req('POST', '/v1/members', { token, body: { email, fullName: 'Femi Johnson', role } })
    expect(invited.status).toBe(201)
    const accepted = await req('POST', `/v1/invitations/${t.mail.lastToken(email)}/accept`, { body: { password: 'a-strong-password' } })
    expect(accepted.status).toBe(200)
    const [row] = await sql<{ user_id: string }[]>`select user_id from organisation_members where email = ${email}`
    return { id: (invited.body.member as Member).id, token: as(row!.user_id, email) }
  }

  beforeAll(async () => {
    ;({ sql, drop } = await createTestDatabase())
    t = testApp(sql)
    req = client(t.app)
    await sql`insert into auth.users (id, email, last_sign_in_at) values (${owner.id}, ${owner.email}, now())`
    token = as(owner.id, owner.email)
    await req('POST', '/v1/organisations', { token, body: { organisationName: 'ALIWA Foundation', fullName: 'Ada Obi' } })
  })

  afterAll(async () => {
    await drop?.()
  })

  it('edits organisation details (F1.01)', async () => {
    const before = (await get('/v1/settings/organisation')).body.settings as Record<string, unknown>
    expect(before).toMatchObject({ name: 'ALIWA Foundation', type: null, country: null, timeZone: 'Africa/Lagos', owner: 'Ada O.' })
    const bad = await put('/v1/settings/organisation', { name: ' ', country: 'Nigeria', timeZone: 'Mars/Base' })
    expect(bad.body.error!.details).toEqual([
      { field: 'name', message: 'Enter your organisation’s name.' },
      { field: 'country', message: 'Choose a country.' },
      { field: 'timeZone', message: 'Unknown time zone.' },
    ])
    const res = await put('/v1/settings/organisation', { name: 'ALIWA Foundation Ltd', type: 'Skills development', country: 'ng', timeZone: 'Europe/London' })
    expect(res.body.settings).toMatchObject({ name: 'ALIWA Foundation Ltd', type: 'Skills development', country: 'NG', timeZone: 'Europe/London' })
    expect(((await get('/v1/me')).body.organisation as { name: string }).name).toBe('ALIWA Foundation Ltd')
    await put('/v1/settings/organisation', { name: 'ALIWA Foundation', type: '', country: '', timeZone: 'Africa/Lagos' })
    expect((await get('/v1/settings/organisation')).body.settings).toMatchObject({ type: null, country: null })
  })

  it('saves programme setup and applies the assistant and feedback switches (F1.04)', async () => {
    const s = (await get('/v1/settings/programme-setup')).body.settings as Record<string, unknown>
    expect(s).toMatchObject({ courseLibrary: 'shared', trainerAssignment: 'course', assistantsEnabled: true, multiCohort: false, feedbackEnabled: true })
    expect(s.gradingScales).toEqual(['points', 'percentage', 'letter', 'pass_fail', 'rubric'])
    const body = { ...s, gradingScales: [] }
    expect((await put('/v1/settings/programme-setup', body)).body.error!.details).toEqual([{ field: 'gradingScales', message: 'Allow at least one scale.' }])
    const res = await put('/v1/settings/programme-setup', {
      ...s,
      courseLibrary: 'per_cohort',
      trainerAssignment: 'cohort',
      assistantsEnabled: false,
      gradingScales: ['rubric', 'points'],
      feedbackEnabled: false,
    })
    expect(res.body.settings).toMatchObject({ courseLibrary: 'per_cohort', trainerAssignment: 'cohort', assistantsEnabled: false, gradingScales: ['points', 'rubric'], feedbackEnabled: false })
    const [db] = await sql`select assistant_can_take_attendance, assistants_enabled, session_feedback_enabled from organisation_settings`
    expect(db).toEqual({ assistant_can_take_attendance: true, assistants_enabled: false, session_feedback_enabled: false })
    await put('/v1/settings/programme-setup', s)
  })

  it('saves attendance and Zoom settings (F1.07)', async () => {
    const s = (await get('/v1/settings/attendance')).body.settings as Record<string, unknown>
    expect(s).toEqual({
      zoom: { available: false, connected: false, email: null, connectedAt: null, problem: null, lastImportAt: null },
      joinLinks: 'personal',
      presentMinPct: 70,
      late: { enabled: true, minutes: 10 },
      recordings: { shared: true, days: 30 },
      inPersonReminder: { enabled: true, hours: 2 },
    })
    const bad = await put('/v1/settings/attendance', { ...s, presentMinPct: 0, recordings: { shared: true, days: 0 } })
    expect(bad.body.error!.details).toEqual([
      { field: 'presentMinPct', message: 'Use 1 to 100.' },
      { field: 'recordings.days', message: 'Use 1 day or more.' },
    ])
    const res = await put('/v1/settings/attendance', { ...s, joinLinks: 'shared', presentMinPct: 60, late: { enabled: false, minutes: 15 }, inPersonReminder: { enabled: false, hours: 4 } })
    expect(res.body.settings).toMatchObject({ joinLinks: 'shared', presentMinPct: 60, late: { enabled: false, minutes: 15 }, inPersonReminder: { enabled: false, hours: 4 } })
  })

  it('invites, changes roles and removes staff (F1.02)', async () => {
    const femi = await join('femi@aliwa.org', 'admin')
    const list = (await get('/v1/members?role=owner,admin,trainer,assistant_trainer&status=current')).body.members as Member[]
    expect(list.map((m) => [m.firstName, m.role, m.status])).toEqual([
      ['Femi', 'admin', 'active'],
      ['Ada', 'owner', 'active'],
    ])
    expect(list.find((m) => m.role === 'owner')!.lastActiveAt).not.toBeNull()
    expect((await get('/v1/settings/organisation', femi.token)).status).toBe(200)

    // Nobody changes the owner or themselves.
    const [ownerRow] = await sql<{ id: string }[]>`select id from organisation_members where role = 'owner'`
    expect((await req('PATCH', `/v1/members/${ownerRow!.id}/role`, { token: femi.token, body: { role: 'trainer' } })).body.error!.code).toBe('owner')
    expect((await req('PATCH', `/v1/members/${femi.id}/role`, { token: femi.token, body: { role: 'trainer' } })).body.error!.code).toBe('self')

    expect((await req('PATCH', `/v1/members/${femi.id}/role`, { token, body: { role: 'trainer' } })).status).toBe(200)
    expect((await get('/v1/settings/organisation', femi.token)).status).toBe(403)

    // Teaching a course; removing takes them off it, and they can't sign in.
    const programme = ((await req('POST', '/v1/programmes', { token, body: { name: 'Data & AI' } })).body.programme as { id: string }).id
    await req('POST', '/v1/courses', { token, body: { programmeId: programme, name: 'Python', defaultLeadMemberId: femi.id } })
    expect((await req('DELETE', `/v1/members/${femi.id}`, { token })).status).toBe(204)
    expect((await get('/v1/me', femi.token)).body.error!.code).toBe('access_ended')
    expect(await sql`select 1 from courses where default_lead_member_id = ${femi.id}`).toHaveLength(0)
    const after = (await get('/v1/members?status=current')).body.members as Member[]
    expect(after.map((m) => m.firstName)).toEqual(['Ada'])
    expect(await sql`select action from audit_events where action in ('member.role_changed', 'member.removed') order by created_at`).toEqual([
      { action: 'member.role_changed' },
      { action: 'member.removed' },
    ])

    // Invited back with the same email, they sign in again with a new password.
    const again = await req('POST', '/v1/members', { token, body: { email: 'femi@aliwa.org', fullName: 'Femi Johnson', role: 'trainer' } })
    expect(again.status).toBe(201)
    expect((again.body.member as Member).id).toBe(femi.id)
    const accepted = await req('POST', `/v1/invitations/${t.mail.lastToken('femi@aliwa.org')}/accept`, { body: { password: 'another-strong-one' } })
    expect(accepted.status).toBe(200)
    expect(((await get('/v1/me', femi.token)).body.membership as { role: string }).role).toBe('trainer')

    // Someone still invited is cancelled, not removed.
    const ifeoma = (await req('POST', '/v1/members', { token, body: { email: 'ifeoma@aliwa.org', fullName: 'Ifeoma Obi', role: 'trainer' } })).body.member as Member
    expect((await req('DELETE', `/v1/members/${ifeoma.id}`, { token })).body.error!.code).toBe('still_invited')
  })

  it('keeps admin notification choices and digest time (F1.09)', async () => {
    const res = await get('/v1/me/notification-preferences')
    expect(res.body.digestTime).toBe('08:00')
    const prefs = res.body.preferences as { event: string; email: boolean; inApp: boolean }[]
    expect(prefs.map((p) => p.event)).toEqual([
      'attention_flags',
      'report_overdue',
      'attendance_missing',
      'zoom_review',
      'participant_left',
      'certificate_eligible',
      'import_finished',
      'report_ready',
      'invitation_accepted',
    ])
    expect(prefs[0]).toMatchObject({ email: true, inApp: true })
    await put('/v1/me/notification-preferences', { preferences: [{ event: 'report_ready', email: true, inApp: false }], digestTime: '07:30' })
    const saved = await get('/v1/me/notification-preferences')
    expect(saved.body.digestTime).toBe('07:30')
    expect((saved.body.preferences as { event: string }[]).find((p) => p.event === 'report_ready')).toMatchObject({ email: true, inApp: false })
    expect((await put('/v1/me/notification-preferences', { preferences: [], digestTime: '25:00' })).status).toBe(400)
  })

  it('saves a display name and shows the last sign-in (G1.04)', async () => {
    expect((await req('PATCH', '/v1/me', { token, body: { fullName: 'Ada Obi', displayName: 'Ada', phone: null } })).status).toBe(200)
    let me = (await get('/v1/me')).body.membership as { displayName: string | null; lastSignInAt: string | null }
    expect(me.displayName).toBe('Ada')
    expect(me.lastSignInAt).not.toBeNull()
    // Leaving it out keeps it; clearing it falls back to "First L.".
    await req('PATCH', '/v1/me', { token, body: { fullName: 'Ada Obi', phone: null } })
    expect(((await get('/v1/me')).body.membership as { displayName: string }).displayName).toBe('Ada')
    await req('PATCH', '/v1/me', { token, body: { fullName: 'Ada Obi', displayName: '', phone: null } })
    me = (await get('/v1/me')).body.membership as { displayName: string | null; lastSignInAt: string | null }
    expect(me.displayName).toBeNull()
  })
})
