import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { audit, isPg, PG, type Sql, type Tx } from '../lib/db.js'
import { AppError, notFound } from '../lib/errors.js'
import { shortName } from '../lib/names.js'
import { requireMemberWithRole } from '../lib/people.js'
import { optionalText, parseBody, uuid } from '../lib/validation.js'
import { requireAuth, requireRole, type AuthVariables } from '../middleware/auth.js'

/** Outcome options offered by default on a new programme (A1.03). */
export const DEFAULT_OUTCOMES = ['Employed', 'Internship', 'Further study', 'Started a business', 'Freelancing']

const ProgrammeInput = z.object({
  name: z.string().trim().min(1, 'Enter a programme name.').max(120),
  description: optionalText(1000),
  leadMemberId: uuid.nullish().transform((value) => value ?? null),
  outcomes: z
    .array(z.string().trim().min(1).max(80))
    .max(20)
    // Drop repeats, keeping the first spelling.
    .transform((labels) => labels.filter((label, i) => labels.findIndex((l) => l.toLowerCase() === label.toLowerCase()) === i))
    .default([]),
})

interface ProgrammeRow {
  id: string
  name: string
  description: string | null
  created_at: Date
  archived_at: Date | null
  lead_member_id: string | null
  lead_first_name: string | null
  lead_last_name: string | null
  course_names: string[]
  cohort_total: number
  cohort_active: number
  cohort_upcoming: number
  cohort_completed: number
  participants: number
}

/** Archived · Draft (no cohorts yet) · Active. */
const programmeStatus = (row: Pick<ProgrammeRow, 'archived_at' | 'cohort_total'>) =>
  row.archived_at ? 'archived' : row.cohort_total === 0 ? 'draft' : 'active'

const toProgramme = (row: ProgrammeRow) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  status: programmeStatus(row),
  lead: row.lead_member_id
    ? { id: row.lead_member_id, name: shortName(row.lead_first_name, row.lead_last_name) }
    : null,
  courseNames: row.course_names,
  cohorts: {
    total: row.cohort_total,
    active: row.cohort_active,
    upcoming: row.cohort_upcoming,
    completed: row.cohort_completed,
  },
  participants: row.participants,
  createdAt: row.created_at,
  archivedAt: row.archived_at,
})

/** One query for the list and the detail header. Counts exclude archived cohorts. */
function selectProgrammes(sql: Sql | Tx, organisationId: string, id?: string) {
  return sql<ProgrammeRow[]>`
    select p.id, p.name, p.description, p.created_at, p.archived_at, p.lead_member_id,
           lead.first_name as lead_first_name, lead.last_name as lead_last_name,
           coalesce(cr.names, '{}') as course_names,
           coalesce(ch.total, 0)::int as cohort_total,
           coalesce(ch.active, 0)::int as cohort_active,
           coalesce(ch.upcoming, 0)::int as cohort_upcoming,
           coalesce(ch.completed, 0)::int as cohort_completed,
           coalesce(en.n, 0)::int as participants
    from public.programmes p
    left join public.organisation_members lead on lead.id = p.lead_member_id
    left join lateral (
      select array_agg(c.name order by c.created_at) as names
      from public.courses c where c.programme_id = p.id and c.archived_at is null
    ) cr on true
    left join lateral (
      select count(*) as total,
             count(*) filter (where s = 'active') as active,
             count(*) filter (where s = 'upcoming') as upcoming,
             count(*) filter (where s = 'completed') as completed
      from (select public.status(c) as s from public.cohorts c
            where c.programme_id = p.id and c.archived_at is null) x
    ) ch on true
    left join lateral (
      select count(distinct e.member_id) as n
      from public.enrolments e join public.cohorts c on c.id = e.cohort_id
      where c.programme_id = p.id and c.archived_at is null and e.status in ('active', 'completed')
    ) en on true
    where p.organisation_id = ${organisationId}
      ${id ? sql`and p.id = ${id}` : sql``}
    order by p.archived_at nulls first, lower(p.name)
  `
}

const nameTaken = () =>
  new AppError(409, 'name_taken', 'A programme with this name already exists.', [
    { field: 'name', message: 'A programme with this name already exists.' },
  ])

/** Replaces the programme's outcome options: keeps matching labels, archives removed ones. */
async function saveOutcomes(tx: Tx, organisationId: string, programmeId: string, labels: string[]) {
  const keep = labels.map((label) => label.toLowerCase())
  await tx`
    update public.programme_outcome_options set archived_at = now()
    where programme_id = ${programmeId} and archived_at is null
      ${keep.length ? tx`and lower(label) not in ${tx(keep)}` : tx``}
  `
  for (const [position, label] of labels.entries()) {
    await tx`
      insert into public.programme_outcome_options (organisation_id, programme_id, label, position)
      values (${organisationId}, ${programmeId}, ${label}, ${position})
      on conflict (programme_id, lower(label))
      do update set archived_at = null, position = excluded.position, label = excluded.label
    `
  }
}

