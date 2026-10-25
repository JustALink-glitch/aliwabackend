import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { deliver } from '../lib/notifications.js'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { audit, type Sql, type Tx } from '../lib/db.js'
import { AppError, forbidden, notFound } from '../lib/errors.js'
import { MAX_FILE_BYTES, safeFileName } from '../lib/storage.js'
import { isoDate, optionalText, parseBody, uuid } from '../lib/validation.js'
import type { AuthContext } from '../lib/auth.js'
import { requireAuth, requireRole, type AuthVariables } from '../middleware/auth.js'

const SCALES = ['points', 'percentage', 'letter', 'pass_fail', 'rubric'] as const
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'] as const
export type Scale = (typeof SCALES)[number]

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Enter a time like 23:59.')

const link = z.object({
  name: optionalText(200),
  url: z
    .string()
    .trim()
    .max(500)
    .refine((value) => /^https?:\/\/\S+$/.test(value), 'Paste the full link, starting with https://'),
})

const criterion = z.object({
  id: uuid.optional(),
  title: z.string().trim().min(1, 'Name the criterion.').max(120),
  description: optionalText(300),
})

const Fields = z.object({
  cohortCourseId: uuid,
  title: z.string().trim().min(1, 'Enter a title.').max(200),
  brief: optionalText(5000),
  links: z.array(link).max(10).default([]),
  /** Files to keep (by id) and newly uploaded ones (by storage path). Anything left out is removed. */
  files: z
    .array(z.union([z.object({ id: uuid }), z.object({ path: z.string().min(1).max(500), name: z.string().trim().min(1).max(200) })]))
    .max(10, 'Attach up to 10 files.')
    .default([]),
  dueDate: isoDate,
  dueTime: time,
  submissionTypes: z.array(z.enum(['file', 'link', 'text'])).min(1, 'Choose at least one way to submit.'),
  latePolicy: z.enum(['accept_late', 'closed']),
  gradingScale: z.enum(SCALES),
  maxPoints: z.number().positive('Enter points above 0.').max(10000).nullish(),
  criteria: z.array(criterion).max(12, 'Use at most 12 criteria.').default([]),
  publish: z.boolean().default(false),
})

function checkScale(v: z.infer<typeof Fields>, ctx: z.RefinementCtx) {
  if (v.gradingScale === 'points' && !v.maxPoints) ctx.addIssue({ code: 'custom', path: ['maxPoints'], message: 'Enter the points it’s out of.' })
  if (v.gradingScale === 'rubric' && v.criteria.length === 0) ctx.addIssue({ code: 'custom', path: ['criteria'], message: 'Add at least one criterion.' })
}

const Create = Fields.superRefine(checkScale)
const Edit = Fields.superRefine(checkScale)

const Upload = z.object({
  name: z.string().trim().min(1).max(200),
  size: z.number().int().min(1, 'This file is empty.').max(MAX_FILE_BYTES, 'Files can be up to 25 MB.'),
  type: z.string().max(200).nullish(),
})

type FileInput = z.infer<typeof Fields>['files'][number]

const Grade = z.object({
  points: z.number().nullish(),
  percentage: z.number().nullish(),
  letter: z.enum(LETTERS).nullish(),
  passed: z.boolean().nullish(),
  rubric: z.array(z.object({ criterionId: uuid, score: z.number().int().min(1).max(4) })).nullish(),
  feedback: optionalText(5000),
})

const fieldError = (field: string, message: string) => new AppError(400, 'bad_request', 'Some fields need attention.', [{ field, message }])

const STAFF = ['owner', 'admin', 'trainer', 'assistant_trainer'] as const
const isAdmin = (auth: AuthContext) => auth.role === 'owner' || auth.role === 'admin'

interface Permissions {
  admin: boolean
  /** Cohort courses this trainer teaches. Admins: null (all). */
  teaches: Set<string> | null
  canCreate: boolean
  canGrade: boolean
}

async function permissionsOf(sql: Sql | Tx, auth: AuthContext): Promise<Permissions> {
  if (isAdmin(auth)) return { admin: true, teaches: null, canCreate: true, canGrade: true }
  const [[settings], rows] = await Promise.all([
    sql<{ create: boolean; grade: boolean }[]>`
      select assistant_can_create_assignments and assistants_enabled as create, assistant_can_grade and assistants_enabled as grade
      from public.organisation_settings where organisation_id = ${auth.organisationId}
    `,
    sql<{ id: string }[]>`select cohort_course_id as id from public.cohort_course_trainers where member_id = ${auth.memberId}`,
  ])
  const assistant = auth.role === 'assistant_trainer'
  return {
    admin: false,
    teaches: new Set(rows.map((r) => r.id)),
    canCreate: !assistant || Boolean(settings?.create),
    canGrade: !assistant || Boolean(settings?.grade ?? true),
  }
}

const teaches = (p: Permissions, cohortCourseId: string) => p.teaches === null || p.teaches.has(cohortCourseId)

