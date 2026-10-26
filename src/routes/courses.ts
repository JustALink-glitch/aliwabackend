import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { audit, isPg, PG, type Sql, type Tx } from '../lib/db.js'
import { randomUUID } from 'node:crypto'
import { AppError, notFound } from '../lib/errors.js'
import { MAX_FILE_BYTES, safeFileName } from '../lib/storage.js'
import { requireMemberWithRole } from '../lib/people.js'
import { optionalText, parseBody, uuid } from '../lib/validation.js'
import { requireAuth, requireRole, type AuthVariables } from '../middleware/auth.js'
import { findProgramme } from './programmes.js'

export const TRAINER_ROLES = ['trainer', 'assistant_trainer']

const CourseEdit = z.object({
  name: z.string().trim().min(1, 'Enter a course name.').max(120),
  description: optionalText(2000),
  plannedSessions: z.number().int().min(0).max(500).nullish().transform((value) => value ?? null),
  defaultLeadMemberId: uuid.nullish().transform((value) => value ?? null),
})

const Upload = z.object({
  name: z.string().trim().min(1).max(200),
  size: z.number().int().min(1, 'This file is empty.').max(MAX_FILE_BYTES, 'Files can be up to 25 MB.'),
  type: z.string().max(200).nullish(),
})

/** A2.04 Add resource: to the whole course, or to one session (which is one cohort's). */
const CourseResource = z
  .object({
    kind: z.enum(['file', 'link']),
    name: z.string().trim().min(1, 'Enter a title.').max(200),
    url: z
      .string()
      .trim()
      .max(1000)
      .nullish()
      .transform((v) => v || null),
    path: z.string().max(500).nullish(),
    sessionId: uuid.nullish().transform((v) => v ?? null),
    visible: z.boolean().default(true),
  })
  .refine((v) => v.kind !== 'link' || (v.url && /^https?:\/\/\S+$/.test(v.url)), { path: ['url'], message: 'Paste the full link, starting with https://' })
  .refine((v) => v.kind !== 'file' || Boolean(v.path), { path: ['path'], message: 'Choose a file.' })

const CourseInput = z.object({
  programmeId: uuid,
  name: z.string().trim().min(1, 'Enter a course name.').max(120),
  description: optionalText(2000),
  plannedSessions: z.number().int().min(0).max(500).nullish().transform((value) => value ?? null),
  defaultLeadMemberId: uuid.nullish().transform((value) => value ?? null),
  // A2.03 "Add to existing cohorts": active and upcoming cohorts in this programme.
  cohortIds: z.array(uuid).max(100).default([]),
})

interface CourseRow {
  id: string
  programme_id: string
  programme_name: string
  name: string
  description: string | null
  planned_session_count: number | null
  default_lead_member_id: string | null
  lead_first_name: string | null
  lead_last_name: string | null
  cohorts: { id: string; name: string }[]
  created_at: Date
}

const toCourse = (row: CourseRow) => ({
  id: row.id,
  programme: { id: row.programme_id, name: row.programme_name },
  name: row.name,
  description: row.description,
  plannedSessions: row.planned_session_count,
  defaultLead: row.default_lead_member_id
    ? { id: row.default_lead_member_id, name: `${row.lead_first_name} ${row.lead_last_name}` }
    : null,
  cohorts: row.cohorts,
  createdAt: row.created_at,
})

/**
 * Adds a course to a cohort with its planned sessions and default lead trainer.
 * Used by "New course → Add to existing cohorts" and "New cohort → Courses".
 */
export async function addCourseToCohort(
  tx: Tx,
  input: { organisationId: string; programmeId: string; cohortId: string; courseId: string },
) {
  const [row] = await tx<{ id: string }[]>`
    insert into public.cohort_courses (organisation_id, programme_id, cohort_id, course_id, planned_session_count)
    select ${input.organisationId}, ${input.programmeId}, ${input.cohortId}, c.id, c.planned_session_count
    from public.courses c where c.id = ${input.courseId}
    on conflict (cohort_id, course_id) do nothing
    returning id
  `
  if (!row) return
  await tx`
    insert into public.cohort_course_trainers (organisation_id, cohort_course_id, member_id, is_lead)
    select ${input.organisationId}, ${row.id}, c.default_lead_member_id, true
    from public.courses c
    join public.organisation_members m on m.id = c.default_lead_member_id and m.status <> 'deactivated'
    where c.id = ${input.courseId}
  `
}

