import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { refreshFlags, ruleSettings } from '../lib/attention.js'
import { completionRule } from '../lib/completion.js'
import { audit } from '../lib/db.js'
import { parseBody, uuid } from '../lib/validation.js'
import { requireAuth, requireRole, type AuthVariables } from '../middleware/auth.js'
import { signedBy } from './completion.js'

const pct = z.coerce.number({ error: 'Enter a percentage.' }).int('Use a whole number.').min(0, 'Use 0 to 100.').max(100, 'Use 0 to 100.')
const count = (message: string) => z.coerce.number({ error: message }).int('Use a whole number.').min(1, message).max(365, 'That’s too many.')

const Completion = z.object({
  attendance: z.object({ enabled: z.boolean(), minPct: pct }),
  submissions: z.object({ enabled: z.boolean(), minPct: pct }),
  grade: z.object({ enabled: z.boolean(), minPct: pct }),
  requiresApproval: z.boolean(),
  autoIssue: z.boolean(),
  /** "Name, Title" as shown on the certificate. */
  signedBy: z.string().trim().max(160).default(''),
  certificateTitle: z.string().trim().min(1, 'Enter a title.').max(80),
  defaultOutcomes: z
    .array(z.string().trim().min(1).max(80))
    .max(20, 'Keep it to 20 options.')
    .transform((labels) => labels.filter((label, i) => labels.findIndex((l) => l.toLowerCase() === label.toLowerCase()) === i)),
})

const Rules = z.object({
  attendance: z.object({ enabled: z.boolean(), belowPct: pct }),
  missedInRow: z.object({ enabled: z.boolean(), count: count('Use 1 or more.') }),
  overdue: z.object({ enabled: z.boolean(), count: count('Use 1 or more.') }),
  inactivity: z.object({ enabled: z.boolean(), days: count('Use 1 day or more.') }),
  grade: z.object({ enabled: z.boolean(), belowPct: pct }),
  trainersSee: z.boolean(),
  clearAutomatically: z.boolean(),
  trainersCanResolve: z.boolean(),
})

const ReportSettings = z.object({
  dueHours: z.coerce.number({ error: 'Enter a number of hours.' }).int('Use whole hours.').min(1, 'Use 1 hour or more.').max(168, 'Use a week (168 hours) or less.'),
  remind: z.boolean(),
  overdueOnOverview: z.boolean(),
  questions: z
    .array(
      z.object({
        id: uuid.nullish(),
        prompt: z.string().trim().min(1, 'Write the question.').max(200),
        multiple: z.boolean(),
        options: z
          .array(z.string().trim().min(1, 'Options can’t be blank.').max(80))
          .min(2, 'Give at least two options.')
          .max(10, 'Keep it to 10 options.')
          .refine((o) => new Set(o.map((x) => x.toLowerCase())).size === o.length, 'Each option must be different.'),
      }),
    )
    .max(10, 'Keep it to 10 questions.'),
})

