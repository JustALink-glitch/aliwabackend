import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/lib/db.js'
import { addDays } from '../src/lib/schedule.js'
import { createTestDatabase, TEST_DATABASE_URL } from './helpers/db.js'
import { as, client, testApp } from './helpers/app.js'

const day = (offset: number) => addDays(new Date().toISOString().slice(0, 10), offset)

type View = {
  exports: { id: string; status: string; includes: string; requestedBy: string }[]
  deletion: { scheduledFor: string; requestedBy: string } | null
  canManage: boolean
}

describe.skipIf(!TEST_DATABASE_URL)('data & privacy (F1.10, F1.11)', () => {
  let sql: Sql
  let drop: () => Promise<void>
  let t: ReturnType<typeof testApp>
  let req: ReturnType<typeof client>
  const owner = { id: randomUUID(), email: 'ada@aliwa.org' }
  let token: string
  let adminToken: string
  let participantToken: string

  async function activate(email: string, firstName: string, role: string) {
    const m = (await req('POST', '/v1/members', { token, body: { email, firstName, lastName: 'Eze', role } })).body.member as { id: string }
    const user = randomUUID()
    await sql`insert into auth.users (id, email) values (${user}, ${email})`
    await sql`update organisation_members set user_id = ${user}, status = 'active' where id = ${m.id}`
    return { id: m.id, token: as(user, email) }
  }

  beforeAll(async () => {
    ;({ sql, drop } = await createTestDatabase())
    t = testApp(sql)
    req = client(t.app)
    await sql`insert into auth.users (id, email) values (${owner.id}, ${owner.email})`
    token = as(owner.id, owner.email)
    await req('POST', '/v1/organisations', { token, body: { organisationName: 'ALIWA Foundation', fullName: 'Ada Obi' } })
    adminToken = (await activate('femi@aliwa.org', 'Femi', 'admin')).token
    const programme = ((await req('POST', '/v1/programmes', { token, body: { name: 'Data & AI' } })).body.programme as { id: string }).id
    const course = ((await req('POST', '/v1/courses', { token, body: { programmeId: programme, name: 'Python' } })).body.course as { id: string }).id
    const cohort = ((await req('POST', '/v1/cohorts', { token, body: { programmeId: programme, name: 'Cohort 5', startsOn: day(-10), endsOn: day(60), deliveryMode: 'online', courseIds: [course] } })).body.cohort as { id: string }).id
    const p = (await req('POST', '/v1/participants', { token, body: { fullName: 'Amara Okafor', email: 'amara@example.com', cohortId: cohort } })).body.participant as { id: string }
    const pUser = randomUUID()
    await sql`insert into auth.users (id, email) values (${pUser}, 'amara@example.com')`
    await sql`update organisation_members set user_id = ${pUser}, status = 'active' where id = ${p.id}`
    participantToken = as(pUser, 'amara@example.com')
    const [a] = await sql<{ id: string }[]>`
      insert into assignments (organisation_id, cohort_course_id, title, due_at, submission_types, grading_scale, max_points, published_at)
      select organisation_id, id, 'Clean a dataset', now(), '{file}', 'points', 100, now() from cohort_courses where cohort_id = ${cohort} returning id
    `
    const [s] = await sql<{ id: string }[]>`
      insert into submissions (organisation_id, assignment_id, member_id, submitted_at) select organisation_id, ${a!.id}, ${p.id}, now() from assignments where id = ${a!.id} returning id
    `
    await sql`insert into submission_files (organisation_id, submission_id, name, storage_path, size_bytes, mime_type)
              select organisation_id, ${s!.id}, 'data.csv', 'x/data.csv', 10, 'text/csv' from submissions where id = ${s!.id}`
    await sql`insert into submission_files (organisation_id, submission_id, name, storage_path, size_bytes, mime_type)
              select organisation_id, ${s!.id}, 'gone.pdf', 'x/gone.pdf', 10, 'application/pdf' from submissions where id = ${s!.id}`
    t.files.put('x/data.csv', 10, 'text/csv')
  })

  afterAll(async () => {
    await drop?.()
  })

  it('lets admins look but only the owner export', async () => {
    const res = await req('GET', '/v1/privacy', { token: adminToken })
    expect(res.status).toBe(200)
    expect((res.body as unknown as View).canManage).toBe(false)
    expect((await req('POST', '/v1/privacy/exports', { token: adminToken, body: { parts: ['people'] } })).body.error!.code).toBe('owner_only')
    expect((await req('GET', '/v1/privacy', { token: participantToken })).status).toBe(403)
    expect((await req('POST', '/v1/privacy/exports', { token, body: { parts: [] } })).body.error!.details).toEqual([{ field: 'parts', message: 'Choose at least one thing to export.' }])
  })

  it('builds a ZIP of CSVs and files, and emails the owner (F1.10)', async () => {
    const res = await req('POST', '/v1/privacy/exports', { token, body: { parts: EXPORT_ALL } })
    expect(res.status).toBe(202)
    const view = (await req('GET', '/v1/privacy', { token })).body as unknown as View
    expect(view.exports[0]).toMatchObject({ status: 'ready', includes: 'Everything', requestedBy: 'Ada O.' })
    expect(t.mail.sent.at(-1)).toMatchObject({ to: 'ada@aliwa.org', subject: 'ALIWA Foundation data export is ready' })

    const file = await t.app.request(`/v1/privacy/exports/${view.exports[0]!.id}/file`, { headers: { Authorization: `Bearer ${token}` } })
    expect(file.headers.get('content-type')).toBe('application/zip')
    const dir = mkdtempSync(join(tmpdir(), 'export-'))
    writeFileSync(join(dir, 'e.zip'), Buffer.from(await file.arrayBuffer()))
    execFileSync('unzip', ['-q', 'e.zip', '-d', 'out'], { cwd: dir })
    const names = execFileSync('unzip', ['-Z1', 'e.zip'], { cwd: dir }).toString().trim().split('\n')
    expect(names).toEqual(
      expect.arrayContaining([
        'README.txt',
        'participants.csv',
        'enrolments.csv',
        'attendance.csv',
        'grades.csv',
        'session_feedback.csv',
        'certificates.csv',
        'files/Cohort-5/Clean-a-dataset/Amara-Okafor---data.csv',
        'files_not_included.csv',
      ]),
    )
    const participants = readFileSync(join(dir, 'out', 'participants.csv'), 'utf8')
    expect(participants).toContain('Name,Email,Phone,Status,Invited,Joined')
    expect(participants).toContain('Amara Okafor,amara@example.com,,active,')
    expect(readFileSync(join(dir, 'out', 'files_not_included.csv'), 'utf8')).toContain('gone.pdf,File not found in storage')
  })

  it('labels partial exports', async () => {
    await req('POST', '/v1/privacy/exports', { token, body: { parts: ['people'] } })
    await req('POST', '/v1/privacy/exports', { token, body: { parts: ['people', 'attendance', 'assignments', 'reports', 'interventions'] } })
    const view = (await req('GET', '/v1/privacy', { token })).body as unknown as View
    expect(view.exports.map((e) => e.includes)).toEqual(['Everything except files', 'Participants only', 'Everything'])
    // After 7 days the file is gone.
    await sql`update data_exports set expires_at = now() - interval '1 minute' where id = ${view.exports[2]!.id}`
    const later = (await req('GET', '/v1/privacy', { token })).body as unknown as View
    expect(later.exports[2]!.status).toBe('expired')
    const file = await t.app.request(`/v1/privacy/exports/${view.exports[2]!.id}/file`, { headers: { Authorization: `Bearer ${token}` } })
    expect(file.status).toBe(409)
  })

  it('schedules deletion, makes the workspace read-only, and can be cancelled (F1.11)', async () => {
    const wrong = await req('POST', '/v1/privacy/deletion', { token, body: { exported: true, confirmName: 'ALIWA' } })
    expect(wrong.body.error!.details).toEqual([{ field: 'confirmName', message: 'Type ALIWA Foundation exactly as shown.' }])
    expect((await req('POST', '/v1/privacy/deletion', { token, body: { exported: false, confirmName: 'ALIWA Foundation' } })).status).toBe(400)
    expect((await req('POST', '/v1/privacy/deletion', { token: adminToken, body: { exported: true, confirmName: 'ALIWA Foundation' } })).status).toBe(403)

    const sentBefore = t.mail.sent.length
    const res = await req('POST', '/v1/privacy/deletion', { token, body: { exported: true, confirmName: 'ALIWA Foundation' } })
    expect(res.status).toBe(200)
    const deletion = (res.body as unknown as View).deletion!
    expect(deletion.requestedBy).toBe('Ada O.')
    expect(Math.round((Date.parse(deletion.scheduledFor) - Date.now()) / 86_400_000)).toBe(30)
    const emails = t.mail.sent.slice(sentBefore)
    expect(emails.map((m) => m.to).sort()).toEqual(['ada@aliwa.org', 'amara@example.com', 'femi@aliwa.org'])
    expect(emails.find((m) => m.to === 'amara@example.com')!.subject).toContain('is closing its workspace on')

    // Read-only: reading works, changes don't, exports still do.
    expect((await req('GET', '/v1/programmes', { token: adminToken })).status).toBe(200)
    const blocked = await req('POST', '/v1/programmes', { token, body: { name: 'New' } })
    expect(blocked.status).toBe(423)
    expect(blocked.body.error!.code).toBe('read_only')
    expect((await req('PATCH', '/v1/me', { token: participantToken, body: { fullName: 'Amara O', phone: null } })).status).toBe(423)
    expect((await req('POST', '/v1/privacy/exports', { token, body: { parts: ['people'] } })).status).toBe(202)
    expect(((await req('GET', '/v1/me', { token: participantToken })).body.organisation as { deletionScheduledFor: string }).deletionScheduledFor).toBe(deletion.scheduledFor)

    const cancelled = await req('DELETE', '/v1/privacy/deletion', { token })
    expect((cancelled.body as unknown as View).deletion).toBeNull()
    expect((await req('POST', '/v1/programmes', { token, body: { name: 'New' } })).status).toBe(201)
    expect(await sql`select action from audit_events where action like 'organisation.deletion%' order by created_at`).toEqual([
      { action: 'organisation.deletion_scheduled' },
      { action: 'organisation.deletion_cancelled' },
    ])
  })

  it('closes the workspace once the date passes', async () => {
    await req('POST', '/v1/privacy/deletion', { token, body: { exported: true, confirmName: 'ALIWA Foundation' } })
    await sql`update organisations set deletion_scheduled_for = now() - interval '1 minute'`
    expect((await req('GET', '/v1/me', { token: participantToken })).body.error!.code).toBe('access_ended')
    expect((await req('GET', '/v1/privacy', { token })).body.error!.code).toBe('access_ended')
  })
})

const EXPORT_ALL = ['people', 'attendance', 'assignments', 'files', 'reports', 'interventions']