/** /v1/courses — A2 course library (shared mode). Owners and admins. */
export function courseRoutes(deps: AppDeps) {
  return new Hono<{ Variables: AuthVariables }>()
    .use(requireAuth(deps), requireRole('owner', 'admin'))

    .get('/', async (c) => {
      const { organisationId } = c.var.auth
      const programmeId = uuid.safeParse(c.req.query('programmeId'))
      const rows = await deps.sql<CourseRow[]>`
        select c.id, c.programme_id, p.name as programme_name, c.name, c.description, c.planned_session_count,
               c.default_lead_member_id, m.first_name as lead_first_name, m.last_name as lead_last_name, c.created_at,
               coalesce((
                 select json_agg(json_build_object('id', h.id, 'name', h.name) order by h.starts_on)
                 from public.cohort_courses x join public.cohorts h on h.id = x.cohort_id
                 where x.course_id = c.id and h.archived_at is null
               ), '[]'::json) as cohorts
        from public.courses c
        join public.programmes p on p.id = c.programme_id
        left join public.organisation_members m on m.id = c.default_lead_member_id
        where c.organisation_id = ${organisationId} and p.archived_at is null
          ${c.req.query('archived') === '1' ? deps.sql`and c.archived_at is not null` : deps.sql`and c.archived_at is null`}
          ${programmeId.success ? deps.sql`and c.programme_id = ${programmeId.data}` : deps.sql``}
        order by lower(p.name), c.created_at
      `
      return c.json({ courses: rows.map(toCourse) })
    })

    .post('/', async (c) => {
      const body = await parseBody(c, CourseInput)
      const { organisationId, memberId } = c.var.auth
      const programme = await findProgramme(deps.sql, organisationId, body.programmeId)
      if (programme.archived_at) throw new AppError(409, 'archived', 'This programme is archived. Restore it first.')

      try {
        const id = await deps.sql.begin(async (tx) => {
          if (body.defaultLeadMemberId) {
            await requireMemberWithRole(tx, organisationId, body.defaultLeadMemberId, TRAINER_ROLES, 'defaultLeadMemberId', 'Choose a trainer in your organisation.')
          }
          const [row] = await tx<{ id: string }[]>`
            insert into public.courses (organisation_id, programme_id, name, description, planned_session_count, default_lead_member_id)
            values (${organisationId}, ${programme.id}, ${body.name}, ${body.description}, ${body.plannedSessions}, ${body.defaultLeadMemberId})
            returning id
          `
          if (body.cohortIds.length > 0) {
            const cohorts = await tx<{ id: string }[]>`
              select id from public.cohorts c
              where c.id in ${tx(body.cohortIds)} and c.programme_id = ${programme.id} and c.archived_at is null
                and public.status(c) in ('active', 'upcoming', 'draft')
            `
            if (cohorts.length !== new Set(body.cohortIds).size) {
              throw new AppError(400, 'bad_request', 'Some fields need attention.', [
                { field: 'cohortIds', message: 'Choose active or upcoming cohorts in this programme.' },
              ])
            }
            for (const cohort of cohorts) {
              await addCourseToCohort(tx, { organisationId, programmeId: programme.id, cohortId: cohort.id, courseId: row!.id })
            }
          }
          await audit(tx, {
            organisationId,
            actorMemberId: memberId,
            action: 'course.created',
            entityType: 'course',
            entityId: row!.id,
            data: { programmeId: programme.id, cohortIds: body.cohortIds },
            requestId: c.var.requestId,
          })
          return row!.id
        })
        return c.json({ course: { id } }, 201)
      } catch (error) {
        if (isPg(error, PG.uniqueViolation, 'courses_name_key')) {
          throw new AppError(409, 'name_taken', 'This programme already has a course with this name.', [
            { field: 'name', message: 'This programme already has a course with this name.' },
          ])
        }
        throw error
      }
    })

    // A2.02 Course detail: where it runs, its resources, assignments and sessions.
    .get('/:id', async (c) => {
      const { organisationId, memberId } = c.var.auth
      const course = await findCourse(deps.sql, organisationId, c.req.param('id'))
      const [running, resources, assignments, sessions, [mode]] = await Promise.all([
        deps.sql<{ id: string; cohort_id: string; name: string; status: string; held: number; planned: number; trainers: { name: string; lead: boolean }[] }[]>`
          select x.id, h.id as cohort_id, h.name, public.status(h) as status,
                 (select count(*)::int from public.sessions s where s.cohort_course_id = x.id and s.cancelled_at is null and s.ends_at <= now()) as held,
                 greatest(coalesce(x.planned_session_count, 0), (select count(*)::int from public.sessions s where s.cohort_course_id = x.id and s.cancelled_at is null)) as planned,
                 coalesce((select json_agg(json_build_object('name', m.first_name || ' ' || m.last_name, 'lead', t.is_lead) order by t.is_lead desc, m.first_name)
                           from public.cohort_course_trainers t join public.organisation_members m on m.id = t.member_id and m.status <> 'deactivated'
                           where t.cohort_course_id = x.id), '[]') as trainers
          from public.cohort_courses x join public.cohorts h on h.id = x.cohort_id
          where x.course_id = ${course.id} and h.archived_at is null
          order by (public.status(h) = 'active') desc, h.starts_on desc
        `,
        courseResources(deps.sql, course.id),
        deps.sql<{ id: string; title: string; grading_scale: string; max_points: string | null; due_at: Date; cohort: string; published: boolean; first: string | null; last: string | null }[]>`
          select a.id, a.title, a.grading_scale::text, a.max_points::text, a.due_at, h.name as cohort, a.published_at is not null as published,
                 m.first_name as first, m.last_name as last
          from public.assignments a join public.cohort_courses x on x.id = a.cohort_course_id join public.cohorts h on h.id = x.cohort_id
          left join public.organisation_members m on m.id = a.created_by
          where x.course_id = ${course.id} and h.archived_at is null
          order by a.due_at
        `,
        deps.sql<{ id: string; starts_at: Date; ends_at: Date; status: string; cohort: string; mode: string }[]>`
          select s.id, s.starts_at, s.ends_at, public.status(s) as status, h.name as cohort, s.mode::text
          from public.sessions s join public.cohort_courses x on x.id = s.cohort_course_id join public.cohorts h on h.id = x.cohort_id
          where x.course_id = ${course.id} and h.archived_at is null
          order by s.starts_at
        `,
        deps.sql<{ mode: string }[]>`select course_library_mode::text as mode from public.organisation_settings where organisation_id = ${organisationId}`,
      ])
      return c.json({
        course: { ...toCourse(course), archivedAt: course.archived_at, libraryMode: mode?.mode ?? 'shared' },
        cohorts: running.map((r) => ({ id: r.cohort_id, cohortCourseId: r.id, name: r.name, status: r.status, held: r.held, planned: r.planned, trainers: r.trainers })),
        resources: resources.map((r) => toCourseResource(r, memberId)),
        assignments: assignments.map((a) => ({
          id: a.id,
          title: a.title,
          scale: a.grading_scale,
          maxPoints: a.max_points === null ? null : Number(a.max_points),
          dueAt: a.due_at,
          cohort: a.cohort,
          published: a.published,
          setBy: a.first ? `${a.first} ${a.last ?? ''}`.trim() : null,
        })),
        sessions: sessions.map((s) => ({ id: s.id, startsAt: s.starts_at, endsAt: s.ends_at, status: s.status, cohort: s.cohort, mode: s.mode })),
      })
    })

    // A2.05 Edit course: applies to every cohort that uses it; sessions already held aren't changed.
    .patch('/:id', async (c) => {
      const body = await parseBody(c, CourseEdit)
      const { organisationId, memberId } = c.var.auth
      const course = await findCourse(deps.sql, organisationId, c.req.param('id'))
      if (course.archived_at) throw new AppError(409, 'archived', 'This course is archived. Restore it first.')
      try {
        await deps.sql.begin(async (tx) => {
          if (body.defaultLeadMemberId) {
            await requireMemberWithRole(tx, organisationId, body.defaultLeadMemberId, TRAINER_ROLES, 'defaultLeadMemberId', 'Choose a trainer in your organisation.')
          }
          await tx`
            update public.courses set name = ${body.name}, description = ${body.description}, planned_session_count = ${body.plannedSessions},
              default_lead_member_id = ${body.defaultLeadMemberId}, updated_at = now()
            where id = ${course.id}
          `
          // Cohorts that haven't set their own number follow the course.
          if (body.plannedSessions !== course.planned_session_count) {
            await tx`
              update public.cohort_courses set planned_session_count = ${body.plannedSessions}
              where course_id = ${course.id} and planned_session_count is not distinct from ${course.planned_session_count}
            `
          }
          await audit(tx, { organisationId, actorMemberId: memberId, action: 'course.updated', entityType: 'course', entityId: course.id, requestId: c.var.requestId })
        })
      } catch (error) {
        if (isPg(error, PG.uniqueViolation, 'courses_name_key')) {
          throw new AppError(409, 'name_taken', 'This programme already has a course with this name.', [{ field: 'name', message: 'This programme already has a course with this name.' }])
        }
        throw error
      }
      return c.json({ course: toCourse(await findCourse(deps.sql, organisationId, course.id)) })
    })

    // A2.06 Archive: leaves the library; cohorts that run it keep everything.
    .post('/:id/archive', async (c) => {
      const { organisationId, memberId } = c.var.auth
      const course = await findCourse(deps.sql, organisationId, c.req.param('id'))
      await deps.sql.begin(async (tx) => {
        await tx`update public.courses set archived_at = coalesce(archived_at, now()), updated_at = now() where id = ${course.id}`
        await audit(tx, { organisationId, actorMemberId: memberId, action: 'course.archived', entityType: 'course', entityId: course.id, requestId: c.var.requestId })
      })
      return c.json({ ok: true })
    })

    .post('/:id/restore', async (c) => {
      const { organisationId, memberId } = c.var.auth
      const course = await findCourse(deps.sql, organisationId, c.req.param('id'))
      await deps.sql.begin(async (tx) => {
        await tx`update public.courses set archived_at = null, updated_at = now() where id = ${course.id}`
        await audit(tx, { organisationId, actorMemberId: memberId, action: 'course.restored', entityType: 'course', entityId: course.id, requestId: c.var.requestId })
      })
      return c.json({ ok: true })
    })

    // A2.04 Add resource.
    .post('/:id/resources/uploads', async (c) => {
      const body = await parseBody(c, Upload)
      const course = await findCourse(deps.sql, c.var.auth.organisationId, c.req.param('id'))
      const path = `${c.var.auth.organisationId}/resources/${randomUUID()}/${safeFileName(body.name)}`
      return c.json({ upload: await deps.storage.createUpload(path), courseId: course.id })
    })

    .post('/:id/resources', async (c) => {
      const body = await parseBody(c, CourseResource)
      const { organisationId, memberId } = c.var.auth
      const course = await findCourse(deps.sql, organisationId, c.req.param('id'))
      let size: number | null = null
      let type: string | null = null
      if (body.kind === 'file') {
        if (!body.path!.startsWith(`${organisationId}/resources/`) || body.path!.includes('..')) throw fieldError('path', 'Choose the file again.')
        const stat = await deps.storage.stat(body.path!)
        if (!stat) throw fieldError('path', 'The file didn’t finish uploading. Choose it again.')
        if (stat.size > MAX_FILE_BYTES) throw fieldError('path', 'Files can be up to 25 MB.')
        size = stat.size
        type = stat.type
      }
      let cohortCourseId: string | null = null
      if (body.sessionId) {
        const [s] = await deps.sql<{ cohort_course_id: string }[]>`
          select s.cohort_course_id from public.sessions s join public.cohort_courses x on x.id = s.cohort_course_id
          where s.id = ${body.sessionId} and x.course_id = ${course.id} and s.organisation_id = ${organisationId}
        `
        if (!s) throw fieldError('sessionId', 'Choose a session of this course.')
        cohortCourseId = s.cohort_course_id
      }
      const [row] = await deps.sql.begin(async (tx) => {
        const rows = await tx<{ id: string }[]>`
          insert into public.resources (organisation_id, cohort_course_id, course_id, session_id, kind, name, url, storage_path, size_bytes, mime_type, visible_to_participants, added_by)
          values (${organisationId}, ${cohortCourseId}, ${cohortCourseId ? null : course.id}, ${body.sessionId}, ${body.kind}, ${body.name},
                  ${body.kind === 'link' ? body.url : null}, ${body.kind === 'file' ? body.path! : null}, ${size}, ${type}, ${body.visible}, ${memberId})
          returning id
        `
        await audit(tx, { organisationId, actorMemberId: memberId, action: 'resource.added', entityType: 'course', entityId: course.id, data: { kind: body.kind, sessionId: body.sessionId }, requestId: c.var.requestId })
        return rows
      })
      return c.json({ resource: { id: row!.id } }, 201)
    })

    .get('/:id/resources/:resourceId', async (c) => {
      const course = await findCourse(deps.sql, c.var.auth.organisationId, c.req.param('id'))
      const rid = c.req.param('resourceId')
      if (!uuid.safeParse(rid).success) throw notFound('Resource not found.')
      const [r] = await deps.sql<{ name: string; storage_path: string | null; url: string | null }[]>`
        select r.name, r.storage_path, r.url from public.resources r left join public.cohort_courses x on x.id = r.cohort_course_id
        where r.id = ${rid} and (r.course_id = ${course.id} or x.course_id = ${course.id})
      `
      if (!r) throw notFound('Resource not found.')
      return c.json({ url: r.storage_path ? await deps.storage.downloadUrl(r.storage_path, r.name) : r.url })
    })

    .delete('/:id/resources/:resourceId', async (c) => {
      const { organisationId, memberId } = c.var.auth
      const course = await findCourse(deps.sql, organisationId, c.req.param('id'))
      const rid = c.req.param('resourceId')
      if (!uuid.safeParse(rid).success) throw notFound('Resource not found.')
      const [r] = await deps.sql<{ storage_path: string | null }[]>`
        select r.storage_path from public.resources r left join public.cohort_courses x on x.id = r.cohort_course_id
        where r.id = ${rid} and (r.course_id = ${course.id} or x.course_id = ${course.id})
      `
      if (!r) throw notFound('Resource not found.')
      await deps.sql`delete from public.resources where id = ${rid}`
      if (r.storage_path) await deps.storage.remove([r.storage_path]).catch(() => undefined)
      await audit(deps.sql, { organisationId, actorMemberId: memberId, action: 'resource.removed', entityType: 'course', entityId: course.id, requestId: c.var.requestId })
      return c.body(null, 204)
    })
}