export async function findProgramme(sql: Sql | Tx, organisationId: string, id: string) {
  if (!uuid.safeParse(id).success) throw notFound('Programme not found.')
  const [row] = await selectProgrammes(sql, organisationId, id)
  if (!row) throw notFound('Programme not found.')
  return row
}

/** /v1/programmes — A1. Owners and admins. */
export function programmeRoutes(deps: AppDeps) {
  return new Hono<{ Variables: AuthVariables }>()
    .use(requireAuth(deps), requireRole('owner', 'admin'))

    .get('/', async (c) => {
      const rows = await selectProgrammes(deps.sql, c.var.auth.organisationId)
      return c.json({ programmes: rows.map(toProgramme), defaultOutcomes: DEFAULT_OUTCOMES })
    })

    .post('/', async (c) => {
      const body = await parseBody(c, ProgrammeInput)
      const { organisationId, memberId } = c.var.auth
      try {
        const id = await deps.sql.begin(async (tx) => {
          if (body.leadMemberId) {
            await requireMemberWithRole(tx, organisationId, body.leadMemberId, ['owner', 'admin'], 'leadMemberId', 'Choose an admin in your organisation.')
          }
          const [row] = await tx<{ id: string }[]>`
            insert into public.programmes (organisation_id, name, description, lead_member_id)
            values (${organisationId}, ${body.name}, ${body.description}, ${body.leadMemberId})
            returning id
          `
          await saveOutcomes(tx, organisationId, row!.id, body.outcomes)
          await audit(tx, {
            organisationId,
            actorMemberId: memberId,
            action: 'programme.created',
            entityType: 'programme',
            entityId: row!.id,
            requestId: c.var.requestId,
          })
          return row!.id
        })
        const programme = await findProgramme(deps.sql, organisationId, id)
        return c.json({ programme: toProgramme(programme) }, 201)
      } catch (error) {
        if (isPg(error, PG.uniqueViolation, 'programmes_name_key')) throw nameTaken()
        throw error
      }
    })

    // A1.02: the programme with its cohorts, courses and outcome options.
    .get('/:id', async (c) => {
      const { organisationId } = c.var.auth
      const row = await findProgramme(deps.sql, organisationId, c.req.param('id'))
      const [outcomes, cohorts, courses] = await Promise.all([
        deps.sql<{ label: string }[]>`
          select label from public.programme_outcome_options
          where programme_id = ${row.id} and archived_at is null order by position, label
        `,
        selectCohortSummaries(deps.sql, organisationId, { programmeId: row.id }),
        deps.sql<CourseSummaryRow[]>`
          select c.id, c.name, c.planned_session_count, c.default_lead_member_id,
                 m.first_name as lead_first_name, m.last_name as lead_last_name
          from public.courses c
          left join public.organisation_members m on m.id = c.default_lead_member_id
          where c.programme_id = ${row.id} and c.archived_at is null
          order by c.created_at
        `,
      ])
      return c.json({
        programme: toProgramme(row),
        outcomes: outcomes.map((o) => o.label),
        cohorts: cohorts.filter((cohort) => !cohort.archived_at).map(toCohortSummary),
        courses: courses.map((course) => ({
          id: course.id,
          name: course.name,
          plannedSessions: course.planned_session_count,
          defaultLead: course.default_lead_member_id
            ? { id: course.default_lead_member_id, name: `${course.lead_first_name} ${course.lead_last_name}` }
            : null,
        })),
      })
    })

    .patch('/:id', async (c) => {
      const body = await parseBody(c, ProgrammeInput)
      const { organisationId, memberId } = c.var.auth
      const existing = await findProgramme(deps.sql, organisationId, c.req.param('id'))
      if (existing.archived_at) throw new AppError(409, 'archived', 'Restore this programme before editing it.')
      try {
        await deps.sql.begin(async (tx) => {
          if (body.leadMemberId) {
            await requireMemberWithRole(tx, organisationId, body.leadMemberId, ['owner', 'admin'], 'leadMemberId', 'Choose an admin in your organisation.')
          }
          await tx`
            update public.programmes
            set name = ${body.name}, description = ${body.description}, lead_member_id = ${body.leadMemberId}, updated_at = now()
            where id = ${existing.id}
          `
          await saveOutcomes(tx, organisationId, existing.id, body.outcomes)
          await audit(tx, {
            organisationId,
            actorMemberId: memberId,
            action: 'programme.updated',
            entityType: 'programme',
            entityId: existing.id,
            requestId: c.var.requestId,
          })
        })
      } catch (error) {
        if (isPg(error, PG.uniqueViolation, 'programmes_name_key')) throw nameTaken()
        throw error
      }
      return c.json({ programme: toProgramme(await findProgramme(deps.sql, organisationId, existing.id)) })
    })

    // A1.05 / A1.05b: blocked while any cohort is active or upcoming. Completed cohorts are archived with it.
    .post('/:id/archive', async (c) => {
      const { organisationId, memberId } = c.var.auth
      const existing = await findProgramme(deps.sql, organisationId, c.req.param('id'))
      if (existing.archived_at) return c.json({ programme: toProgramme(existing) })

      await deps.sql.begin(async (tx) => {
        const running = await tx<{ name: string; status: string; starts_on: string; ends_on: string }[]>`
          select name, public.status(c) as status, starts_on::text, ends_on::text from public.cohorts c
          where programme_id = ${existing.id} and archived_at is null
            and public.status(c) in ('active', 'upcoming', 'draft')
          order by starts_on
        `
        if (running.length > 0) {
          throw new AppError(409, 'cohorts_running', 'This programme can’t be archived yet.', {
            cohorts: running.map((r) => ({ name: r.name, status: r.status, startsOn: r.starts_on, endsOn: r.ends_on })),
          })
        }
        const [archived] = await tx<{ at: Date }[]>`
          update public.programmes set archived_at = now(), updated_at = now() where id = ${existing.id} returning archived_at as at
        `
        await tx`update public.cohorts set archived_at = ${archived!.at}, updated_at = now() where programme_id = ${existing.id} and archived_at is null`
        await audit(tx, {
          organisationId,
          actorMemberId: memberId,
          action: 'programme.archived',
          entityType: 'programme',
          entityId: existing.id,
          requestId: c.var.requestId,
        })
      })
      return c.json({ programme: toProgramme(await findProgramme(deps.sql, organisationId, existing.id)) })
    })

    // Restores the programme and the cohorts that were archived with it.
    .post('/:id/restore', async (c) => {
      const { organisationId, memberId } = c.var.auth
      const existing = await findProgramme(deps.sql, organisationId, c.req.param('id'))
      if (existing.archived_at) {
        await deps.sql.begin(async (tx) => {
          await tx`
            update public.cohorts set archived_at = null, updated_at = now()
            where programme_id = ${existing.id} and archived_at = ${existing.archived_at}
          `
          await tx`update public.programmes set archived_at = null, updated_at = now() where id = ${existing.id}`
          await audit(tx, {
            organisationId,
            actorMemberId: memberId,
            action: 'programme.restored',
            entityType: 'programme',
            entityId: existing.id,
            requestId: c.var.requestId,
          })
        })
      }
      return c.json({ programme: toProgramme(await findProgramme(deps.sql, organisationId, existing.id)) })
    })
}