interface AssignmentRow {
  id: string
  cohort_course_id: string
  title: string
  brief: string | null
  due_at: Date
  submission_types: string[]
  late_policy: 'accept_late' | 'closed'
  grading_scale: Scale
  max_points: string | null
  published_at: Date | null
  created_at: Date
  course_id: string
  course_name: string
  cohort_id: string
  cohort_name: string
  cohort_status: string
  programme_id: string
  programme_name: string
  set_by_id: string | null
  set_by_first: string | null
  set_by_last: string | null
  set_by_email: string | null
  criteria_count: number
  expected: number
  submitted: number
  graded: number
  late: number
  to_grade: number
  overdue: number
}

function selectAssignments(sql: Sql | Tx, organisationId: string, filter: { id?: string; cohortCourseIds?: string[] | null; publishedOnly?: boolean }) {
  return sql<AssignmentRow[]>`
    with expected as (
      select a.id as assignment_id, e.member_id
      from public.assignments a
      join public.cohort_courses x on x.id = a.cohort_course_id
      join public.enrolments e on e.cohort_id = x.cohort_id and e.status = 'active'
      where a.organisation_id = ${organisationId}
    )
    select a.id, a.cohort_course_id, a.title, a.brief, a.due_at, a.submission_types::text[] as submission_types, a.late_policy,
           a.grading_scale, a.max_points, a.published_at, a.created_at,
           co.id as course_id, co.name as course_name, h.id as cohort_id, h.name as cohort_name, public.status(h) as cohort_status,
           p.id as programme_id, p.name as programme_name,
           m.id as set_by_id, m.first_name as set_by_first, m.last_name as set_by_last, m.email as set_by_email,
           (select count(*)::int from public.rubric_criteria r where r.assignment_id = a.id) as criteria_count,
           (select count(*)::int from expected ex where ex.assignment_id = a.id) as expected,
           (select count(*)::int from public.submissions s where s.assignment_id = a.id) as submitted,
           (select count(*)::int from public.submissions s join public.grades g on g.submission_id = s.id where s.assignment_id = a.id) as graded,
           (select count(*)::int from public.submissions s where s.assignment_id = a.id and s.is_late) as late,
           (select count(*)::int from public.submissions s where s.assignment_id = a.id
              and not exists (select 1 from public.grades g where g.submission_id = s.id)) as to_grade,
           case when a.due_at < now() then
             (select count(*)::int from expected ex where ex.assignment_id = a.id
                and not exists (select 1 from public.submissions s where s.assignment_id = a.id and s.member_id = ex.member_id))
           else 0 end as overdue
    from public.assignments a
    join public.cohort_courses x on x.id = a.cohort_course_id
    join public.courses co on co.id = x.course_id
    join public.cohorts h on h.id = x.cohort_id
    join public.programmes p on p.id = x.programme_id
    left join public.organisation_members m on m.id = a.created_by
    where a.organisation_id = ${organisationId}
      ${filter.id ? sql`and a.id = ${filter.id}` : sql``}
      ${filter.cohortCourseIds ? sql`and a.cohort_course_id = any(${filter.cohortCourseIds}::uuid[])` : sql``}
      ${filter.publishedOnly ? sql`and a.published_at is not null` : sql``}
    order by a.due_at desc, a.created_at desc
  `
}

export function scaleLabel(scale: Scale, maxPoints: number | null, criteria: number) {
  switch (scale) {
    case 'points':
      return `Points / ${maxPoints}`
    case 'percentage':
      return 'Percentage'
    case 'letter':
      return 'Letter grade'
    case 'pass_fail':
      return 'Pass / Fail'
    case 'rubric':
      return `Rubric · ${criteria} ${criteria === 1 ? 'criterion' : 'criteria'}`
  }
}

function toSummary(row: AssignmentRow, p: Permissions) {
  const maxPoints = row.max_points === null ? null : Number(row.max_points)
  const draft = row.published_at === null
  const mine = teaches(p, row.cohort_course_id)
  return {
    id: row.id,
    title: row.title,
    status: draft ? 'draft' : row.due_at.getTime() < Date.now() ? 'closed' : 'open',
    dueAt: row.due_at,
    publishedAt: row.published_at,
    gradingScale: row.grading_scale,
    maxPoints,
    criteriaCount: row.criteria_count,
    scaleLabel: scaleLabel(row.grading_scale, maxPoints, row.criteria_count),
    latePolicy: row.late_policy,
    submissionTypes: row.submission_types,
    course: { id: row.course_id, name: row.course_name },
    cohort: { id: row.cohort_id, name: row.cohort_name },
    programme: { id: row.programme_id, name: row.programme_name },
    cohortCourseId: row.cohort_course_id,
    setBy: row.set_by_id ? { id: row.set_by_id, name: `${row.set_by_first} ${row.set_by_last}`.trim(), email: row.set_by_email } : null,
    counts: { expected: row.expected, submitted: row.submitted, graded: row.graded, toGrade: row.to_grade, late: row.late, overdue: row.overdue },
    canEdit: mine && p.canCreate,
    canGrade: mine && p.canGrade && !draft,
  }
}

interface GradeValues {
  points: string | null
  percentage: string | null
  letter: string | null
  passed: boolean | null
  total: number | null
}

