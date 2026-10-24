import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import type { AuthContext } from '../lib/auth.js'
import { audit, type Sql, type Tx } from '../lib/db.js'
import { AppError, notFound } from '../lib/errors.js'
import { MAX_FILE_BYTES, safeFileName } from '../lib/storage.js'
import { optionalText, parseBody, uuid } from '../lib/validation.js'
import { requireAuth, requireRole, type AuthVariables } from '../middleware/auth.js'
import { gradeDisplay, scaleLabel, type Scale } from './assignments.js'

const Upload = z.object({
  name: z.string().trim().min(1).max(200),
  size: z.number().int().min(1, 'This file is empty.').max(MAX_FILE_BYTES, 'Files can be up to 25 MB.'),
  type: z.string().max(200).nullish(),
})

const Submit = z.discriminatedUnion('type', [
  z.object({ type: z.literal('file'), file: z.object({ path: z.string().min(1).max(500), name: z.string().trim().min(1).max(200) }), note: optionalText(1000) }),
  z.object({
    type: z.literal('link'),
    link: z
      .string()
      .trim()
      .max(500)
      .refine((value) => /^https?:\/\/\S+$/.test(value), 'Paste the full link, starting with https://'),
    note: optionalText(1000),
  }),
  z.object({ type: z.literal('text'), text: z.string().trim().min(1, 'Write your answer.').max(20000), note: optionalText(1000) }),
])

const fieldError = (field: string, message: string) => new AppError(400, 'bad_request', 'Some fields need attention.', [{ field, message }])

/** What a participant sees for one assignment. */
type MyStatus = 'not_submitted' | 'overdue' | 'closed' | 'submitted' | 'late' | 'graded'

interface MyRow {
  id: string
  title: string
  brief: string | null
  due_at: Date
  submission_types: string[]
  late_policy: 'accept_late' | 'closed'
  grading_scale: Scale
  max_points: string | null
  course_id: string
  course_name: string
  cohort_id: string
  cohort_name: string
  enrolment_status: string
  trainer_first: string | null
  trainer_last: string | null
  criteria_count: number
  submission_id: string | null
  submitted_at: Date | null
  is_late: boolean | null
  text_body: string | null
  link_url: string | null
  note: string | null
  grade_id: string | null
  points: string | null
  percentage: string | null
  letter: string | null
  passed: boolean | null
  feedback: string | null
  graded_at: Date | null
  graded_by_first: string | null
  graded_by_last: string | null
  total: number | null
}

/** Published assignments in the participant's cohorts (active or completed), with their own work and grade. */
function selectMine(sql: Sql | Tx, auth: AuthContext, id?: string) {
  return sql<MyRow[]>`
    select a.id, a.title, a.brief, a.due_at, a.submission_types::text[] as submission_types, a.late_policy, a.grading_scale, a.max_points,
           co.id as course_id, co.name as course_name, h.id as cohort_id, h.name as cohort_name, e.status as enrolment_status,
           coalesce(lt.first_name, cb.first_name) as trainer_first, coalesce(lt.last_name, cb.last_name) as trainer_last,
           (select count(*)::int from public.rubric_criteria r where r.assignment_id = a.id) as criteria_count,
           s.id as submission_id, s.submitted_at, s.is_late, s.text_body, s.link_url, s.note,
           g.id as grade_id, g.points, g.percentage, g.letter, g.passed, g.feedback, g.graded_at,
           gb.first_name as graded_by_first, gb.last_name as graded_by_last,
           (select sum(r.score)::int from public.rubric_scores r where r.grade_id = g.id) as total
    from public.enrolments e
    join public.cohort_courses x on x.cohort_id = e.cohort_id
    join public.assignments a on a.cohort_course_id = x.id and a.published_at is not null
    join public.courses co on co.id = x.course_id
    join public.cohorts h on h.id = x.cohort_id
    left join public.cohort_course_trainers ct on ct.cohort_course_id = x.id and ct.is_lead
    left join public.organisation_members lt on lt.id = ct.member_id
    left join public.organisation_members cb on cb.id = a.created_by
    left join public.submissions s on s.assignment_id = a.id and s.member_id = e.member_id
    left join public.grades g on g.submission_id = s.id
    left join public.organisation_members gb on gb.id = g.graded_by
    where e.member_id = ${auth.memberId} and e.organisation_id = ${auth.organisationId}
      and e.status in ('active', 'completed')
      ${id ? sql`and a.id = ${id}` : sql``}
    order by a.due_at, a.title
  `
}

