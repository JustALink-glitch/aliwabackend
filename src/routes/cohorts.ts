import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { audit, isPg, PG, type Sql, type Tx } from '../lib/db.js'
import { AppError, notFound } from '../lib/errors.js'
import { isoDate, optionalText, parseBody, uuid } from '../lib/validation.js'
import { requireAuth, requireRole, type AuthVariables } from '../middleware/auth.js'
import { addCourseToCohort } from './courses.js'
import { findProgramme, selectCohortSummaries, toCohortSummary } from './programmes.js'

const CohortFields = z
  .object({
    name: z.string().trim().min(1, 'Enter a cohort name.').max(120),
    startsOn: isoDate,
    endsOn: isoDate,
    deliveryMode: z.enum(['in_person', 'online', 'both']),
    usualLocation: optionalText(120),
    // Courses from the programme's library that this cohort runs.
    courseIds: z.array(uuid).max(100).default([]),
  })
  .refine((value) => value.endsOn >= value.startsOn, { path: ['endsOn'], message: 'End date must be on or after the start date.' })

const NewCohort = z.intersection(z.object({ programmeId: uuid }), CohortFields)

const nameTaken = () =>
  new AppError(409, 'name_taken', 'This programme already has a cohort with this name.', [
    { field: 'name', message: 'This programme already has a cohort with this name.' },
  ])

async function findCohort(sql: Sql | Tx, organisationId: string, id: string) {
  if (!uuid.safeParse(id).success) throw notFound('Cohort not found.')
  const [row] = await selectCohortSummaries(sql, organisationId, { id })
  if (!row) throw notFound('Cohort not found.')
  return row
}

/** The given courses must all be live courses in the programme. */
async function checkCourses(tx: Tx, programmeId: string, courseIds: string[]) {
  if (courseIds.length === 0) return
  const rows = await tx`
    select id from public.courses where id in ${tx(courseIds)} and programme_id = ${programmeId} and archived_at is null
  `
  if (rows.length !== new Set(courseIds).size) {
    throw new AppError(400, 'bad_request', 'Some fields need attention.', [
      { field: 'courseIds', message: 'Choose courses from this programme.' },
    ])
  }
}

interface CohortCourseRow {
  id: string
  course_id: string
  name: string
  planned_session_count: number | null
  held: number
  first_session: string | null
  trainers: { id: string; firstName: string; lastName: string; isLead: boolean; status: string }[]
}

