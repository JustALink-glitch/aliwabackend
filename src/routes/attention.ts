import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import type { AuthContext } from '../lib/auth.js'
import { refreshFlags, ruleSettings, type Rule } from '../lib/attention.js'
import { audit, type Sql } from '../lib/db.js'
import { AppError, forbidden, notFound } from '../lib/errors.js'
import { isoDate, parseBody, uuid } from '../lib/validation.js'
import { requireAuth, requireRole, type AuthVariables } from '../middleware/auth.js'

const Intervention = z.object({
  method: z.enum(['call', 'email', 'message', 'visit', 'other']),
  date: isoDate,
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Enter a time like 11:20.'),
  notes: z.string().trim().min(1, 'Say what was discussed and agreed.').max(2000),
  outcome: z.enum(['awaiting_response', 'reached', 'resolved', 'no_response']),
  reviewOn: isoDate.nullish().transform((v) => v ?? null),
})

const Resolve = z.object({ note: z.string().trim().min(1, 'Add a note. It’s kept with the flag.').max(1000) })

const isAdmin = (auth: AuthContext) => auth.role === 'owner' || auth.role === 'admin'

/** Trainers see participants in cohorts where they teach a course (if F1.06 lets them); admins see everyone. */
const scope = (sql: Sql, auth: AuthContext, hidden: boolean) =>
  isAdmin(auth)
    ? sql``
    : hidden
      ? sql`and false`
      : sql`and e.cohort_id in (
        select x.cohort_id from public.cohort_course_trainers t join public.cohort_courses x on x.id = t.cohort_course_id
        where t.member_id = ${auth.memberId})`

/** F1.06 "Who sees flags": whether this trainer's view is switched off. */
const hiddenFor = async (sql: Sql, auth: AuthContext) => !isAdmin(auth) && !(await ruleSettings(sql, auth.organisationId)).trainersSee

/** Admins can always resolve; trainers only when F1.06 allows it. */
const canResolve = async (sql: Sql, auth: AuthContext) => isAdmin(auth) || (await ruleSettings(sql, auth.organisationId)).trainersCanResolve

const name = (first: string | null, last: string | null) => (first ? `${first} ${last ?? ''}`.trim() : null)

