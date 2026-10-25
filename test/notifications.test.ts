import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/lib/db.js'
import { addDays } from '../src/lib/schedule.js'
import { createTestDatabase, TEST_DATABASE_URL } from './helpers/db.js'
import { as, client, testApp } from './helpers/app.js'

const day = (offset: number) => addDays(new Date().toISOString().slice(0, 10), offset)

type Note = { id: string; event: string; title: string; body: string | null; link: string | null; readAt: string | null }
type Group = { kind: string; items: { title: string; subtitle: string; link: string }[] }

describe.skipIf(!TEST_DATABASE_URL)('notifications and search (G1.01, G1.02)', () => {
  let sql: Sql
  let drop: () => Promise<void>
  let t: ReturnType<typeof testApp>
  let req: ReturnType<typeof client>
  const owner = { id: randomUUID(), email: 'ada@aliwa.org' }
  let token: string
  let femiToken: string
  let trainerToken: string
  let amaraToken: string
  const ids: Record<string, string> = {}
  const post = (path: string, body: unknown, tk = token) => req('POST', path, { token: tk, body })
  const get = (path: string, tk = token) => req('GET', path, { token: tk })
  const bell = async (tk = token) => (await get('/v1/notifications', tk)).body as { unread: number; notifications: Note[] }

  /** Invites someone and has them join with a password. */
  async function join(email: string, fullName: string, role: string) {
    const invited = await post('/v1/members', { email, fullName, role })
    await req('POST', `/v1/invitations/${t.mail.lastToken(email)}/accept`, { body: { password: 'a-strong-password' } })
    const [row] = await sql<{ user_id: string }[]>`select user_id from organisation_members where email = ${email}`
    return { id: (invited.body.member as { id: string }).id, token: as(row!.user_id, email) }
  }

  beforeAll(async () => {
    ;({ sql, drop } = await createTestDatabase())
    t = testApp(sql)
    req = client(t.app)
    await sql`insert into auth.users (id, email) values (${owner.id}, ${owner.email})`
    token = as(owner.id, owner.email)
    await post('/v1/organisations', { organisationName: 'ALIWA Foundation', fullName: 'Ada Obi' })
    femiToken = (await join('femi@aliwa.org', 'Femi Johnson', 'admin')).token
    const ngozi = await join('ngozi@aliwa.org', 'Ngozi Eze', 'trainer')
    ids.trainer = ngozi.id
    trainerToken = ngozi.token
    ids.programme = ((await post('/v1/programmes', { name: 'Data & AI' })).body.programme as { id: string }).id
    const python = ((await post('/v1/courses', { programmeId: ids.programme, name: 'Python for Data Analysis', defaultLeadMemberId: ngozi.id })).body.course as { id: string }).id
    const sqlCourse = ((await post('/v1/courses', { programmeId: ids.programme, name: 'SQL Basics' })).body.course as { id: string }).id
    ids.cohort = ((await post('/v1/cohorts', { programmeId: ids.programme, name: 'Cohort 5', startsOn: day(-20), endsOn: day(60), deliveryMode: 'online', courseIds: [python, sqlCourse] })).body
      .cohort as { id: string }).id
    ids.other = ((await post('/v1/cohorts', { programmeId: ids.programme, name: 'Cohort 6', startsOn: day(10), endsOn: day(90), deliveryMode: 'online', courseIds: [sqlCourse] })).body
      .cohort as { id: string }).id
    ids.amara = ((await post('/v1/participants', { fullName: 'Amara Okafor', email: 'amara@example.com', cohortId: ids.cohort })).body.participant as { id: string }).id
    ids.bayo = ((await post('/v1/participants', { fullName: 'Amara Bello', email: 'bello@example.com', cohortId: ids.other })).body.participant as { id: string }).id
    await req('POST', `/v1/invitations/${t.mail.lastToken('amara@example.com')}/accept`, { body: { password: 'a-strong-password' } })
    const [a] = await sql<{ user_id: string }[]>`select user_id from organisation_members where id = ${ids.amara!}`
    amaraToken = as(a!.user_id, 'amara@example.com')
    const [cc] = await sql<{ id: string }[]>`select x.id from cohort_courses x join courses c on c.id = x.course_id where x.cohort_id = ${ids.cohort!} and c.name like 'Python%'`
    ids.cc = cc!.id
  })

  afterAll(async () => {
    await drop?.()
  })

  it('tells admins when staff accept an invitation, and keeps a count of unread', async () => {
    const mine = await bell()
    expect(mine.notifications.map((n) => [n.event, n.title, n.body])).toEqual([
      ['invitation_accepted', 'Invitation accepted', 'Ngozi Eze · Trainer'],
      ['invitation_accepted', 'Invitation accepted', 'Femi Johnson · Admin'],
    ])
    expect(mine.unread).toBe(2)
    // Femi doesn't hear about himself joining; participants joining don't notify anyone.
    expect((await bell(femiToken)).notifications.map((n) => n.body)).toEqual(['Ngozi Eze · Trainer'])
    expect((await bell(amaraToken)).notifications).toEqual([])
  })

  it('marks one or all as read, only your own', async () => {
    const [first] = (await bell()).notifications
    expect((await req('POST', `/v1/notifications/${first!.id}/read`, { token: femiToken })).status).toBe(404)
    expect((await req('POST', `/v1/notifications/${first!.id}/read`, { token })).status).toBe(204)
    expect((await bell()).unread).toBe(1)
    expect((await post('/v1/notifications/read-all', {})).body.unread).toBe(0)
    expect((await bell()).notifications.every((n) => n.readAt)).toBe(true)
  })

  it('respects someone switching an event off (F1.09)', async () => {
    await req('PUT', '/v1/me/notification-preferences', { token: femiToken, body: { preferences: [{ event: 'participant_left', email: true, inApp: false }] } })
    const [enrolment] = await sql<{ id: string }[]>`select id from enrolments where member_id = ${ids.bayo!}`
    await post(`/v1/participants/${ids.bayo!}/enrolments/${enrolment!.id}/withdraw`, { reason: 'Moved away', notify: false }, femiToken)
    // Ada hears; Femi did it himself and has it switched off anyway.
    expect((await bell()).notifications[0]).toMatchObject({ event: 'participant_left', title: 'Amara Bello withdrawn', body: 'Cohort 6', link: `/admin/participants/${ids.bayo!}` })
    expect((await bell(femiToken)).notifications.some((n) => n.event === 'participant_left')).toBe(false)
  })

  it('tells admins an import finished and the requester a report is ready', async () => {
    await post('/v1/participants/import', {
      cohortId: ids.cohort,
      fileName: 'cohort5.csv',
      sendEmails: false,
      rows: [
        { full_name: 'Chidi Nwosu', email: 'chidi@example.com' },
        { full_name: 'Amara Okafor', email: 'amara@example.com' },
      ],
    })
    expect((await bell()).notifications[0]).toMatchObject({ event: 'import_finished', title: '1 participant imported', body: 'Cohort 5 · 1 row skipped' })
    await post('/v1/reports', { kind: 'programme_summary', programmeId: ids.programme, format: 'pdf' })
    expect((await bell()).notifications[0]).toMatchObject({ event: 'report_ready', body: 'Programme summary — Data & AI', link: '/admin/reports' })
    expect((await bell(femiToken)).notifications.some((n) => n.event === 'report_ready')).toBe(false)
  })

  it('tells participants about grades, changed sessions and new resources', async () => {
    const assignment = (
      await post(
        '/v1/assignments',
        {
          cohortCourseId: ids.cc,
          title: 'Python Exercises 1',
          brief: 'Loops.',
          dueDate: day(5),
          dueTime: '23:59',
          submissionTypes: ['link'],
          latePolicy: 'accept_late',
          gradingScale: 'points',
          maxPoints: 100,
          publish: true,
        },
        trainerToken,
      )
    ).body.assignment as { id: string }
    await sql`insert into submissions (organisation_id, assignment_id, member_id, link_url, submitted_at) select organisation_id, id, ${ids.amara!}, 'https://x.y', now() from assignments where id = ${assignment.id}`
    expect((await req('PUT', `/v1/assignments/${assignment.id}/submissions/${ids.amara!}/grade`, { token: trainerToken, body: { points: 78, feedback: 'Good' } })).status).toBe(200)

    const [s] = await sql<{ id: string }[]>`
      insert into sessions (organisation_id, cohort_course_id, title, starts_at, ends_at, trainer_member_id)
      select organisation_id, id, 'Python for Data Analysis', now() + interval '2 days', now() + interval '2 days 2 hours', ${ids.trainer!} from cohort_courses where id = ${ids.cc!} returning id
    `
    await req('POST', `/v1/sessions/${s!.id}/resources`, { token: trainerToken, body: { kind: 'link', name: 'Workbook', url: 'https://example.com/w', scope: 'session', visible: true } })
    await post(`/v1/sessions/${s!.id}/cancel`, { reason: 'Trainer unwell', notify: true })
    const notes = (await bell(amaraToken)).notifications
    expect(notes.map((n) => [n.event, n.title.replace(/, .*$/, ', …')])).toEqual([
      ['session_changed', 'Cancelled: Python for Data Analysis, …'],
      ['new_resource', 'New resource: Workbook'],
      ['grade_saved', 'New grade: Python Exercises 1'],
    ])
    expect(notes[2]!.link).toBe(`/participant/grades/${assignment.id}`)
  })

  it('searches what each role can open (G1.02)', async () => {
    const admin = (await get('/v1/search?q=amara')).body.groups as Group[]
    expect(admin.map((g) => g.kind)).toEqual(['participants'])
    expect(admin[0]!.items.map((i) => [i.title, i.subtitle])).toEqual([
      ['Amara Bello', 'Cohort 6 · Withdrawn'],
      ['Amara Okafor', 'Cohort 5 · Active'],
    ])
    const python = (await get('/v1/search?q=python')).body.groups as Group[]
    expect(python.map((g) => g.kind)).toEqual(['courses', 'sessions'])
    expect(python[0]!.items[0]).toMatchObject({ title: 'Python for Data Analysis', subtitle: 'Data & AI', link: `/admin/programmes/${ids.programme!}` })
    expect(((await get('/v1/search?q=ngozi')).body.groups as Group[])[0]).toMatchObject({ kind: 'trainers', items: [{ title: 'Ngozi Eze', subtitle: 'Trainer' }] })
    expect((await get('/v1/search?q=a')).body.groups).toEqual([])
    expect((await get('/v1/search?q=%25%25')).body.groups).toEqual([])

    // Ngozi teaches Python in Cohort 5 only: she finds Amara Okafor, not Amara Bello, and not SQL.
    const trainer = (await get('/v1/search?q=amara', trainerToken)).body.groups as Group[]
    expect(trainer[0]!.items.map((i) => [i.title, i.link])).toEqual([['Amara Okafor', `/trainer/participants/${ids.amara!}`]])
    expect((await get('/v1/search?q=sql', trainerToken)).body.groups).toEqual([])

    const participant = (await get('/v1/search?q=sql', amaraToken)).body.groups as Group[]
    expect(participant[0]).toMatchObject({ kind: 'courses', items: [{ title: 'SQL Basics', subtitle: 'Cohort 5' }] })
    expect((await get('/v1/search?q=ngozi', amaraToken)).body.groups).toEqual([])
  })
})