const fieldError = (field: string, message: string) => new AppError(400, 'bad_request', 'Some fields need attention.', [{ field, message }])

interface CourseDetailRow extends CourseRow {
  archived_at: Date | null
}

async function findCourse(sql: Sql, organisationId: string, id: string) {
  if (!uuid.safeParse(id).success) throw notFound('Course not found.')
  const [row] = await sql<CourseDetailRow[]>`
    select c.id, c.programme_id, p.name as programme_name, c.name, c.description, c.planned_session_count, c.archived_at,
           c.default_lead_member_id, m.first_name as lead_first_name, m.last_name as lead_last_name, c.created_at,
           coalesce((
             select json_agg(json_build_object('id', h.id, 'name', h.name) order by h.starts_on)
             from public.cohort_courses x join public.cohorts h on h.id = x.cohort_id
             where x.course_id = c.id and h.archived_at is null
           ), '[]'::json) as cohorts
    from public.courses c join public.programmes p on p.id = c.programme_id
    left join public.organisation_members m on m.id = c.default_lead_member_id
    where c.id = ${id} and c.organisation_id = ${organisationId}
  `
  if (!row) throw notFound('Course not found.')
  return row
}

interface CourseResourceRow {
  id: string
  kind: 'file' | 'link'
  name: string
  url: string | null
  size_bytes: string | null
  mime_type: string | null
  session_id: string | null
  session_starts_at: Date | null
  cohort: string | null
  visible_to_participants: boolean
  added_by: string | null
  by_first: string | null
  by_last: string | null
  created_at: Date
}

