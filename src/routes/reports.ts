import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import type { AuthContext } from '../lib/auth.js'
import { audit, type Sql } from '../lib/db.js'
import { AppError, forbidden, notFound } from '../lib/errors.js'
import { renderEmail } from '../lib/mailer.js'
import { can, isAdmin, staffScope, teachingIds, type StaffScope } from '../lib/staff.js'
import { parseBody, uuid } from '../lib/validation.js'
import { requireAuth, requireRole, type AuthVariables } from '../middleware/auth.js'

const Save = z.object({
  answers: z.array(z.object({ questionId: uuid, choices: z.array(z.string().max(80)).max(10) })).max(30),
  summary: z.string().max(5000).default(''),
  submit: z.boolean().default(false),
})

export type ReportState = 'due' | 'overdue' | 'submitted'

interface ReportRow {
  session_id: string
  cohort_course_id: string
  course_name: string
  cohort_id: string
  cohort_name: string
  number: number | null
  starts_at: Date
  ends_at: Date
  due_at: Date
  trainer_id: string | null
  trainer_first: string | null
  trainer_last: string | null
  trainer_email: string | null
  report_id: string | null
  submitted_at: Date | null
  draft_saved_at: Date | null
}

/** Held sessions with their report (T5.03, C3.01). Cancelled and upcoming sessions need no report. */
function selectReports(sql: Sql, organisationId: string, filter: { sessionId?: string; cohortCourseIds?: string[] | null }) {
  return sql<ReportRow[]>`
    select s.id as session_id, s.cohort_course_id, co.name as course_name, h.id as cohort_id, h.name as cohort_name,
           (select count(*)::int from public.sessions y where y.cohort_course_id = s.cohort_course_id and y.cancelled_at is null and y.starts_at <= s.starts_at) as number,
           s.starts_at, s.ends_at, s.ends_at + make_interval(hours => st.report_due_hours) as due_at,
           coalesce(s.trainer_member_id, (select t.member_id from public.cohort_course_trainers t where t.cohort_course_id = s.cohort_course_id and t.is_lead limit 1)) as trainer_id,
           m.first_name as trainer_first, m.last_name as trainer_last, m.email as trainer_email,
           r.id as report_id, r.submitted_at, case when r.submitted_at is null then r.updated_at end as draft_saved_at
    from public.sessions s
    join public.cohort_courses x on x.id = s.cohort_course_id
    join public.courses co on co.id = x.course_id
    join public.cohorts h on h.id = x.cohort_id
    join public.organisation_settings st on st.organisation_id = s.organisation_id
    left join public.organisation_members m on m.id = coalesce(s.trainer_member_id, (select t.member_id from public.cohort_course_trainers t where t.cohort_course_id = s.cohort_course_id and t.is_lead limit 1))
    left join public.session_reports r on r.session_id = s.id
    where s.organisation_id = ${organisationId} and s.cancelled_at is null and s.ends_at <= now() and h.archived_at is null
      ${filter.sessionId ? sql`and s.id = ${filter.sessionId}` : sql``}
      ${filter.cohortCourseIds ? sql`and s.cohort_course_id = any(${filter.cohortCourseIds}::uuid[])` : sql``}
    order by s.ends_at desc
    limit 500
  `
}

const stateOf = (r: Pick<ReportRow, 'submitted_at' | 'due_at'>, now: Date): ReportState => (r.submitted_at ? 'submitted' : r.due_at.getTime() < now.getTime() ? 'overdue' : 'due')

const name = (first: string | null, last: string | null) => (first ? `${first} ${last ?? ''}`.trim() : null)

/** Sessions this person sees reports for: admins all; trainers the courses they may report on. */
const reportScope = (scope: StaffScope) => (scope.admin ? null : [...(scope.teaches ?? [])].filter((id) => can(scope, id).report))