function statusOf(r: MyRow, now: number): MyStatus {
  if (r.grade_id) return 'graded'
  if (r.submission_id) return r.is_late ? 'late' : 'submitted'
  if (r.due_at.getTime() > now) return 'not_submitted'
  return r.late_policy === 'accept_late' ? 'overdue' : 'closed'
}

/** Whether the participant can hand in (or replace) work right now, and why not. */
function submitState(r: MyRow, now: number): { canSubmit: boolean; reason: 'graded' | 'replace_closed' | 'closed' | 'enrolment' | null } {
  if (r.enrolment_status !== 'active') return { canSubmit: false, reason: 'enrolment' }
  if (r.grade_id) return { canSubmit: false, reason: 'graded' }
  const pastDue = r.due_at.getTime() <= now
  if (!pastDue) return { canSubmit: true, reason: null }
  if (r.submission_id) return { canSubmit: false, reason: 'replace_closed' }
  return r.late_policy === 'accept_late' ? { canSubmit: true, reason: null } : { canSubmit: false, reason: 'closed' }
}

const name = (first: string | null, last: string | null) => (first ? `${first} ${last ?? ''}`.trim() : null)

function summary(r: MyRow, now: number) {
  const maxPoints = r.max_points === null ? null : Number(r.max_points)
  return {
    id: r.id,
    title: r.title,
    course: { id: r.course_id, name: r.course_name },
    cohort: { id: r.cohort_id, name: r.cohort_name },
    trainer: name(r.trainer_first, r.trainer_last),
    dueAt: r.due_at,
    status: statusOf(r, now),
    submittedAt: r.submitted_at,
    gradingScale: r.grading_scale,
    maxPoints,
    scaleLabel: scaleLabel(r.grading_scale, maxPoints, r.criteria_count),
    grade: r.grade_id ? gradeDisplay(r.grading_scale, maxPoints, r.criteria_count, r) : null,
    gradedAt: r.graded_at,
  }
}