/** Everything shared on the course: course-wide first, then each cohort's own. */
function courseResources(sql: Sql, courseId: string) {
  return sql<CourseResourceRow[]>`
    select r.id, r.kind, r.name, r.url, r.size_bytes::text, r.mime_type, r.session_id, s.starts_at as session_starts_at, h.name as cohort,
           r.visible_to_participants, r.added_by, m.first_name as by_first, m.last_name as by_last, r.created_at
    from public.resources r
    left join public.cohort_courses x on x.id = r.cohort_course_id
    left join public.cohorts h on h.id = x.cohort_id
    left join public.sessions s on s.id = r.session_id
    left join public.organisation_members m on m.id = r.added_by
    where r.course_id = ${courseId} or (x.course_id = ${courseId} and h.archived_at is null)
    order by (r.course_id is null), r.created_at desc
  `
}

const toCourseResource = (r: CourseResourceRow, me: string) => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  url: r.kind === 'link' ? r.url : null,
  size: r.size_bytes === null ? null : Number(r.size_bytes),
  type: r.mime_type,
  // Null: every cohort that runs the course.
  cohort: r.cohort,
  sessionStartsAt: r.session_starts_at,
  visible: r.visible_to_participants,
  addedBy: r.added_by === me ? 'you' : r.by_first ? `${r.by_first} ${r.by_last ?? ''}`.trim() : null,
  addedAt: r.created_at,
})