/** One grade as participants see it: "78 / 100", "86%", "B", "Pass", "12 / 16". */
export function gradeDisplay(scale: Scale, maxPoints: number | null, criteria: number, g: GradeValues): string | null {
  switch (scale) {
    case 'points':
      return g.points === null ? null : `${Number(g.points)} / ${maxPoints}`
    case 'percentage':
      return g.percentage === null ? null : `${Number(g.percentage)}%`
    case 'letter':
      return g.letter
    case 'pass_fail':
      return g.passed === null ? null : g.passed ? 'Pass' : 'Fail'
    case 'rubric':
      return g.total === null ? null : `${g.total} / ${criteria * 4}`
  }
}

type ParticipantStatus = 'not_submitted' | 'overdue' | 'submitted' | 'late' | 'graded'

function participantStatus(a: { due_at: Date; late_policy: string; published_at: Date | null }, s: { submitted: boolean; late: boolean; graded: boolean }): ParticipantStatus {
  if (s.graded) return 'graded'
  if (s.submitted) return s.late ? 'late' : 'submitted'
  return a.published_at && a.due_at.getTime() < Date.now() && a.late_policy === 'accept_late' ? 'overdue' : 'not_submitted'
}

/** /v1/assignments — T6 (trainers, own courses) and C4 (admins, everything). */
export function assignmentRoutes(deps: AppDeps) {
  async function timeZoneOf(sql: Sql | Tx, organisationId: string) {
    const [row] = await sql<{ time_zone: string }[]>`select time_zone from public.organisations where id = ${organisationId}`
    return row!.time_zone
  }

  async function findAssignment(sql: Sql | Tx, auth: AuthContext, p: Permissions, id: string) {
    if (!uuid.safeParse(id).success) throw notFound('Assignment not found.')
    const [row] = await selectAssignments(sql, auth.organisationId, { id })
    // Trainers only see their own courses; drafts are private to the course's trainers.
    if (!row || !teaches(p, row.cohort_course_id) || (row.published_at === null && p.admin)) throw notFound('Assignment not found.')
    return row
  }

  async function checkCourse(sql: Sql | Tx, auth: AuthContext, p: Permissions, cohortCourseId: string) {
    const [course] = await sql<{ status: string }[]>`
      select public.status(h) as status from public.cohort_courses x join public.cohorts h on h.id = x.cohort_id
      where x.id = ${cohortCourseId} and x.organisation_id = ${auth.organisationId}
    `
    if (!course || !teaches(p, cohortCourseId)) throw fieldError('cohortCourseId', 'Choose a course you teach.')
    if (course.status === 'archived') throw fieldError('cohortCourseId', 'This cohort is archived.')
  }

  async function checkAllowedScale(sql: Sql | Tx, organisationId: string, scale: Scale) {
    const [row] = await sql<{ scales: string[] }[]>`
      select allowed_grading_scales::text[] as scales from public.organisation_settings where organisation_id = ${organisationId}
    `
    if (row && !row.scales.includes(scale)) throw fieldError('gradingScale', 'Your organisation doesn’t use this grading scale.')
  }

  async function dueAt(sql: Sql | Tx, organisationId: string, date: string, time: string) {
    const tz = await timeZoneOf(sql, organisationId)
    const [row] = await sql<{ at: Date }[]>`select (${date}::date + ${time}::time) at time zone ${tz} as at`
    return row!.at
  }

  async function saveCriteria(tx: Tx, organisationId: string, assignmentId: string, criteria: z.infer<typeof criterion>[]) {
    await tx`delete from public.rubric_criteria where assignment_id = ${assignmentId}`
    for (const [position, c] of criteria.entries()) {
      await tx`
        insert into public.rubric_criteria (organisation_id, assignment_id, title, description, position)
        values (${organisationId}, ${assignmentId}, ${c.title}, ${c.description}, ${position})
      `
    }
  }

  async function saveLinks(tx: Tx, organisationId: string, assignmentId: string, links: z.infer<typeof link>[]) {
    await tx`delete from public.assignment_materials where assignment_id = ${assignmentId} and kind = 'link'`
    for (const l of links) {
      await tx`
        insert into public.assignment_materials (organisation_id, assignment_id, kind, name, url)
        values (${organisationId}, ${assignmentId}, 'link', ${l.name ?? l.url.replace(/^https?:\/\//, '').slice(0, 200)}, ${l.url})
      `
    }
  }

  const materialsPrefix = (organisationId: string) => `${organisationId}/materials/`

  /** Checks newly uploaded files before saving: they must be ours and actually uploaded. */
  async function prepareFiles(organisationId: string, files: FileInput[]) {
    const fresh: { path: string; name: string; size: number; type: string | null }[] = []
    for (const [i, f] of files.entries()) {
      if (!('path' in f)) continue
      if (!f.path.startsWith(materialsPrefix(organisationId)) || f.path.includes('..')) throw fieldError(`files.${i}`, 'Attach the file again.')
      const stat = await deps.storage.stat(f.path)
      if (!stat) throw fieldError(`files.${i}`, `${f.name} didn’t finish uploading. Attach it again.`)
      if (stat.size > MAX_FILE_BYTES) throw fieldError(`files.${i}`, 'Files can be up to 25 MB.')
      fresh.push({ path: f.path, name: f.name, size: stat.size, type: stat.type })
    }
    return { keep: files.flatMap((f) => ('id' in f ? [f.id] : [])), fresh }
  }

  /** Replaces the assignment's files; returns storage paths to delete after the transaction. */
  async function saveFiles(tx: Tx, organisationId: string, assignmentId: string, files: Awaited<ReturnType<typeof prepareFiles>>) {
    const removed = await tx<{ storage_path: string }[]>`
      delete from public.assignment_materials
      where assignment_id = ${assignmentId} and kind = 'file' and not (id = any(${files.keep}::uuid[]))
      returning storage_path
    `
    for (const f of files.fresh) {
      await tx`
        insert into public.assignment_materials (organisation_id, assignment_id, kind, name, storage_path, size_bytes, mime_type)
        values (${organisationId}, ${assignmentId}, 'file', ${f.name}, ${f.path}, ${f.size}, ${f.type})
      `
    }
    return removed.map((r) => r.storage_path)
  }

  async function criteriaOf(sql: Sql | Tx, assignmentId: string) {
    return sql<{ id: string; title: string; description: string | null }[]>`
      select id, title, description from public.rubric_criteria where assignment_id = ${assignmentId} order by position, title
    `
  }

  /** Everyone expected (active in the cohort) plus anyone who submitted, with their grade. */
  function selectRows(sql: Sql | Tx, a: AssignmentRow) {
    return sql<
      {
        member_id: string
        first_name: string
        last_name: string
        email: string
        submission_id: string | null
        submitted_at: Date | null
        is_late: boolean | null
        grade_id: string | null
        points: string | null
        percentage: string | null
        letter: string | null
        passed: boolean | null
        total: number | null
      }[]
    >`
      select m.id as member_id, m.first_name, m.last_name, m.email,
             s.id as submission_id, s.submitted_at, s.is_late,
             g.id as grade_id, g.points, g.percentage, g.letter, g.passed,
             (select sum(r.score)::int from public.rubric_scores r where r.grade_id = g.id) as total
      from public.organisation_members m
      left join public.enrolments e on e.member_id = m.id and e.cohort_id = ${a.cohort_id}
      left join public.submissions s on s.member_id = m.id and s.assignment_id = ${a.id}
      left join public.grades g on g.submission_id = s.id
      where m.organisation_id = (select organisation_id from public.assignments where id = ${a.id})
        and (e.status = 'active' or s.id is not null)
      order by m.first_name, m.last_name
    `
  }

  function rowsOf(a: AssignmentRow, rows: Awaited<ReturnType<typeof selectRows>>) {
    const maxPoints = a.max_points === null ? null : Number(a.max_points)
    return rows.map((r) => ({
      memberId: r.member_id,
      name: `${r.first_name} ${r.last_name}`.trim(),
      email: r.email,
      status: participantStatus(a, { submitted: Boolean(r.submission_id), late: Boolean(r.is_late), graded: Boolean(r.grade_id) }),
      submittedAt: r.submitted_at,
      grade: r.grade_id ? gradeDisplay(a.grading_scale, maxPoints, a.criteria_count, r) : null,
    }))
  }

  /** "Grade next" order: ungraded submissions, oldest first. */
  function gradingQueue(rows: ReturnType<typeof rowsOf>) {
    return rows
      .filter((r) => r.status === 'submitted' || r.status === 'late')
      .sort((x, y) => new Date(x.submittedAt!).getTime() - new Date(y.submittedAt!).getTime())
      .map((r) => r.memberId)
  }

  function validateGrade(a: AssignmentRow, criteria: { id: string }[], body: z.infer<typeof Grade>) {
    const maxPoints = a.max_points === null ? null : Number(a.max_points)
    switch (a.grading_scale) {
      case 'points': {
        const v = body.points
        if (v === null || v === undefined || v < 0 || v > maxPoints! || Math.round(v * 100) !== v * 100) {
          throw fieldError('points', `Enter a number from 0 to ${maxPoints}.`)
        }
        return { points: v, percentage: null, letter: null, passed: null, scorePct: Math.round((v / maxPoints!) * 10000) / 100, rubric: [] }
      }
      case 'percentage': {
        const v = body.percentage
        if (v === null || v === undefined || v < 0 || v > 100 || Math.round(v * 100) !== v * 100) throw fieldError('percentage', 'Enter a number from 0 to 100.')
        return { points: null, percentage: v, letter: null, passed: null, scorePct: v, rubric: [] }
      }
      case 'letter':
        if (!body.letter) throw fieldError('letter', 'Choose a letter grade.')
        // A letter has no agreed percentage, so it doesn't count towards an average.
        return { points: null, percentage: null, letter: body.letter, passed: null, scorePct: null, rubric: [] }
      case 'pass_fail':
        if (body.passed === null || body.passed === undefined) throw fieldError('passed', 'Choose Pass or Fail.')
        return { points: null, percentage: null, letter: null, passed: body.passed, scorePct: body.passed ? 100 : 0, rubric: [] }
      case 'rubric': {
        const scores = new Map((body.rubric ?? []).map((r) => [r.criterionId, r.score]))
        const missing = criteria.filter((c) => !scores.has(c.id))
        if (missing.length || scores.size !== criteria.length) {
          throw new AppError(400, 'bad_request', 'Score every criterion.', missing.map((c) => ({ field: `rubric.${c.id}`, message: 'Choose a score.' })))
        }
        const total = [...scores.values()].reduce((sum, s) => sum + s, 0)
        return {
          points: null,
          percentage: null,
          letter: null,
          passed: null,
          scorePct: Math.round((total / (criteria.length * 4)) * 10000) / 100,
          rubric: [...scores].map(([criterionId, score]) => ({ criterionId, score })),
        }
      }
    }
  }

  return (
    new Hono<{ Variables: AuthVariables }>()
      .use(requireAuth(deps), requireRole(...STAFF))

      // T6.01 / C4.01. Trainers: their courses, drafts included. Admins: every published assignment.
      .get('/', async (c) => {
        const auth = c.var.auth
        const p = await permissionsOf(deps.sql, auth)
        const [rows, timeZone] = await Promise.all([
          selectAssignments(deps.sql, auth.organisationId, { cohortCourseIds: p.teaches ? [...p.teaches] : null, publishedOnly: p.admin }),
          timeZoneOf(deps.sql, auth.organisationId),
        ])
        return c.json({ timeZone, canCreate: p.canCreate && (p.admin || (p.teaches?.size ?? 0) > 0), assignments: rows.map((r) => toSummary(r, p)) })
      })

      // T6.02 Course choices and the organisation's grading scales.
      .get('/options', async (c) => {
        const auth = c.var.auth
        const p = await permissionsOf(deps.sql, auth)
        const [courses, [settings], timeZone] = await Promise.all([
          deps.sql<{ id: string; course_name: string; cohort_id: string; cohort_name: string; programme_name: string; status: string }[]>`
            select x.id, co.name as course_name, h.id as cohort_id, h.name as cohort_name, p.name as programme_name, public.status(h) as status
            from public.cohort_courses x
            join public.courses co on co.id = x.course_id
            join public.cohorts h on h.id = x.cohort_id
            join public.programmes p on p.id = x.programme_id
            where x.organisation_id = ${auth.organisationId}
              ${p.teaches ? deps.sql`and x.id = any(${[...p.teaches]}::uuid[])` : deps.sql``}
            order by h.starts_on desc, co.name
          `,
          deps.sql<{ scales: string[] }[]>`select allowed_grading_scales::text[] as scales from public.organisation_settings where organisation_id = ${auth.organisationId}`,
          timeZoneOf(deps.sql, auth.organisationId),
        ])
        return c.json({
          timeZone,
          scales: SCALES.filter((s) => settings?.scales.includes(s) ?? true),
          courses: courses
            .filter((x) => x.status !== 'archived' && x.status !== 'completed')
            .map((x) => ({ id: x.id, courseName: x.course_name, cohort: { id: x.cohort_id, name: x.cohort_name }, programmeName: x.programme_name })),
        })
      })

      .post('/', async (c) => {
        const body = await parseBody(c, Create)
        const auth = c.var.auth
        const p = await permissionsOf(deps.sql, auth)
        if (!p.canCreate) throw forbidden('Your organisation doesn’t let assistant trainers create assignments.')
        await checkCourse(deps.sql, auth, p, body.cohortCourseId)
        await checkAllowedScale(deps.sql, auth.organisationId, body.gradingScale)
        const due = await dueAt(deps.sql, auth.organisationId, body.dueDate, body.dueTime)
        if (body.publish && due.getTime() <= Date.now()) throw fieldError('dueDate', 'Choose a due date in the future.')
        const files = await prepareFiles(auth.organisationId, body.files)
        const id = await deps.sql.begin(async (tx) => {
          const [row] = await tx<{ id: string }[]>`
            insert into public.assignments (organisation_id, cohort_course_id, title, brief, due_at, submission_types, late_policy,
                                            grading_scale, max_points, created_by, published_at)
            values (${auth.organisationId}, ${body.cohortCourseId}, ${body.title}, ${body.brief}, ${due},
                    ${body.submissionTypes}::public.submission_type[], ${body.latePolicy}, ${body.gradingScale},
                    ${body.gradingScale === 'points' ? body.maxPoints! : null}, ${auth.memberId}, ${body.publish ? tx`now()` : null})
            returning id
          `
          if (body.gradingScale === 'rubric') await saveCriteria(tx, auth.organisationId, row!.id, body.criteria)
          await saveLinks(tx, auth.organisationId, row!.id, body.links)
          await saveFiles(tx, auth.organisationId, row!.id, files)
          await audit(tx, {
            organisationId: auth.organisationId,
            actorMemberId: auth.memberId,
            action: body.publish ? 'assignment.published' : 'assignment.drafted',
            entityType: 'assignment',
            entityId: row!.id,
            data: { title: body.title },
            requestId: c.var.requestId,
          })
          return row!.id
        })
        return c.json({ assignment: { id } }, 201)
      })

      // T6.02 Attach files: a one-time upload link; the form sends the path back when it saves.
      .post('/uploads', async (c) => {
        const body = await parseBody(c, Upload)
        const auth = c.var.auth
        const p = await permissionsOf(deps.sql, auth)
        if (!p.canCreate || (!p.admin && !p.teaches?.size)) throw forbidden('You can’t attach files to assignments.')
        const path = `${materialsPrefix(auth.organisationId)}${randomUUID()}/${safeFileName(body.name)}`
        return c.json({ upload: await deps.storage.createUpload(path) })
      })

      // Download a brief file or a submitted file (5-minute link).
      .get('/:id/files/:fileId', async (c) => {
        const auth = c.var.auth
        const p = await permissionsOf(deps.sql, auth)
        const a = await findAssignment(deps.sql, auth, p, c.req.param('id'))
        const fileId = c.req.param('fileId')
        if (!uuid.safeParse(fileId).success) throw notFound('File not found.')
        const [file] = await deps.sql<{ name: string; storage_path: string }[]>`
          select name, storage_path from public.assignment_materials where id = ${fileId} and assignment_id = ${a.id} and kind = 'file'
          union all
          select f.name, f.storage_path from public.submission_files f join public.submissions s on s.id = f.submission_id
          where f.id = ${fileId} and s.assignment_id = ${a.id}
        `
        if (!file) throw notFound('File not found.')
        return c.json({ url: await deps.storage.downloadUrl(file.storage_path, file.name) })
      })

      // T6.03 / C4.02 Assignment with everyone's status.
      .get('/:id', async (c) => {
        const auth = c.var.auth
        const p = await permissionsOf(deps.sql, auth)
        const a = await findAssignment(deps.sql, auth, p, c.req.param('id'))
        const [criteria, materials, rows, timeZone] = await Promise.all([
          criteriaOf(deps.sql, a.id),
          deps.sql<{ id: string; kind: string; name: string; url: string | null; size_bytes: string | null }[]>`
            select id, kind, name, url, size_bytes from public.assignment_materials where assignment_id = ${a.id} order by created_at
          `,
          selectRows(deps.sql, a),
          timeZoneOf(deps.sql, auth.organisationId),
        ])
        const people = rowsOf(a, rows)
        const local = await deps.sql<{ date: string; time: string }[]>`
          select to_char(${a.due_at}::timestamptz at time zone ${timeZone}, 'YYYY-MM-DD') as date,
                 to_char(${a.due_at}::timestamptz at time zone ${timeZone}, 'HH24:MI') as time
        `
        return c.json({
          timeZone,
          assignment: {
            ...toSummary(a, p),
            brief: a.brief,
            dueDate: local[0]!.date,
            dueTime: local[0]!.time,
            criteria,
            links: materials.filter((m) => m.kind === 'link').map((m) => ({ name: m.name, url: m.url })),
            files: materials.filter((m) => m.kind === 'file').map((m) => ({ id: m.id, name: m.name, size: Number(m.size_bytes ?? 0) })),
            locked: a.submitted > 0,
          },
          participants: people,
          queue: gradingQueue(people),
        })
      })

      // T6.05 Edit. Scale, criteria and submission types lock once anyone has submitted.
      .patch('/:id', async (c) => {
        const body = await parseBody(c, Edit)
        const auth = c.var.auth
        const p = await permissionsOf(deps.sql, auth)
        const a = await findAssignment(deps.sql, auth, p, c.req.param('id'))
        if (!p.canCreate) throw forbidden('Your organisation doesn’t let assistant trainers edit assignments.')
        const locked = a.submitted > 0
        if (body.cohortCourseId !== a.cohort_course_id) {
          if (locked) throw fieldError('cohortCourseId', 'Work has been submitted, so the course can’t change.')
          await checkCourse(deps.sql, auth, p, body.cohortCourseId)
        }
        if (locked) {
          const criteria = await criteriaOf(deps.sql, a.id)
          const sameTypes = [...body.submissionTypes].sort().join() === [...a.submission_types].sort().join()
          const sameCriteria =
            a.grading_scale !== 'rubric' ||
            (body.criteria.length === criteria.length && body.criteria.every((cr, i) => cr.title === criteria[i]!.title))
          if (
            body.gradingScale !== a.grading_scale ||
            (a.grading_scale === 'points' && Number(body.maxPoints) !== Number(a.max_points)) ||
            !sameTypes ||
            !sameCriteria
          ) {
            throw new AppError(409, 'assignment_locked', 'Work has been submitted, so the grading scale and submission types can’t change.')
          }
        } else {
          await checkAllowedScale(deps.sql, auth.organisationId, body.gradingScale)
        }
        const due = await dueAt(deps.sql, auth.organisationId, body.dueDate, body.dueTime)
        const publishing = body.publish && a.published_at === null
        if (publishing && due.getTime() <= Date.now()) throw fieldError('dueDate', 'Choose a due date in the future.')
        const files = await prepareFiles(auth.organisationId, body.files)
        const removed = await deps.sql.begin(async (tx) => {
          await tx`
            update public.assignments set
              cohort_course_id = ${body.cohortCourseId}, title = ${body.title}, brief = ${body.brief}, due_at = ${due},
              submission_types = ${body.submissionTypes}::public.submission_type[], late_policy = ${body.latePolicy},
              grading_scale = ${body.gradingScale}, max_points = ${body.gradingScale === 'points' ? body.maxPoints! : null},
              published_at = ${publishing ? tx`now()` : tx`published_at`}, updated_at = now()
            where id = ${a.id}
          `
          if (!locked) {
            if (body.gradingScale === 'rubric') await saveCriteria(tx, auth.organisationId, a.id, body.criteria)
            else await tx`delete from public.rubric_criteria where assignment_id = ${a.id}`
          } else if (a.grading_scale === 'rubric') {
            // Wording can still be tidied; scores stay attached to the same criteria.
            const criteria = await criteriaOf(tx, a.id)
            for (const [i, cr] of criteria.entries()) {
              await tx`update public.rubric_criteria set description = ${body.criteria[i]!.description} where id = ${cr.id}`
            }
          }
          await saveLinks(tx, auth.organisationId, a.id, body.links)
          const gone = await saveFiles(tx, auth.organisationId, a.id, files)
          await audit(tx, {
            organisationId: auth.organisationId,
            actorMemberId: auth.memberId,
            action: publishing ? 'assignment.published' : 'assignment.updated',
            entityType: 'assignment',
            entityId: a.id,
            data: { title: body.title },
            requestId: c.var.requestId,
          })
          return gone
        })
        await deps.storage.remove(removed).catch(() => undefined)
        return c.json({ ok: true })
      })

      // T6.04 / C4.03 One participant's submission and grade.
      .get('/:id/submissions/:memberId', async (c) => {
        const auth = c.var.auth
        const p = await permissionsOf(deps.sql, auth)
        const a = await findAssignment(deps.sql, auth, p, c.req.param('id'))
        const memberId = c.req.param('memberId')
        if (!uuid.safeParse(memberId).success) throw notFound('Participant not found.')
        const [criteria, rows, timeZone] = await Promise.all([criteriaOf(deps.sql, a.id), selectRows(deps.sql, a), timeZoneOf(deps.sql, auth.organisationId)])
        const people = rowsOf(a, rows)
        const person = people.find((r) => r.memberId === memberId)
        if (!person) throw notFound('This person isn’t in this assignment.')
        const [submission] = await deps.sql<{ id: string; submitted_at: Date; is_late: boolean; text_body: string | null; link_url: string | null; note: string | null }[]>`
          select id, submitted_at, is_late, text_body, link_url, note from public.submissions where assignment_id = ${a.id} and member_id = ${memberId}
        `
        const files = submission
          ? await deps.sql<{ id: string; name: string; size_bytes: string; mime_type: string | null }[]>`
              select id, name, size_bytes, mime_type from public.submission_files where submission_id = ${submission.id} order by created_at
            `
          : []
        const [grade] = submission
          ? await deps.sql<{ id: string; points: string | null; percentage: string | null; letter: string | null; passed: boolean | null; feedback: string | null; graded_at: Date; first_name: string | null; last_name: string | null }[]>`
              select g.id, g.points, g.percentage, g.letter, g.passed, g.feedback, g.graded_at, m.first_name, m.last_name
              from public.grades g left join public.organisation_members m on m.id = g.graded_by
              where g.submission_id = ${submission.id}
            `
          : []
        const scores = grade
          ? await deps.sql<{ criterion_id: string; score: number }[]>`select criterion_id, score from public.rubric_scores where grade_id = ${grade.id}`
          : []
        const queue = gradingQueue(people)
        const submittedOrder = people
          .filter((r) => r.submittedAt)
          .sort((x, y) => new Date(x.submittedAt!).getTime() - new Date(y.submittedAt!).getTime())
          .map((r) => r.memberId)
        const at = submittedOrder.indexOf(memberId)
        const afterMe = queue.filter((id) => submittedOrder.indexOf(id) > at)
        const maxPoints = a.max_points === null ? null : Number(a.max_points)
        return c.json({
          timeZone,
          assignment: { ...toSummary(a, p), criteria },
          participant: { id: person.memberId, name: person.name, email: person.email, status: person.status },
          submission: submission
            ? {
                submittedAt: submission.submitted_at,
                late: submission.is_late,
                text: submission.text_body,
                link: submission.link_url,
                note: submission.note,
                files: files.map((f) => ({ id: f.id, name: f.name, size: Number(f.size_bytes), type: f.mime_type })),
              }
            : null,
          grade: grade
            ? {
                points: grade.points === null ? null : Number(grade.points),
                percentage: grade.percentage === null ? null : Number(grade.percentage),
                letter: grade.letter,
                passed: grade.passed,
                rubric: scores.map((s) => ({ criterionId: s.criterion_id, score: s.score })),
                feedback: grade.feedback,
                display: gradeDisplay(a.grading_scale, maxPoints, a.criteria_count, { ...grade, total: scores.reduce((t, s) => t + s.score, 0) || null }),
                gradedAt: grade.graded_at,
                gradedBy: grade.first_name ? `${grade.first_name} ${grade.last_name}`.trim() : null,
              }
            : null,
          queue: {
            toGrade: queue.length,
            position: queue.includes(memberId) ? queue.indexOf(memberId) + 1 : null,
            previousMemberId: at > 0 ? submittedOrder[at - 1] : null,
            nextMemberId: afterMe[0] ?? queue.find((id) => id !== memberId) ?? null,
          },
        })
      })

      // T6.04 Save a grade in the assignment's scale. Visible to the participant on save.
      .put('/:id/submissions/:memberId/grade', async (c) => {
        const body = await parseBody(c, Grade)
        const auth = c.var.auth
        const p = await permissionsOf(deps.sql, auth)
        const a = await findAssignment(deps.sql, auth, p, c.req.param('id'))
        if (!teaches(p, a.cohort_course_id) || !p.canGrade) throw forbidden('You can’t grade this assignment.')
        const memberId = c.req.param('memberId')
        if (!uuid.safeParse(memberId).success) throw notFound('Participant not found.')
        const [submission] = await deps.sql<{ id: string }[]>`select id from public.submissions where assignment_id = ${a.id} and member_id = ${memberId}`
        if (!submission) throw new AppError(409, 'not_submitted', 'There’s nothing to grade yet: this person hasn’t submitted.')
        const criteria = await criteriaOf(deps.sql, a.id)
        const v = validateGrade(a, criteria, body)
        await deps.sql.begin(async (tx) => {
          const [grade] = await tx<{ id: string; created: boolean }[]>`
            insert into public.grades (organisation_id, submission_id, points, percentage, letter, passed, score_pct, feedback, graded_by)
            values (${auth.organisationId}, ${submission.id}, ${v.points}, ${v.percentage}, ${v.letter}, ${v.passed}, ${v.scorePct}, ${body.feedback}, ${auth.memberId})
            on conflict (submission_id) do update set
              points = excluded.points, percentage = excluded.percentage, letter = excluded.letter, passed = excluded.passed,
              score_pct = excluded.score_pct, feedback = excluded.feedback, graded_by = excluded.graded_by, updated_at = now()
            returning id, (xmax = 0) as created
          `
          await tx`delete from public.rubric_scores where grade_id = ${grade!.id}`
          for (const s of v.rubric) {
            await tx`
              insert into public.rubric_scores (organisation_id, grade_id, criterion_id, score)
              values (${auth.organisationId}, ${grade!.id}, ${s.criterionId}, ${s.score})
            `
          }
          await audit(tx, {
            organisationId: auth.organisationId,
            actorMemberId: auth.memberId,
            action: grade!.created ? 'grade.created' : 'grade.updated',
            entityType: 'submission',
            entityId: submission.id,
            data: { assignmentId: a.id, memberId, scorePct: v.scorePct },
            requestId: c.var.requestId,
          })
          return grade!.created
        }).then(async (created) => {
          // X2.03: in the participant's bell and inbox, unless they switched it off.
          const [grader] = await deps.sql<{ first_name: string; last_name: string; time_zone: string }[]>`
            select m.first_name, m.last_name, o.time_zone from public.organisation_members m join public.organisations o on o.id = m.organisation_id where m.id = ${auth.memberId}
          `
          const graded =
            a.grading_scale === 'points'
              ? `${v.points} / ${Number(a.max_points)}`
              : a.grading_scale === 'percentage'
                ? `${v.percentage}%`
                : a.grading_scale === 'letter'
                  ? String(v.letter)
                  : a.grading_scale === 'pass_fail'
                    ? v.passed
                      ? 'Pass'
                      : 'Not passed yet'
                    : `${v.scorePct ?? 0}%`
          const by = `${grader!.first_name} ${grader!.last_name}`
          await deliver(deps, {
            organisationId: auth.organisationId,
            to: { memberIds: [memberId] },
            event: 'grade_saved',
            title: created ? `New grade: ${a.title}` : `Grade updated: ${a.title}`,
            body: body.feedback ? 'Your trainer left feedback.' : null,
            link: `/participant/grades/${a.id}`,
            email: {
              subject: `${created ? 'Graded' : 'Grade updated'} — ${a.title}`,
              title: created ? 'Your work has been graded' : 'Your grade was updated',
              intro: (first) => `Hi ${first}, ${by} ${created ? 'graded' : 'updated the grade for'} ${a.title}${body.feedback ? ' and left feedback' : ''}.`,
              details: [
                { label: 'Grade', value: graded },
                { label: 'Course', value: a.course_name },
                { label: 'Graded', value: new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: grader!.time_zone }).format(new Date()).replace(',', '') },
              ],
              buttonLabel: 'View feedback',
              footer: 'You get this because grade notifications are on. Change them in Settings › Notifications.',
            },
          })
        })
        return c.json({ ok: true })
      })
  )
}