/** /v1/attention — D1 Needs attention, interventions; T7 for trainers (own cohorts, can't resolve). */
export function attentionRoutes(deps: AppDeps) {
  const now = () => (deps.now ? deps.now() : new Date())

  async function timeZoneOf(organisationId: string) {
    const [row] = await deps.sql<{ time_zone: string }[]>`select time_zone from public.organisations where id = ${organisationId}`
    return row!.time_zone
  }

  /** The participant's current enrolment that flags and interventions attach to. */
  async function currentEnrolment(auth: AuthContext, memberId: string) {
    if (!uuid.safeParse(memberId).success) throw notFound('Participant not found.')
    const hidden = await hiddenFor(deps.sql, auth)
    const [row] = await deps.sql<{ id: string; cohort_id: string; cohort_name: string; first_name: string; last_name: string }[]>`
      select e.id, e.cohort_id, h.name as cohort_name, m.first_name, m.last_name
      from public.enrolments e
      join public.organisation_members m on m.id = e.member_id
      join public.cohorts h on h.id = e.cohort_id
      where e.member_id = ${memberId} and e.organisation_id = ${auth.organisationId} and m.role = 'participant'
        ${scope(deps.sql, auth, hidden)}
      order by (e.status = 'active') desc, e.enrolled_at desc
      limit 1
    `
    if (!row) throw notFound('Participant not found.')
    return row
  }

  return (
    new Hono<{ Variables: AuthVariables }>()
      .use(requireAuth(deps), requireRole('owner', 'admin', 'trainer', 'assistant_trainer'))

      // D1.01 Needs attention: one row per flagged participant, oldest unresolved first.
      .get('/', async (c) => {
        const auth = c.var.auth
        const hidden = await hiddenFor(deps.sql, auth)
        await refreshFlags(deps.sql, auth.organisationId, now())
        const [rows, rules, timeZone] = await Promise.all([
          deps.sql<
            {
              enrolment_id: string
              member_id: string
              first_name: string
              last_name: string
              cohort_id: string
              cohort_name: string
              flags: { id: string; rule: Rule; details: Record<string, unknown>; raisedAt: string }[]
              last_method: string | null
              last_outcome: string | null
              last_at: Date | null
              last_by_first: string | null
              last_by_last: string | null
              review_on: string | null
            }[]
          >`
            select e.id as enrolment_id, m.id as member_id, m.first_name, m.last_name, h.id as cohort_id, h.name as cohort_name,
                   json_agg(json_build_object('id', f.id, 'rule', f.rule, 'details', f.details, 'raisedAt', f.raised_at) order by f.raised_at, array_position(array['missed_in_row','overdue_assignments','low_attendance','low_grade','inactive'], f.rule::text)) as flags,
                   i.method as last_method, i.outcome as last_outcome, i.contacted_at as last_at,
                   b.first_name as last_by_first, b.last_name as last_by_last, i.review_on::text
            from public.attention_flags f
            join public.enrolments e on e.id = f.enrolment_id
            join public.organisation_members m on m.id = e.member_id
            join public.cohorts h on h.id = e.cohort_id
            left join lateral (
              select * from public.interventions i where i.enrolment_id = e.id order by i.contacted_at desc limit 1
            ) i on true
            left join public.organisation_members b on b.id = i.recorded_by
            where f.organisation_id = ${auth.organisationId} and f.cleared_at is null and f.resolved_at is null
              ${scope(deps.sql, auth, hidden)}
            group by e.id, m.id, h.id, i.method, i.outcome, i.contacted_at, b.first_name, b.last_name, i.review_on
            order by min(f.raised_at)
          `,
          ruleSettings(deps.sql, auth.organisationId),
          timeZoneOf(auth.organisationId),
        ])
        return c.json({
          timeZone,
          rules,
          canResolve: await canResolve(deps.sql, auth),
          participants: rows.map((r) => ({
            enrolmentId: r.enrolment_id,
            participant: { id: r.member_id, name: `${r.first_name} ${r.last_name}`.trim() },
            cohort: { id: r.cohort_id, name: r.cohort_name },
            flags: r.flags,
            lastIntervention: r.last_at ? { method: r.last_method, outcome: r.last_outcome, at: r.last_at, by: name(r.last_by_first, r.last_by_last), reviewOn: r.review_on } : null,
          })),
        })
      })

      // Sidebar count (G1): re-checks the rules, then counts flagged participants.
      .get('/count', async (c) => {
        const auth = c.var.auth
        const hidden = await hiddenFor(deps.sql, auth)
        await refreshFlags(deps.sql, auth.organisationId, now())
        const [row] = await deps.sql<{ count: number }[]>`
          select count(distinct f.enrolment_id)::int as count from public.attention_flags f join public.enrolments e on e.id = f.enrolment_id
          where f.organisation_id = ${auth.organisationId} and f.cleared_at is null and f.resolved_at is null ${scope(deps.sql, auth, hidden)}
        `
        return c.json({ count: row!.count })
      })

      // D1.04 Interventions log.
      .get('/interventions', async (c) => {
        const auth = c.var.auth
        const hidden = await hiddenFor(deps.sql, auth)
        const [rows, timeZone] = await Promise.all([
          deps.sql<{ id: string; member_id: string; first_name: string; last_name: string; cohort_name: string; method: string; outcome: string; contacted_at: Date; notes: string | null; review_on: string | null; by_first: string | null; by_last: string | null; by_role: string | null }[]>`
            select i.id, m.id as member_id, m.first_name, m.last_name, h.name as cohort_name, i.method, i.outcome, i.contacted_at, i.notes, i.review_on::text,
                   b.first_name as by_first, b.last_name as by_last, b.role as by_role
            from public.interventions i
            join public.enrolments e on e.id = i.enrolment_id
            join public.organisation_members m on m.id = e.member_id
            join public.cohorts h on h.id = e.cohort_id
            left join public.organisation_members b on b.id = i.recorded_by
            where i.organisation_id = ${auth.organisationId} ${scope(deps.sql, auth, hidden)}
            order by i.contacted_at desc
          `,
          timeZoneOf(auth.organisationId),
        ])
        return c.json({
          timeZone,
          interventions: rows.map((r) => ({
            id: r.id,
            participant: { id: r.member_id, name: `${r.first_name} ${r.last_name}`.trim() },
            cohort: r.cohort_name,
            method: r.method,
            outcome: r.outcome,
            at: r.contacted_at,
            notes: r.notes,
            reviewOn: r.review_on,
            by: r.by_first ? { name: `${r.by_first} ${r.by_last}`.trim(), trainer: r.by_role === 'trainer' || r.by_role === 'assistant_trainer' } : null,
          })),
        })
      })

      // D1.02 / T7.02 A participant's flags and interventions.
      .get('/participants/:memberId', async (c) => {
        const auth = c.var.auth
        const e = await currentEnrolment(auth, c.req.param('memberId'))
        const [flags, interventions, timeZone] = await Promise.all([
          deps.sql<{ id: string; rule: Rule; details: Record<string, unknown>; raised_at: Date }[]>`
            select id, rule, details, raised_at from public.attention_flags
            where enrolment_id = ${e.id} and cleared_at is null and resolved_at is null
            order by raised_at, array_position(array['missed_in_row','overdue_assignments','low_attendance','low_grade','inactive'], rule::text)
          `,
          deps.sql<{ id: string; method: string; outcome: string; contacted_at: Date; notes: string | null; review_on: string | null; by_first: string | null; by_last: string | null; by_role: string | null }[]>`
            select i.id, i.method, i.outcome, i.contacted_at, i.notes, i.review_on::text, b.first_name as by_first, b.last_name as by_last, b.role as by_role
            from public.interventions i left join public.organisation_members b on b.id = i.recorded_by
            where i.enrolment_id = ${e.id} order by i.contacted_at desc
          `,
          timeZoneOf(auth.organisationId),
        ])
        const nextReview = interventions.map((i) => i.review_on).filter((d): d is string => Boolean(d)).sort().at(-1) ?? null
        return c.json({
          timeZone,
          enrolmentId: e.id,
          cohort: { id: e.cohort_id, name: e.cohort_name },
          canResolve: await canResolve(deps.sql, auth),
          flags: flags.map((f) => ({ id: f.id, rule: f.rule, details: f.details, raisedAt: f.raised_at })),
          nextReview,
          interventions: interventions.map((i) => ({
            id: i.id,
            method: i.method,
            outcome: i.outcome,
            at: i.contacted_at,
            notes: i.notes,
            reviewOn: i.review_on,
            by: i.by_first ? { name: `${i.by_first} ${i.by_last}`.trim(), trainer: i.by_role === 'trainer' || i.by_role === 'assistant_trainer' } : null,
          })),
        })
      })

      // D1.03 / T7.03 Record an intervention. Messaging happens outside Synqop; this logs it.
      .post('/participants/:memberId/interventions', async (c) => {
        const body = await parseBody(c, Intervention)
        const auth = c.var.auth
        const e = await currentEnrolment(auth, c.req.param('memberId'))
        const tz = await timeZoneOf(auth.organisationId)
        const [{ at } = { at: new Date() }] = await deps.sql<{ at: Date }[]>`select (${body.date}::date + ${body.time}::time) at time zone ${tz} as at`
        if (at.getTime() > now().getTime() + 5 * 60 * 1000) throw new AppError(400, 'bad_request', 'Some fields need attention.', [{ field: 'date', message: 'Choose a time that has already happened.' }])
        const id = await deps.sql.begin(async (tx) => {
          const [flag] = await tx<{ id: string }[]>`
            select id from public.attention_flags where enrolment_id = ${e.id} and cleared_at is null and resolved_at is null order by raised_at limit 1
          `
          const [row] = await tx<{ id: string }[]>`
            insert into public.interventions (organisation_id, enrolment_id, flag_id, method, contacted_at, notes, outcome, review_on, recorded_by)
            values (${auth.organisationId}, ${e.id}, ${flag?.id ?? null}, ${body.method}, ${at}, ${body.notes}, ${body.outcome}, ${body.reviewOn}, ${auth.memberId})
            returning id
          `
          await audit(tx, { organisationId: auth.organisationId, actorMemberId: auth.memberId, action: 'intervention.recorded', entityType: 'enrolment', entityId: e.id, data: { method: body.method, outcome: body.outcome }, requestId: c.var.requestId })
          return row!.id
        })
        return c.json({ intervention: { id } }, 201)
      })

      // D1.02 Resolve: admins close every open flag for the participant, with a note.
      .post('/participants/:memberId/resolve', async (c) => {
        const body = await parseBody(c, Resolve)
        const auth = c.var.auth
        if (!(await canResolve(deps.sql, auth))) throw forbidden('Only admins can resolve flags.')
        const e = await currentEnrolment(auth, c.req.param('memberId'))
        const resolved = await deps.sql.begin(async (tx) => {
          const rows = await tx<{ id: string; rule: string }[]>`
            update public.attention_flags set resolved_at = ${now()}, resolved_by = ${auth.memberId}, resolution_note = ${body.note}
            where enrolment_id = ${e.id} and cleared_at is null and resolved_at is null
            returning id, rule
          `
          if (rows.length) {
            await audit(tx, { organisationId: auth.organisationId, actorMemberId: auth.memberId, action: 'attention.resolved', entityType: 'enrolment', entityId: e.id, data: { rules: rows.map((r) => r.rule) }, requestId: c.var.requestId })
          }
          return rows.length
        })
        if (!resolved) throw new AppError(409, 'nothing_to_resolve', `${e.first_name} has no open flags.`)
        return c.json({ resolved })
      })
  )
}