/** /v1/settings — F1.05 Completion & certificates, F1.06 Needs attention rules, F1.08 Session reports (owners and admins). */
export function settingsRoutes(deps: AppDeps) {
  const now = () => (deps.now ? deps.now() : new Date())

  async function completionSettings(organisationId: string) {
    const [rule, [s], [sample]] = await Promise.all([
      completionRule(deps.sql, organisationId),
      deps.sql<{ title: string; signatory_name: string | null; signatory_title: string | null; options: string[]; org_name: string }[]>`
        select s.certificate_title as title, s.certificate_signatory_name as signatory_name, s.certificate_signatory_title as signatory_title,
               s.default_outcome_options as options, o.name as org_name
        from public.organisation_settings s join public.organisations o on o.id = s.organisation_id where s.organisation_id = ${organisationId}
      `,
      // Someone real for the preview: the next cohort to finish.
      deps.sql<{ first_name: string; last_name: string; programme: string; cohort: string; ends_on: string }[]>`
        select m.first_name, m.last_name, p.name as programme, h.name as cohort, h.ends_on::text
        from public.enrolments e join public.organisation_members m on m.id = e.member_id
        join public.cohorts h on h.id = e.cohort_id join public.programmes p on p.id = h.programme_id
        where e.organisation_id = ${organisationId} and e.status = 'active' and public.status(h) in ('active', 'upcoming')
        order by h.ends_on, m.first_name limit 1
      `,
    ])
    return {
      ...rule,
      signedBy: signedBy(s!.signatory_name, s!.signatory_title) ?? '',
      certificateTitle: s!.title,
      defaultOutcomes: s!.options,
      organisation: s!.org_name,
      sample: sample ? { name: `${sample.first_name} ${sample.last_name}`.trim(), programme: sample.programme, cohort: sample.cohort, endsOn: sample.ends_on } : null,
    }
  }

  async function rulesView(organisationId: string) {
    await refreshFlags(deps.sql, organisationId, now())
    const [rules, [flagged]] = await Promise.all([
      ruleSettings(deps.sql, organisationId),
      deps.sql<{ n: number }[]>`
        select count(distinct f.enrolment_id)::int as n from public.attention_flags f
        where f.organisation_id = ${organisationId} and f.cleared_at is null and f.resolved_at is null
      `,
    ])
    return { ...rules, flaggedNow: flagged!.n }
  }

  async function reportSettings(organisationId: string) {
    const [[s], questions] = await Promise.all([
      deps.sql<{ hours: number; remind: boolean; overview: boolean }[]>`
        select report_due_hours as hours, report_reminder_enabled as remind, report_overdue_on_overview as overview
        from public.organisation_settings where organisation_id = ${organisationId}
      `,
      deps.sql<{ id: string; prompt: string; options: string[]; multiple: boolean }[]>`
        select id, prompt, options, multiple from public.report_questions where organisation_id = ${organisationId} and archived_at is null order by position, created_at
      `,
    ])
    return { dueHours: s!.hours, remind: s!.remind, overdueOnOverview: s!.overview, questions }
  }

  return (
    new Hono<{ Variables: AuthVariables }>()
      .use(requireAuth(deps), requireRole('owner', 'admin'))

      .get('/session-reports', async (c) => c.json({ settings: await reportSettings(c.var.auth.organisationId) }))

      // Questions keep their id when edited; removed ones are archived so old reports still read correctly.
      .put('/session-reports', async (c) => {
        const body = await parseBody(c, ReportSettings)
        const auth = c.var.auth
        await deps.sql.begin(async (tx) => {
          await tx`
            update public.organisation_settings set report_due_hours = ${body.dueHours}, report_reminder_enabled = ${body.remind},
              report_overdue_on_overview = ${body.overdueOnOverview}, updated_at = now()
            where organisation_id = ${auth.organisationId}
          `
          const keep = body.questions.flatMap((q) => (q.id ? [q.id] : []))
          await tx`
            update public.report_questions set archived_at = now()
            where organisation_id = ${auth.organisationId} and archived_at is null and not (id = any(${keep}::uuid[]))
          `
          for (const [i, q] of body.questions.entries()) {
            const [updated] = q.id
              ? await tx<{ id: string }[]>`
                  update public.report_questions set prompt = ${q.prompt}, options = ${q.options}, multiple = ${q.multiple}, position = ${i + 1}
                  where id = ${q.id} and organisation_id = ${auth.organisationId} and archived_at is null returning id
                `
              : []
            if (!updated) {
              await tx`
                insert into public.report_questions (organisation_id, prompt, options, multiple, position)
                values (${auth.organisationId}, ${q.prompt}, ${q.options}, ${q.multiple}, ${i + 1})
              `
            }
          }
          await audit(tx, { organisationId: auth.organisationId, actorMemberId: auth.memberId, action: 'settings.session_reports_updated', entityType: 'organisation', entityId: auth.organisationId, requestId: c.var.requestId })
        })
        return c.json({ settings: await reportSettings(auth.organisationId) })
      })

      .get('/completion', async (c) => c.json({ settings: await completionSettings(c.var.auth.organisationId) }))

      .put('/completion', async (c) => {
        const body = await parseBody(c, Completion)
        const auth = c.var.auth
        const [name, ...rest] = body.signedBy.split(',')
        const signatoryName = name?.trim() || null
        const signatoryTitle = rest.join(',').trim() || null
        await deps.sql.begin(async (tx) => {
          await tx`
            update public.organisation_settings set
              completion_attendance_enabled = ${body.attendance.enabled}, completion_attendance_min_pct = ${body.attendance.minPct},
              completion_submissions_enabled = ${body.submissions.enabled}, completion_submissions_min_pct = ${body.submissions.minPct},
              completion_grade_enabled = ${body.grade.enabled}, completion_grade_min_pct = ${body.grade.minPct},
              completion_requires_approval = ${body.requiresApproval}, certificates_auto_issue = ${body.autoIssue},
              certificate_signatory_name = ${signatoryName}, certificate_signatory_title = ${signatoryTitle},
              certificate_title = ${body.certificateTitle}, default_outcome_options = ${body.defaultOutcomes}, updated_at = now()
            where organisation_id = ${auth.organisationId}
          `
          await audit(tx, { organisationId: auth.organisationId, actorMemberId: auth.memberId, action: 'settings.completion_updated', entityType: 'organisation', entityId: auth.organisationId, requestId: c.var.requestId })
        })
        return c.json({ settings: await completionSettings(auth.organisationId) })
      })

      .get('/attention-rules', async (c) => c.json({ settings: await rulesView(c.var.auth.organisationId) }))

      .put('/attention-rules', async (c) => {
        const body = await parseBody(c, Rules)
        const auth = c.var.auth
        await deps.sql.begin(async (tx) => {
          await tx`
            update public.organisation_settings set
              flag_attendance_enabled = ${body.attendance.enabled}, flag_attendance_below_pct = ${body.attendance.belowPct},
              flag_missed_in_row_enabled = ${body.missedInRow.enabled}, flag_missed_in_row_count = ${body.missedInRow.count},
              flag_overdue_enabled = ${body.overdue.enabled}, flag_overdue_count = ${body.overdue.count},
              flag_inactivity_enabled = ${body.inactivity.enabled}, flag_inactivity_days = ${body.inactivity.days},
              flag_grade_enabled = ${body.grade.enabled}, flag_grade_below_pct = ${body.grade.belowPct},
              flag_trainers_see = ${body.trainersSee}, flag_clear_automatically = ${body.clearAutomatically},
              flag_trainers_can_resolve = ${body.trainersCanResolve}, updated_at = now()
            where organisation_id = ${auth.organisationId}
          `
          await audit(tx, { organisationId: auth.organisationId, actorMemberId: auth.memberId, action: 'settings.attention_rules_updated', entityType: 'organisation', entityId: auth.organisationId, requestId: c.var.requestId })
        })
        return c.json({ settings: await rulesView(auth.organisationId) })
      })
  )
}