/** /v1/cohorts — A3. Owners and admins. */
export function cohortRoutes(deps: AppDeps) {
  return new Hono<{ Variables: AuthVariables }>()
    .use(requireAuth(deps), requireRole('owner', 'admin'))

    .get('/', async (c) => {
      const rows = await selectCohortSummaries(deps.sql, c.var.auth.organisationId)
      return c.json({ cohorts: rows.map(toCohortSummary) })
    })

    .post('/', async (c) => {
      const body = await parseBody(c, NewCohort)
      const { organisationId, memberId } = c.var.auth
      const programme = await findProgramme(deps.sql, organisationId, body.programmeId)
      if (programme.archived_at) throw new AppError(409, 'archived', 'This programme is archived. Restore it first.')
      try {
        const id = await deps.sql.begin(async (tx) => {
          await checkCourses(tx, programme.id, body.courseIds)
          const [row] = await tx<{ id: string }[]>`
            insert into public.cohorts
              (organisation_id, programme_id, name, starts_on, ends_on, delivery_mode, usual_location, is_draft)
            values
              (${organisationId}, ${programme.id}, ${body.name}, ${body.startsOn}, ${body.endsOn},
               ${body.deliveryMode}, ${body.usualLocation}, false)
            returning id
          `
          for (const courseId of body.courseIds) {
            await addCourseToCohort(tx, { organisationId, programmeId: programme.id, cohortId: row!.id, courseId })
          }
          await audit(tx, {
            organisationId,
            actorMemberId: memberId,
            action: 'cohort.created',
            entityType: 'cohort',
            entityId: row!.id,
            data: { programmeId: programme.id },
            requestId: c.var.requestId,
          })
          return row!.id
        })
        return c.json({ cohort: toCohortSummary(await findCohort(deps.sql, organisationId, id)) }, 201)
      } catch (error) {
        if (isPg(error, PG.uniqueViolation, 'cohorts_name_key')) throw nameTaken()
        throw error
      }
    })

    // A3.02: the cohort, its courses with trainers, and the programme's other courses (for editing).
    .get('/:id', async (c) => {
      const { organisationId } = c.var.auth
      const cohort = await findCohort(deps.sql, organisationId, c.req.param('id'))
      const [courses, library] = await Promise.all([
        deps.sql<CohortCourseRow[]>`
          select x.id, x.course_id, co.name, x.planned_session_count,
                 (select count(*)::int from public.sessions s where s.cohort_course_id = x.id and public.status(s) = 'held') as held,
                 (select min(s.starts_at)::text from public.sessions s where s.cohort_course_id = x.id and s.cancelled_at is null) as first_session,
                 coalesce((
                   select json_agg(json_build_object('id', m.id, 'firstName', m.first_name, 'lastName', m.last_name,
                                                     'isLead', t.is_lead, 'status', m.status)
                                   order by t.is_lead desc, m.first_name)
                   from public.cohort_course_trainers t join public.organisation_members m on m.id = t.member_id
                   where t.cohort_course_id = x.id
                 ), '[]'::json) as trainers
          from public.cohort_courses x join public.courses co on co.id = x.course_id
          where x.cohort_id = ${cohort.id}
          order by co.created_at
        `,
        deps.sql<{ id: string; name: string }[]>`
          select id, name from public.courses
          where programme_id = ${cohort.programme_id} and archived_at is null order by created_at
        `,
      ])
      return c.json({
        cohort: toCohortSummary(cohort),
        courses: courses.map((row) => ({
          id: row.id,
          courseId: row.course_id,
          name: row.name,
          plannedSessions: row.planned_session_count,
          heldSessions: row.held,
          firstSessionAt: row.first_session,
          trainers: row.trainers,
        })),
        programmeCourses: library,
      })
    })

    // A3.08: the programme can't change; a course with held sessions can't be removed.
    .patch('/:id', async (c) => {
      const body = await parseBody(c, CohortFields)
      const { organisationId, memberId } = c.var.auth
      const cohort = await findCohort(deps.sql, organisationId, c.req.param('id'))
      if (cohort.archived_at) throw new AppError(409, 'archived', 'This cohort is archived. Restore it before editing.')
      try {
        await deps.sql.begin(async (tx) => {
          await checkCourses(tx, cohort.programme_id, body.courseIds)
          await tx`
            update public.cohorts
            set name = ${body.name}, starts_on = ${body.startsOn}, ends_on = ${body.endsOn},
                delivery_mode = ${body.deliveryMode}, usual_location = ${body.usualLocation}, updated_at = now()
            where id = ${cohort.id}
          `
          const current = await tx<{ id: string; course_id: string; name: string; sessions: number }[]>`
            select x.id, x.course_id, co.name,
                   (select count(*)::int from public.sessions s where s.cohort_course_id = x.id) as sessions
            from public.cohort_courses x join public.courses co on co.id = x.course_id
            where x.cohort_id = ${cohort.id}
          `
          const removed = current.filter((row) => !body.courseIds.includes(row.course_id))
          const blocked = removed.filter((row) => row.sessions > 0)
          if (blocked.length > 0) {
            throw new AppError(409, 'course_has_sessions', `${blocked.map((b) => b.name).join(', ')} has sessions, so it can’t be removed.`, [
              { field: 'courseIds', message: `${blocked.map((b) => b.name).join(', ')} has sessions, so it can’t be removed.` },
            ])
          }
          if (removed.length > 0) {
            await tx`delete from public.cohort_courses where id in ${tx(removed.map((r) => r.id))}`
          }
          for (const courseId of body.courseIds) {
            await addCourseToCohort(tx, { organisationId, programmeId: cohort.programme_id, cohortId: cohort.id, courseId })
          }
          await audit(tx, {
            organisationId,
            actorMemberId: memberId,
            action: 'cohort.updated',
            entityType: 'cohort',
            entityId: cohort.id,
            requestId: c.var.requestId,
          })
        })
      } catch (error) {
        if (isPg(error, PG.uniqueViolation, 'cohorts_name_key')) throw nameTaken()
        throw error
      }
      return c.json({ cohort: toCohortSummary(await findCohort(deps.sql, organisationId, cohort.id)) })
    })

    // A3.09: available once the cohort has ended, or before it starts (which cancels it).
    .post('/:id/archive', async (c) => {
      const { organisationId, memberId } = c.var.auth
      const cohort = await findCohort(deps.sql, organisationId, c.req.param('id'))
      if (cohort.status === 'active') {
        throw new AppError(409, 'cohort_running', `This cohort is running. You can archive it after it ends on its end date.`)
      }
      if (!cohort.archived_at) {
        await deps.sql.begin(async (tx) => {
          await tx`update public.cohorts set archived_at = now(), updated_at = now() where id = ${cohort.id}`
          await audit(tx, {
            organisationId,
            actorMemberId: memberId,
            action: 'cohort.archived',
            entityType: 'cohort',
            entityId: cohort.id,
            data: { previousStatus: cohort.status },
            requestId: c.var.requestId,
          })
        })
      }
      return c.json({ cohort: toCohortSummary(await findCohort(deps.sql, organisationId, cohort.id)) })
    })

    .post('/:id/restore', async (c) => {
      const { organisationId, memberId } = c.var.auth
      const cohort = await findCohort(deps.sql, organisationId, c.req.param('id'))
      if (cohort.archived_at) {
        const programme = await findProgramme(deps.sql, organisationId, cohort.programme_id)
        if (programme.archived_at) {
          throw new AppError(409, 'programme_archived', `Restore ${programme.name} first. Its cohorts come back with it.`)
        }
        await deps.sql.begin(async (tx) => {
          await tx`update public.cohorts set archived_at = null, updated_at = now() where id = ${cohort.id}`
          await audit(tx, {
            organisationId,
            actorMemberId: memberId,
            action: 'cohort.restored',
            entityType: 'cohort',
            entityId: cohort.id,
            requestId: c.var.requestId,
          })
        })
      }
      return c.json({ cohort: toCohortSummary(await findCohort(deps.sql, organisationId, cohort.id)) })
    })
}