/** /v1/session-reports — T5 for trainers, C3 for admins. */
export function reportRoutes(deps: AppDeps) {
  const now = () => (deps.now ? deps.now() : new Date())

  async function findReport(auth: AuthContext, sessionId: string) {
    if (!uuid.safeParse(sessionId).success) throw notFound('Session not found.')
    const scope = await staffScope(deps.sql, auth)
    const [row] = await selectReports(deps.sql, auth.organisationId, { sessionId, cohortCourseIds: scope.admin ? null : teachingIds(scope) })
    if (!row) throw notFound('This session has no report. Reports open when a session ends.')
    return { row, scope }
  }

  return (
    new Hono<{ Variables: AuthVariables }>()
      .use(requireAuth(deps), requireRole('owner', 'admin', 'trainer', 'assistant_trainer'))

      // T5.03 / C3.01 Session reports, newest first.
      .get('/', async (c) => {
        const auth = c.var.auth
        const scope = await staffScope(deps.sql, auth)
        const ids = reportScope(scope)
        const t = now()
        const rows = ids && ids.length === 0 ? [] : await selectReports(deps.sql, auth.organisationId, { cohortCourseIds: ids })
        const [org] = await deps.sql<{ time_zone: string; hours: number }[]>`
          select o.time_zone, s.report_due_hours as hours from public.organisations o join public.organisation_settings s on s.organisation_id = o.id where o.id = ${auth.organisationId}
        `
        const monthStart = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1))
        const thisMonth = rows.filter((r) => r.submitted_at && r.submitted_at >= monthStart)
        return c.json({
          timeZone: org!.time_zone,
          dueHours: org!.hours,
          canWrite: !scope.admin && (ids?.length ?? 0) > 0,
          counts: {
            due: rows.filter((r) => stateOf(r, t) === 'due').length,
            overdue: rows.filter((r) => stateOf(r, t) === 'overdue').length,
            submitted: rows.filter((r) => r.submitted_at).length,
            submittedThisMonth: thisMonth.length,
            onTimeThisMonth: thisMonth.filter((r) => r.submitted_at! <= r.due_at).length,
          },
          reports: rows.map((r) => ({
            sessionId: r.session_id,
            course: r.course_name,
            cohort: { id: r.cohort_id, name: r.cohort_name },
            number: r.number,
            startsAt: r.starts_at,
            dueAt: r.due_at,
            trainer: r.trainer_id ? { id: r.trainer_id, name: name(r.trainer_first, r.trainer_last) } : null,
            state: stateOf(r, t),
            submittedAt: r.submitted_at,
            draft: Boolean(r.report_id && !r.submitted_at),
          })),
        })
      })

      // T5.01 / T5.02 / C3.02 One report: the form, or what was submitted.
      .get('/:sessionId', async (c) => {
        const auth = c.var.auth
        const { row, scope } = await findReport(auth, c.req.param('sessionId'))
        const t = now()
        const [[att], answers, questions, [report], [feedback], [org]] = await Promise.all([
          deps.sql<{ present: number; recorded: number; expected: number }[]>`
            select (select count(*)::int from public.attendance_records a where a.session_id = ${row.session_id} and a.status = 'present') as present,
                   (select count(*)::int from public.attendance_records a where a.session_id = ${row.session_id}) as recorded,
                   (select count(*)::int from public.enrolments e where e.cohort_id = ${row.cohort_id} and e.status = 'active') as expected
          `,
          row.report_id
            ? deps.sql<{ question_id: string | null; question_prompt: string; choices: string[]; answer: string }[]>`
                select question_id, question_prompt, choices, answer from public.session_report_answers where report_id = ${row.report_id}
              `
            : Promise.resolve([]),
          deps.sql<{ id: string; prompt: string; options: string[]; multiple: boolean; archived: boolean }[]>`
            select id, prompt, options, multiple, (archived_at is not null) as archived from public.report_questions
            where organisation_id = ${auth.organisationId} order by position, created_at
          `,
          row.report_id
            ? deps.sql<{ summary: string; author_first: string | null; author_last: string | null; author_id: string | null; updated_at: Date }[]>`
                select r.summary, m.first_name as author_first, m.last_name as author_last, r.author_member_id as author_id, r.updated_at
                from public.session_reports r left join public.organisation_members m on m.id = r.author_member_id where r.id = ${row.report_id}
              `
            : Promise.resolve([]),
          deps.sql<{ n: number }[]>`select count(*)::int as n from public.session_feedback where session_id = ${row.session_id}`,
          deps.sql<{ time_zone: string }[]>`select time_zone from public.organisations where id = ${auth.organisationId}`,
        ])
        const submitted = Boolean(row.submitted_at)
        // Submitted reports show the questions as they were answered; open ones use today's questions.
        const shown = submitted
          ? answers.map((a) => {
              const q = questions.find((x) => x.id === a.question_id)
              return { id: a.question_id, prompt: a.question_prompt, options: q?.options ?? a.choices, multiple: q?.multiple ?? a.choices.length > 1 }
            })
          : questions.filter((q) => !q.archived).map((q) => ({ id: q.id, prompt: q.prompt, options: q.options, multiple: q.multiple }))
        const mayWrite = can(scope, row.cohort_course_id).report
        // Editable until it's due; a late report is final when submitted.
        const editable = mayWrite && (!submitted || (row.submitted_at! <= row.due_at && t <= row.due_at))
        return c.json({
          timeZone: org!.time_zone,
          session: {
            id: row.session_id,
            course: row.course_name,
            cohort: { id: row.cohort_id, name: row.cohort_name },
            number: row.number,
            startsAt: row.starts_at,
            endsAt: row.ends_at,
            attendance: att,
            feedback: feedback!.n,
          },
          trainer: row.trainer_id ? { id: row.trainer_id, name: name(row.trainer_first, row.trainer_last), email: isAdmin(auth) ? row.trainer_email : null } : null,
          dueAt: row.due_at,
          state: stateOf(row, t),
          questions: shown,
          report: report
            ? {
                summary: report.summary,
                answers: Object.fromEntries(answers.filter((a) => a.question_id).map((a) => [a.question_id!, a.choices])),
                submittedAt: row.submitted_at,
                savedAt: report.updated_at,
                author: report.author_id === auth.memberId ? 'You' : name(report.author_first, report.author_last),
                onTime: row.submitted_at ? row.submitted_at <= row.due_at : null,
              }
            : null,
          can: { write: editable, edit: editable && submitted },
        })
      })

      // T5.01 Save draft or submit.
      .put('/:sessionId', async (c) => {
        const body = await parseBody(c, Save)
        const auth = c.var.auth
        const { row, scope } = await findReport(auth, c.req.param('sessionId'))
        if (!can(scope, row.cohort_course_id).report) {
          throw forbidden(scope.admin ? 'Session reports are written by the session’s trainer.' : 'Your organisation doesn’t let assistant trainers write session reports.')
        }
        const t = now()
        if (row.submitted_at && (row.submitted_at > row.due_at || t > row.due_at)) {
          throw new AppError(409, 'report_locked', 'This report is locked because its due time has passed. Ask an admin if something needs correcting.')
        }
        if (row.submitted_at && !body.submit) throw new AppError(409, 'already_submitted', 'This report is already submitted. Submit again to save your changes.')
        const questions = await deps.sql<{ id: string; prompt: string; options: string[]; multiple: boolean }[]>`
          select id, prompt, options, multiple from public.report_questions where organisation_id = ${auth.organisationId} and archived_at is null order by position, created_at
        `
        const details: { field: string; message: string }[] = []
        const chosen = new Map(body.answers.map((a) => [a.questionId, [...new Set(a.choices)]]))
        for (const [i, q] of questions.entries()) {
          const choices = chosen.get(q.id) ?? []
          if (choices.some((x) => !q.options.includes(x))) details.push({ field: `answers.${q.id}`, message: 'Choose one of the options.' })
          else if (body.submit && choices.length === 0) details.push({ field: `answers.${q.id}`, message: `Answer question ${i + 1}.` })
          else if (!q.multiple && choices.length > 1) details.push({ field: `answers.${q.id}`, message: 'Choose one option.' })
        }
        if (body.submit && !body.summary.trim()) details.push({ field: 'summary', message: 'Write a short summary.' })
        if (details.length) throw new AppError(400, 'bad_request', 'Some answers need attention.', details)

        await deps.sql.begin(async (tx) => {
          const [report] = await tx<{ id: string }[]>`
            insert into public.session_reports (organisation_id, session_id, author_member_id, summary, submitted_at, updated_at)
            values (${auth.organisationId}, ${row.session_id}, ${auth.memberId}, ${body.summary.trim()}, ${body.submit ? t : null}, ${t})
            on conflict (session_id) do update
              set summary = excluded.summary, author_member_id = excluded.author_member_id, updated_at = excluded.updated_at,
                  submitted_at = coalesce(public.session_reports.submitted_at, excluded.submitted_at)
            returning id
          `
          await tx`delete from public.session_report_answers where report_id = ${report!.id}`
          for (const q of questions) {
            const choices = chosen.get(q.id) ?? []
            if (!choices.length) continue
            const ordered = q.options.filter((o) => choices.includes(o))
            await tx`
              insert into public.session_report_answers (organisation_id, report_id, question_id, question_prompt, answer, choices)
              values (${auth.organisationId}, ${report!.id}, ${q.id}, ${q.prompt}, ${ordered.join(', ')}, ${ordered})
            `
          }
          await audit(tx, {
            organisationId: auth.organisationId,
            actorMemberId: auth.memberId,
            action: body.submit ? (row.submitted_at ? 'session_report.updated' : 'session_report.submitted') : 'session_report.draft_saved',
            entityType: 'session',
            entityId: row.session_id,
            data: { late: body.submit && !row.submitted_at ? t > row.due_at : undefined },
            requestId: c.var.requestId,
          })
        })
        return c.json({ saved: true, submitted: body.submit })
      })

      // C3.01 Remind: email the session's trainer about an overdue report.
      .post('/:sessionId/remind', async (c) => {
        const auth = c.var.auth
        if (!isAdmin(auth)) throw forbidden('Only admins can send reminders.')
        const { row } = await findReport(auth, c.req.param('sessionId'))
        if (row.submitted_at) throw new AppError(409, 'already_submitted', 'This report has been submitted.')
        if (!row.trainer_email) throw new AppError(409, 'no_trainer', 'This session has no trainer to remind.')
        const [org] = await deps.sql<{ name: string; time_zone: string }[]>`select name, time_zone from public.organisations where id = ${auth.organisationId}`
        const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: org!.time_zone }).format(row.starts_at).replace(',', '')
        const subject = `Session report ${stateOf(row, now()) === 'overdue' ? 'overdue' : 'due'}: ${row.course_name}, ${day}`
        const { text, html } = renderEmail({
          title: subject,
          intro: `Hi ${row.trainer_first}, please submit your session report for ${row.course_name} in ${row.cohort_name} on ${day}. It takes a couple of minutes — a few multiple-choice questions and a short summary.`,
          buttonLabel: 'Write report',
          buttonUrl: `${deps.appUrl.replace(/\/$/, '')}/trainer/reports/${row.session_id}`,
          note: `Sent by ${org!.name} through Synqop.`,
        })
        await deps.mailer.send({ to: row.trainer_email, subject, text, html })
        await audit(deps.sql, { organisationId: auth.organisationId, actorMemberId: auth.memberId, action: 'session_report.reminded', entityType: 'session', entityId: row.session_id, requestId: c.var.requestId })
        return c.json({ sent: true, to: name(row.trainer_first, row.trainer_last) })
      })
  )
}
