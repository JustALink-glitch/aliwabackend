import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { audit, isPg, PG, type Tx } from '../lib/db.js'
import { AppError } from '../lib/errors.js'
import { requireMemberWithRole } from '../lib/people.js'
import { optionalText, parseBody, uuid } from '../lib/validation.js'
import { requireAuth, requireRole, type AuthVariables } from '../middleware/auth.js'
import { findProgramme } from './programmes.js'

export const TRAINER_ROLES = ['trainer', 'assistant_trainer']

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
        where c.organisation_id = ${organisationId} and c.archived_at is null and p.archived_at is null
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
}
