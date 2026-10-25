import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { refreshFlags, ruleSettings } from '../lib/attention.js'
import { completionRule } from '../lib/completion.js'
import { audit, type Tx } from '../lib/db.js'
import { parseBody, timeZone, uuid } from '../lib/validation.js'
import { shortName } from '../lib/names.js'
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

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null)

const Organisation = z.object({
  name: z.string().trim().min(1, 'Enter your organisation’s name.').max(120, 'Use 120 characters or fewer.'),
  type: optionalText(60),
  country: z
    .preprocess((v) => (v === '' ? null : v), z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Choose a country.').nullish())
    .transform((v) => v ?? null),
  timeZone,
})

const GRADING_SCALES = ['points', 'percentage', 'letter', 'pass_fail', 'rubric'] as const

const ProgrammeSetup = z.object({
  courseLibrary: z.enum(['shared', 'per_cohort']),
  trainerAssignment: z.enum(['course', 'cohort']),
  assistantsEnabled: z.boolean(),
  assistantCan: z.object({ attendance: z.boolean(), resources: z.boolean(), grade: z.boolean(), assignments: z.boolean(), reports: z.boolean() }),
  multiCohort: z.boolean(),
  gradingScales: z
    .array(z.enum(GRADING_SCALES))
    .min(1, 'Allow at least one scale.')
    .transform((v) => GRADING_SCALES.filter((x) => v.includes(x))),
  feedbackEnabled: z.boolean(),
})

const Attendance = z.object({
  joinLinks: z.enum(['personal', 'shared']),
  presentMinPct: pct.refine((v) => v >= 1, 'Use 1 to 100.'),
  late: z.object({ enabled: z.boolean(), minutes: z.coerce.number({ error: 'Enter minutes.' }).int('Use whole minutes.').min(1, 'Use 1 minute or more.').max(240, 'Use 240 minutes or fewer.') }),
  recordings: z.object({ shared: z.boolean(), days: z.coerce.number({ error: 'Enter days.' }).int('Use whole days.').min(1, 'Use 1 day or more.').max(365, 'Use 365 days or fewer.') }),
  inPersonReminder: z.object({ enabled: z.boolean(), hours: z.coerce.number({ error: 'Enter hours.' }).int('Use whole hours.').min(1, 'Use 1 hour or more.').max(72, 'Use 72 hours or fewer.') }),
})

/** /v1/settings — F1.01 Organisation details, F1.04 Programme setup, F1.07 Attendance & Zoom, F1.05 Completion & certificates, F1.06 Needs attention rules, F1.08 Session reports (owners and admins). */
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

  async function organisationView(organisationId: string) {
    const [[o], [owner]] = await Promise.all([
      deps.sql<{ name: string; type: string | null; country: string | null; time_zone: string; created_at: Date }[]>`
        select name, type, country, time_zone, created_at from public.organisations where id = ${organisationId}
      `,
      deps.sql<{ first_name: string; last_name: string }[]>`
        select first_name, last_name from public.organisation_members
        where organisation_id = ${organisationId} and role = 'owner' and status <> 'deactivated' order by created_at limit 1
      `,
    ])
    return { name: o!.name, type: o!.type, country: o!.country, timeZone: o!.time_zone, owner: owner ? shortName(owner.first_name, owner.last_name) : null, createdAt: o!.created_at }
  }

  async function programmeSetup(organisationId: string) {
    const [s] = await deps.sql<
      {
        library: 'shared' | 'per_cohort'
        assignment: 'course' | 'cohort'
        assistants: boolean
        attendance: boolean
        resources: boolean
        grade: boolean
        assignments: boolean
        reports: boolean
        multi: boolean
        scales: string[]
        feedback: boolean
      }[]
    >`
      select course_library_mode as library, trainer_assignment as assignment, assistants_enabled as assistants,
             assistant_can_take_attendance as attendance, assistant_can_add_resources as resources, assistant_can_grade as grade,
             assistant_can_create_assignments as assignments, assistant_can_write_reports as reports,
             allow_multi_cohort_enrolment as multi, allowed_grading_scales::text[] as scales, session_feedback_enabled as feedback
      from public.organisation_settings where organisation_id = ${organisationId}
    `
    return {
      courseLibrary: s!.library,
      trainerAssignment: s!.assignment,
      assistantsEnabled: s!.assistants,
      assistantCan: { attendance: s!.attendance, resources: s!.resources, grade: s!.grade, assignments: s!.assignments, reports: s!.reports },
      multiCohort: s!.multi,
      gradingScales: GRADING_SCALES.filter((x) => s!.scales.includes(x)),
      feedbackEnabled: s!.feedback,
    }
  }

  async function attendanceSettings(organisationId: string) {
    const [[s], [zoom]] = await Promise.all([
      deps.sql<
        { links: 'personal' | 'shared'; present: number; late_on: boolean; late: number; rec_on: boolean; rec_days: number; remind_on: boolean; remind: number }[]
      >`
        select join_link_mode as links, zoom_present_min_pct::int as present, zoom_late_enabled as late_on, zoom_late_after_minutes as late,
               recordings_shared as rec_on, recording_retention_days as rec_days, in_person_reminder_enabled as remind_on, in_person_reminder_hours as remind
        from public.organisation_settings where organisation_id = ${organisationId}
      `,
      deps.sql<{ email: string | null }[]>`select zoom_user_email as email from public.zoom_connections where organisation_id = ${organisationId}`,
    ])
    return {
      zoom: zoom ? { connected: true, email: zoom.email } : { connected: false, email: null },
      joinLinks: s!.links,
      presentMinPct: s!.present,
      late: { enabled: s!.late_on, minutes: s!.late },
      recordings: { shared: s!.rec_on, days: s!.rec_days },
      inPersonReminder: { enabled: s!.remind_on, hours: s!.remind },
    }
  }

  const changed = (tx: Tx, auth: { organisationId: string; memberId: string }, action: string, requestId: string | undefined) =>
    audit(tx, { organisationId: auth.organisationId, actorMemberId: auth.memberId, action, entityType: 'organisation', entityId: auth.organisationId, requestId })

  return (
    new Hono<{ Variables: AuthVariables }>()
      .use(requireAuth(deps), requireRole('owner', 'admin'))

      .get('/organisation', async (c) => c.json({ settings: await organisationView(c.var.auth.organisationId) }))

      .put('/organisation', async (c) => {
        const body = await parseBody(c, Organisation)
        const auth = c.var.auth
        await deps.sql.begin(async (tx) => {
          await tx`
            update public.organisations set name = ${body.name}, type = ${body.type}, country = ${body.country}, time_zone = ${body.timeZone}
            where id = ${auth.organisationId}
          `
          await changed(tx, auth, 'settings.organisation_updated', c.var.requestId)
        })
        return c.json({ settings: await organisationView(auth.organisationId) })
      })

      .get('/programme-setup', async (c) => c.json({ settings: await programmeSetup(c.var.auth.organisationId) }))

      .put('/programme-setup', async (c) => {
        const body = await parseBody(c, ProgrammeSetup)
        const auth = c.var.auth
        await deps.sql.begin(async (tx) => {
          await tx`
            update public.organisation_settings set
              course_library_mode = ${body.courseLibrary}, trainer_assignment = ${body.trainerAssignment}, assistants_enabled = ${body.assistantsEnabled},
              assistant_can_take_attendance = ${body.assistantCan.attendance}, assistant_can_add_resources = ${body.assistantCan.resources},
              assistant_can_grade = ${body.assistantCan.grade}, assistant_can_create_assignments = ${body.assistantCan.assignments},
              assistant_can_write_reports = ${body.assistantCan.reports}, allow_multi_cohort_enrolment = ${body.multiCohort},
              allowed_grading_scales = ${body.gradingScales}::public.grading_scale[], session_feedback_enabled = ${body.feedbackEnabled}, updated_at = now()
            where organisation_id = ${auth.organisationId}
          `
          await changed(tx, auth, 'settings.programme_setup_updated', c.var.requestId)
        })
        return c.json({ settings: await programmeSetup(auth.organisationId) })
      })

      .get('/attendance', async (c) => c.json({ settings: await attendanceSettings(c.var.auth.organisationId) }))

      .put('/attendance', async (c) => {
        const body = await parseBody(c, Attendance)
        const auth = c.var.auth
        await deps.sql.begin(async (tx) => {
          await tx`
            update public.organisation_settings set
              join_link_mode = ${body.joinLinks}, zoom_present_min_pct = ${body.presentMinPct},
              zoom_late_enabled = ${body.late.enabled}, zoom_late_after_minutes = ${body.late.minutes},
              recordings_shared = ${body.recordings.shared}, recording_retention_days = ${body.recordings.days},
              in_person_reminder_enabled = ${body.inPersonReminder.enabled}, in_person_reminder_hours = ${body.inPersonReminder.hours}, updated_at = now()
            where organisation_id = ${auth.organisationId}
          `
          await changed(tx, auth, 'settings.attendance_updated', c.var.requestId)
        })
        return c.json({ settings: await attendanceSettings(auth.organisationId) })
      })

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