interface CourseSummaryRow {
  id: string
  name: string
  planned_session_count: number | null
  default_lead_member_id: string | null
  lead_first_name: string | null
  lead_last_name: string | null
}

// ─── Cohort summaries, shared with /v1/cohorts ───

export interface CohortSummaryRow {
  id: string
  programme_id: string
  programme_name: string
  name: string
  starts_on: string
  ends_on: string
  status: string
  delivery_mode: string
  usual_location: string | null
  archived_at: Date | null
  course_names: string[]
  participants: number
  planned_sessions: number
  held_sessions: number
}

export function selectCohortSummaries(
  sql: Sql | Tx,
  organisationId: string,
  filter: { programmeId?: string; id?: string } = {},
) {
  return sql<CohortSummaryRow[]>`
    select c.id, c.programme_id, p.name as programme_name, c.name,
           c.starts_on::text as starts_on, c.ends_on::text as ends_on, public.status(c) as status,
           c.delivery_mode, c.usual_location, c.archived_at,
           coalesce(cc.names, '{}') as course_names,
           coalesce(cc.planned, 0)::int as planned_sessions,
           coalesce(se.held, 0)::int as held_sessions,
           coalesce(en.n, 0)::int as participants
    from public.cohorts c
    join public.programmes p on p.id = c.programme_id
    left join lateral (
      select array_agg(co.name order by co.created_at) as names, sum(coalesce(x.planned_session_count, 0)) as planned
      from public.cohort_courses x join public.courses co on co.id = x.course_id
      where x.cohort_id = c.id
    ) cc on true
    left join lateral (
      select count(*) as held from public.sessions s join public.cohort_courses x on x.id = s.cohort_course_id
      where x.cohort_id = c.id and public.status(s) = 'held'
    ) se on true
    left join lateral (
      select count(*) as n from public.enrolments e where e.cohort_id = c.id and e.status in ('active', 'completed')
    ) en on true
    where c.organisation_id = ${organisationId}
      ${filter.programmeId ? sql`and c.programme_id = ${filter.programmeId}` : sql``}
      ${filter.id ? sql`and c.id = ${filter.id}` : sql``}
    order by c.archived_at nulls first, c.starts_on desc, lower(c.name)
  `
}

export const toCohortSummary = (row: CohortSummaryRow) => ({
  id: row.id,
  programme: { id: row.programme_id, name: row.programme_name },
  name: row.name,
  startsOn: row.starts_on,
  endsOn: row.ends_on,
  status: row.status,
  deliveryMode: row.delivery_mode,
  usualLocation: row.usual_location,
  courseNames: row.course_names,
  participants: row.participants,
  plannedSessions: row.planned_sessions,
  heldSessions: row.held_sessions,
  archivedAt: row.archived_at,
})