/** /v1/my — the signed-in participant's own work (P5 assignments, P6 grades & feedback). */
export function myRoutes(deps: AppDeps) {
  const now = () => (deps.now ? deps.now() : new Date()).getTime()

  async function timeZoneOf(organisationId: string) {
    const [row] = await deps.sql<{ time_zone: string }[]>`select time_zone from public.organisations where id = ${organisationId}`
    return row!.time_zone
  }

  async function findMine(auth: AuthContext, id: string) {
    if (!uuid.safeParse(id).success) throw notFound('Assignment not found.')
    const [row] = await selectMine(deps.sql, auth, id)
    if (!row) throw notFound('Assignment not found.')
    return row
  }

  const uploadPrefix = (auth: AuthContext, assignmentId: string) => `${auth.organisationId}/submissions/${assignmentId}/${auth.memberId}/`

  return (
    new Hono<{ Variables: AuthVariables }>()
      .use(requireAuth(deps), requireRole('participant'))

      // P5.01 Assignments.
      .get('/assignments', async (c) => {
        const t = now()
        const [rows, timeZone] = await Promise.all([selectMine(deps.sql, c.var.auth), timeZoneOf(c.var.auth.organisationId)])
        return c.json({ timeZone, assignments: rows.map((r) => summary(r, t)) })
      })

      // P5.02 / P5.03 / P6.02 One assignment with my submission and grade.
      .get('/assignments/:id', async (c) => {
        const auth = c.var.auth
        const r = await findMine(auth, c.req.param('id'))
        const t = now()
        const [materials, criteria, files, scores, timeZone] = await Promise.all([
          deps.sql<{ id: string; kind: string; name: string; url: string | null; size_bytes: string | null }[]>`
            select id, kind, name, url, size_bytes from public.assignment_materials where assignment_id = ${r.id} order by created_at
          `,
          deps.sql<{ id: string; title: string; description: string | null }[]>`
            select id, title, description from public.rubric_criteria where assignment_id = ${r.id} order by position, title
          `,
          r.submission_id
            ? deps.sql<{ id: string; name: string; size_bytes: string; mime_type: string | null }[]>`
                select id, name, size_bytes, mime_type from public.submission_files where submission_id = ${r.submission_id} order by created_at
              `
            : [],
          r.grade_id ? deps.sql<{ criterion_id: string; score: number }[]>`select criterion_id, score from public.rubric_scores where grade_id = ${r.grade_id}` : [],
          timeZoneOf(auth.organisationId),
        ])
        const state = submitState(r, t)
        return c.json({
          timeZone,
          assignment: {
            ...summary(r, t),
            brief: r.brief,
            submissionTypes: r.submission_types,
            latePolicy: r.late_policy,
            links: materials.filter((m) => m.kind === 'link').map((m) => ({ name: m.name, url: m.url })),
            files: materials.filter((m) => m.kind === 'file').map((m) => ({ id: m.id, name: m.name, size: Number(m.size_bytes ?? 0) })),
            criteria,
            canSubmit: state.canSubmit,
            cantSubmitBecause: state.reason,
          },
          submission: r.submission_id
            ? {
                submittedAt: r.submitted_at,
                late: Boolean(r.is_late),
                text: r.text_body,
                link: r.link_url,
                note: r.note,
                files: files.map((f) => ({ id: f.id, name: f.name, size: Number(f.size_bytes), type: f.mime_type })),
              }
            : null,
          grade: r.grade_id
            ? {
                display: gradeDisplay(r.grading_scale, r.max_points === null ? null : Number(r.max_points), r.criteria_count, r),
                feedback: r.feedback,
                rubric: scores.map((s) => ({ criterionId: s.criterion_id, score: s.score })),
                gradedAt: r.graded_at,
                gradedBy: name(r.graded_by_first, r.graded_by_last),
              }
            : null,
        })
      })

      // P5.02 File: ask for a one-time upload link, upload straight to storage, then submit with the path.
      .post('/assignments/:id/uploads', async (c) => {
        const body = await parseBody(c, Upload)
        const auth = c.var.auth
        const r = await findMine(auth, c.req.param('id'))
        if (!r.submission_types.includes('file')) throw new AppError(400, 'bad_request', 'This assignment doesn’t take files.')
        if (!submitState(r, now()).canSubmit) throw new AppError(409, 'submissions_closed', 'You can’t submit this assignment now.')
        const path = `${uploadPrefix(auth, r.id)}${randomUUID()}/${safeFileName(body.name)}`
        return c.json({ upload: await deps.storage.createUpload(path) })
      })

      // P5.02 Submit, or replace before the due time. Late work is marked late when the assignment allows it.
      .put('/assignments/:id/submission', async (c) => {
        const body = await parseBody(c, Submit)
        const auth = c.var.auth
        const r = await findMine(auth, c.req.param('id'))
        const t = now()
        const state = submitState(r, t)
        if (!state.canSubmit) {
          const messages = {
            graded: 'This has been graded, so it can’t be replaced.',
            replace_closed: 'The due time has passed, so your submission can’t be replaced.',
            closed: 'Submissions are closed. This assignment doesn’t accept late work.',
            enrolment: 'You’re not active in this cohort, so you can’t submit.',
          } as const
          throw new AppError(409, state.reason === 'closed' ? 'submissions_closed' : state.reason ?? 'submissions_closed', messages[state.reason!])
        }
        if (!r.submission_types.includes(body.type)) throw fieldError('type', 'This assignment doesn’t take this kind of submission.')
        let file: { path: string; name: string; size: number; type: string | null } | null = null
        if (body.type === 'file') {
          if (!body.file.path.startsWith(uploadPrefix(auth, r.id)) || body.file.path.includes('..')) throw fieldError('file', 'Upload the file again.')
          const stat = await deps.storage.stat(body.file.path)
          if (!stat) throw fieldError('file', 'The upload didn’t finish. Choose the file again.')
          if (stat.size > MAX_FILE_BYTES) {
            await deps.storage.remove([body.file.path])
            throw fieldError('file', 'Files can be up to 25 MB.')
          }
          file = { path: body.file.path, name: body.file.name, size: stat.size, type: stat.type }
        }
        const late = r.due_at.getTime() <= t
        const replaced = await deps.sql.begin(async (tx) => {
          const old = r.submission_id
            ? await tx<{ storage_path: string }[]>`delete from public.submission_files where submission_id = ${r.submission_id} returning storage_path`
            : []
          const [s] = await tx<{ id: string }[]>`
            insert into public.submissions (organisation_id, assignment_id, member_id, text_body, link_url, note, is_late, submitted_at)
            values (${auth.organisationId}, ${r.id}, ${auth.memberId}, ${body.type === 'text' ? body.text : null},
                    ${body.type === 'link' ? body.link : null}, ${body.note}, ${late}, now())
            on conflict (assignment_id, member_id) do update set
              text_body = excluded.text_body, link_url = excluded.link_url, note = excluded.note,
              is_late = excluded.is_late, submitted_at = excluded.submitted_at, updated_at = now()
            returning id
          `
          if (file) {
            await tx`
              insert into public.submission_files (organisation_id, submission_id, name, storage_path, size_bytes, mime_type)
              values (${auth.organisationId}, ${s!.id}, ${file.name}, ${file.path}, ${file.size}, ${file.type})
            `
          }
          await audit(tx, {
            organisationId: auth.organisationId,
            actorMemberId: auth.memberId,
            action: r.submission_id ? 'submission.replaced' : 'submission.created',
            entityType: 'submission',
            entityId: s!.id,
            data: { assignmentId: r.id, type: body.type, late },
            requestId: c.var.requestId,
          })
          return old.map((o) => o.storage_path).filter((p) => p !== file?.path)
        })
        // Old files go once the new submission is saved; a failure here only leaves an orphan.
        await deps.storage.remove(replaced).catch(() => undefined)
        return c.json({ ok: true, late })
      })

      // Download a file from the brief or from my own submission.
      .get('/assignments/:id/files/:fileId', async (c) => {
        const auth = c.var.auth
        const r = await findMine(auth, c.req.param('id'))
        const fileId = c.req.param('fileId')
        if (!uuid.safeParse(fileId).success) throw notFound('File not found.')
        const [file] = await deps.sql<{ name: string; storage_path: string }[]>`
          select name, storage_path from public.assignment_materials where id = ${fileId} and assignment_id = ${r.id} and kind = 'file'
          union all
          select f.name, f.storage_path from public.submission_files f
          join public.submissions s on s.id = f.submission_id
          where f.id = ${fileId} and s.assignment_id = ${r.id} and s.member_id = ${auth.memberId}
        `
        if (!file) throw notFound('File not found.')
        return c.json({ url: await deps.storage.downloadUrl(file.storage_path, file.name) })
      })

      // P6.01 Grades & feedback: everything handed in, graded or waiting.
      .get('/grades', async (c) => {
        const t = now()
        const [rows, timeZone] = await Promise.all([selectMine(deps.sql, c.var.auth), timeZoneOf(c.var.auth.organisationId)])
        const handedIn = rows
          .filter((r) => r.submission_id)
          .sort((x, y) => (y.graded_at ?? y.submitted_at!).getTime() - (x.graded_at ?? x.submitted_at!).getTime())
        return c.json({ timeZone, grades: handedIn.map((r) => ({ ...summary(r, t), hasFeedback: Boolean(r.feedback) })) })
      })
  )
}
