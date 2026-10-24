import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { certificateCode, completionFor, type CompletionRule, type EnrolmentCompletion } from '../lib/completion.js'
import { audit, type Sql } from '../lib/db.js'
import { badRequest, notFound } from '../lib/errors.js'
import { renderEmail } from '../lib/mailer.js'
import { isoDate, optionalText, parseBody, uuid } from '../lib/validation.js'
import { requireAuth, requireRole, type AuthVariables } from '../middleware/auth.js'

const Issue = z.object({
  enrolmentIds: z.array(uuid).min(1, 'Choose at least one participant.').max(500),
  notify: z.boolean().default(true),
})

const Outcome = z.object({
  enrolmentId: uuid,
  optionId: uuid,
  organisationName: optionalText(120),
  roleTitle: optionalText(120),
  achievedOn: isoDate,
  notes: optionalText(1000),
})

export interface CertificateView {
  id: string
  code: string
  title: string
  issuedAt: Date
  participant: { id: string; name: string }
  programme: string
  cohort: { id: string; name: string; endsOn: string }
  organisation: string
  signedBy: string | null
}

/** One certificate as printed (D2, P7.02). */
export async function certificateView(sql: Sql, organisationId: string, where: { id?: string; memberId?: string }): Promise<CertificateView | null> {
  const [r] = await sql<
    {
      id: string
      verification_code: string
      title: string | null
      issued_at: Date
      member_id: string
      first_name: string
      last_name: string
      programme_name: string
      cohort_id: string
      cohort_name: string
      ends_on: string
      org_name: string
      signatory_name: string | null
      signatory_title: string | null
    }[]
  >`
    select c.id, c.verification_code, c.title, c.issued_at, m.id as member_id, m.first_name, m.last_name, p.name as programme_name,
           h.id as cohort_id, h.name as cohort_name, h.ends_on::text, o.name as org_name, c.signatory_name, c.signatory_title
    from public.certificates c
    join public.enrolments e on e.id = c.enrolment_id
    join public.organisation_members m on m.id = e.member_id
    join public.cohorts h on h.id = e.cohort_id
    join public.programmes p on p.id = h.programme_id
    join public.organisations o on o.id = c.organisation_id
    where c.organisation_id = ${organisationId} and c.revoked_at is null
      ${where.id ? sql`and c.id = ${where.id}` : sql``}
      ${where.memberId ? sql`and e.member_id = ${where.memberId}` : sql``}
    order by c.issued_at desc
    limit 1
  `
  if (!r) return null
  return {
    id: r.id,
    code: r.verification_code,
    title: r.title ?? 'Certificate of Completion',
    issuedAt: r.issued_at,
    participant: { id: r.member_id, name: `${r.first_name} ${r.last_name}`.trim() },
    programme: r.programme_name,
    cohort: { id: r.cohort_id, name: r.cohort_name, endsOn: r.ends_on },
    organisation: r.org_name,
    signedBy: signedBy(r.signatory_name, r.signatory_title),
  }
}

export const signedBy = (name: string | null, title: string | null) => (name ? [name, title].filter(Boolean).join(', ') : null)

async function certificateSettings(sql: Sql, organisationId: string) {
  const [s] = await sql<{ title: string; signatory_name: string | null; signatory_title: string | null; org_name: string }[]>`
    select s.certificate_title as title, s.certificate_signatory_name as signatory_name, s.certificate_signatory_title as signatory_title, o.name as org_name
    from public.organisation_settings s join public.organisations o on o.id = s.organisation_id
    where s.organisation_id = ${organisationId}
  `
  return s!
}

/**
 * Issues certificates to enrolments that are eligible now: records the completion, marks the enrolment
 * completed and, if asked, emails a link. Used by D2.02 and by automatic issuing (F1.05).
 */
export async function issueCertificates(
  deps: AppDeps,
  input: { organisationId: string; actorMemberId: string | null; enrolments: EnrolmentCompletion[]; notify: boolean; requestId?: string },
): Promise<number> {
  const eligible = input.enrolments.filter((e) => e.status === 'eligible')
  if (!eligible.length) return 0
  const settings = await certificateSettings(deps.sql, input.organisationId)
  const issued: EnrolmentCompletion[] = []
  await deps.sql.begin(async (tx) => {
    for (const e of eligible) {
      await tx`
        insert into public.completion_reviews (organisation_id, enrolment_id, decision, decided_by, decided_at)
        values (${input.organisationId}, ${e.enrolmentId}, 'completed', ${input.actorMemberId}, now())
        on conflict (enrolment_id) do update set decision = 'completed', decided_by = excluded.decided_by, decided_at = now()
      `
      // A clash on the random code is very unlikely; try a few times.
      for (let attempt = 0; ; attempt++) {
        try {
          const [row] = await tx<{ id: string }[]>`
            insert into public.certificates (organisation_id, enrolment_id, verification_code, title, signatory_name, signatory_title, issued_by)
            values (${input.organisationId}, ${e.enrolmentId}, ${certificateCode()}, ${settings.title}, ${settings.signatory_name}, ${settings.signatory_title}, ${input.actorMemberId})
            on conflict (enrolment_id) do nothing
            returning id
          `
          if (row) issued.push(e)
          break
        } catch (error) {
          if (attempt >= 4 || (error as { code?: string }).code !== '23505') throw error
        }
      }
      await tx`update public.enrolments set status = 'completed' where id = ${e.enrolmentId} and status = 'active'`
    }
    if (issued.length) {
      await audit(tx, {
        organisationId: input.organisationId,
        actorMemberId: input.actorMemberId,
        action: 'certificates.issued',
        entityType: 'cohort',
        entityId: issued[0]!.cohort.id,
        data: { enrolmentIds: issued.map((e) => e.enrolmentId), automatic: !input.actorMemberId },
        requestId: input.requestId,
      })
    }
  })
  if (input.notify) {
    for (const e of issued) {
      const firstName = e.name.split(' ')[0]
      const subject = `Your ${settings.title.toLowerCase()} is ready`
      const { text, html } = renderEmail({
        title: subject,
        intro: `Hi ${firstName}, you’ve completed ${e.cohort.programmeName} · ${e.cohort.name}. Congratulations — your certificate is ready to download.`,
        buttonLabel: 'View certificate',
        buttonUrl: `${deps.appUrl.replace(/\/$/, '')}/participant/grades/certificate`,
        note: `Sent by ${settings.org_name} through Synqop.`,
      })
      try {
        await deps.mailer.send({ to: e.email, subject, text, html })
      } catch (error) {
        console.error('Certificate email failed', error)
      }
    }
  }
  return issued.length
}

/** Plain-language rule, as on D2.01 and P7.01. */
export function ruleSentence(rule: CompletionRule) {
  const parts = [
    rule.attendance.enabled && `${rule.attendance.minPct}% attendance`,
    rule.submissions.enabled && `${rule.submissions.minPct}% of assignments submitted`,
    rule.grade.enabled && `a ${rule.grade.minPct}% average grade`,
  ].filter(Boolean) as string[]
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? '')
  const tail = rule.autoIssue ? 'issued automatically when the cohort ends' : rule.requiresApproval ? 'confirmed by an admin' : 'issued by an admin'
  return list ? `At least ${list}, ${tail}.` : `Everyone who finishes the cohort, ${tail}.`
}

/** /v1/completion — D2 Certificates and D3 Outcomes (admins). */
export function completionRoutes(deps: AppDeps) {
  const now = () => (deps.now ? deps.now() : new Date())

  return (
    new Hono<{ Variables: AuthVariables }>()
      .use(requireAuth(deps), requireRole('owner', 'admin'))

      // D2.01 Certificates: everyone in a cohort with where they stand.
      .get('/certificates', async (c) => {
        const auth = c.var.auth
        let { rule, enrolments } = await completionFor(deps.sql, auth.organisationId)
        if (rule.autoIssue && enrolments.some((e) => e.status === 'eligible')) {
          await issueCertificates(deps, { organisationId: auth.organisationId, actorMemberId: null, enrolments, notify: true, requestId: c.var.requestId })
          ;({ rule, enrolments } = await completionFor(deps.sql, auth.organisationId))
        }
        const settings = await certificateSettings(deps.sql, auth.organisationId)
        const year = now().getUTCFullYear()
        const ended = enrolments.filter((e) => e.cohort.ended)
        return c.json({
          rule: { ...rule, sentence: ruleSentence(rule) },
          certificate: { title: settings.title, signedBy: signedBy(settings.signatory_name, settings.signatory_title), organisation: settings.org_name },
          counts: {
            eligible: enrolments.filter((e) => e.status === 'eligible').length,
            issuedThisYear: enrolments.filter((e) => e.certificate && new Date(e.certificate.issuedAt).getUTCFullYear() === year).length,
            completed: ended.filter((e) => e.status === 'issued' || e.status === 'eligible').length,
            inEndedCohorts: ended.length,
          },
          enrolments: enrolments.map((e) => ({
            enrolmentId: e.enrolmentId,
            participant: { id: e.memberId, name: e.name },
            cohort: e.cohort,
            status: e.status,
            certificate: e.certificate,
          })),
        })
      })

      // D2.02 Issue certificates.
      .post('/certificates', async (c) => {
        const body = await parseBody(c, Issue)
        const auth = c.var.auth
        const { enrolments } = await completionFor(deps.sql, auth.organisationId, { enrolmentIds: body.enrolmentIds })
        const notEligible = body.enrolmentIds.filter((id) => !enrolments.some((e) => e.enrolmentId === id && e.status === 'eligible'))
        if (notEligible.length) {
          throw badRequest('Some people can’t get a certificate yet. Refresh and try again.', [{ field: 'enrolmentIds', message: 'Only eligible participants can be issued a certificate.' }])
        }
        const issued = await issueCertificates(deps, { organisationId: auth.organisationId, actorMemberId: auth.memberId, enrolments, notify: body.notify, requestId: c.var.requestId })
        return c.json({ issued }, 201)
      })

      // Download from D2.01: the certificate as printed.
      .get('/certificates/:id', async (c) => {
        const id = c.req.param('id')
        if (!uuid.safeParse(id).success) throw notFound('Certificate not found.')
        const certificate = await certificateView(deps.sql, c.var.auth.organisationId, { id })
        if (!certificate) throw notFound('Certificate not found.')
        return c.json({ certificate })
      })

      // D3.01 Outcomes for one programme (and optionally one cohort).
      .get('/outcomes', async (c) => {
        const auth = c.var.auth
        const programmes = await deps.sql<{ id: string; name: string }[]>`
          select p.id, p.name from public.programmes p
          where p.organisation_id = ${auth.organisationId} and p.archived_at is null
          order by (select max(h.ends_on) from public.cohorts h where h.programme_id = p.id) desc nulls last, p.name
        `
        const programmeId = c.req.query('programmeId') ?? programmes[0]?.id
        if (!programmeId || !programmes.some((p) => p.id === programmeId)) {
          return c.json({ programmes, programmeId: null, cohorts: [], cohortId: null, options: [], completed: 0, notRecorded: 0, outcomes: [], people: [] })
        }
        const cohortQuery = c.req.query('cohortId')
        const cohortId = cohortQuery && uuid.safeParse(cohortQuery).success ? cohortQuery : null
        const inScope = cohortId ? deps.sql`and h.id = ${cohortId}` : deps.sql``
        const [cohorts, options, people, outcomes] = await Promise.all([
          deps.sql<{ id: string; name: string; ends_on: string }[]>`
            select h.id, h.name, h.ends_on::text from public.cohorts h
            where h.programme_id = ${programmeId} and h.organisation_id = ${auth.organisationId} and public.status(h) in ('completed', 'archived')
            order by h.ends_on desc
          `,
          deps.sql<{ id: string; label: string }[]>`
            select id, label from public.programme_outcome_options
            where programme_id = ${programmeId} and organisation_id = ${auth.organisationId} and archived_at is null order by position, label
          `,
          // People who completed: their enrolment is marked completed (a certificate was issued).
          deps.sql<{ enrolment_id: string; first_name: string; last_name: string; cohort_name: string; recorded: number }[]>`
            select e.id as enrolment_id, m.first_name, m.last_name, h.name as cohort_name,
                   (select count(*)::int from public.participant_outcomes o where o.enrolment_id = e.id) as recorded
            from public.enrolments e
            join public.organisation_members m on m.id = e.member_id
            join public.cohorts h on h.id = e.cohort_id
            where e.organisation_id = ${auth.organisationId} and h.programme_id = ${programmeId} and e.status = 'completed' ${inScope}
            order by m.first_name, m.last_name
          `,
          deps.sql<{ id: string; member_id: string; first_name: string; last_name: string; cohort_name: string; option_id: string; label: string; organisation_name: string | null; role_title: string | null; notes: string | null; achieved_on: string | null; created_at: Date }[]>`
            select o.id, m.id as member_id, m.first_name, m.last_name, h.name as cohort_name, po.id as option_id, po.label,
                   o.organisation_name, o.role_title, o.notes, o.achieved_on::text, o.created_at
            from public.participant_outcomes o
            join public.programme_outcome_options po on po.id = o.outcome_option_id
            join public.enrolments e on e.id = o.enrolment_id
            join public.organisation_members m on m.id = e.member_id
            join public.cohorts h on h.id = e.cohort_id
            where o.organisation_id = ${auth.organisationId} and h.programme_id = ${programmeId} ${inScope}
            order by coalesce(o.achieved_on, o.created_at::date) desc, o.created_at desc
          `,
        ])
        return c.json({
          programmes,
          programmeId,
          cohorts: cohorts.map((h) => ({ id: h.id, name: h.name, endsOn: h.ends_on })),
          cohortId,
          options: options.map((o) => ({ id: o.id, label: o.label, count: outcomes.filter((x) => x.option_id === o.id).length })),
          completed: people.length,
          notRecorded: people.filter((p) => !p.recorded).length,
          outcomes: outcomes.map((o) => ({
            id: o.id,
            participant: { id: o.member_id, name: `${o.first_name} ${o.last_name}`.trim() },
            cohort: o.cohort_name,
            option: { id: o.option_id, label: o.label },
            organisationName: o.organisation_name,
            roleTitle: o.role_title,
            notes: o.notes,
            achievedOn: o.achieved_on,
            recordedAt: o.created_at,
          })),
          people: people.map((p) => ({ enrolmentId: p.enrolment_id, name: `${p.first_name} ${p.last_name}`.trim(), cohort: p.cohort_name, recorded: p.recorded > 0 })),
        })
      })

      // D3.02 Record outcome. Recording the same outcome again updates it.
      .post('/outcomes', async (c) => {
        const body = await parseBody(c, Outcome)
        const auth = c.var.auth
        const [e] = await deps.sql<{ id: string; programme_id: string }[]>`
          select e.id, h.programme_id from public.enrolments e join public.cohorts h on h.id = e.cohort_id
          where e.id = ${body.enrolmentId} and e.organisation_id = ${auth.organisationId} and e.status = 'completed'
        `
        if (!e) throw badRequest('Check the outcome.', [{ field: 'enrolmentId', message: 'Choose someone who has completed.' }])
        const [option] = await deps.sql<{ id: string }[]>`
          select id from public.programme_outcome_options where id = ${body.optionId} and programme_id = ${e.programme_id} and archived_at is null
        `
        if (!option) throw badRequest('Check the outcome.', [{ field: 'optionId', message: 'Choose one of the programme’s outcomes.' }])
        const today = now().toISOString().slice(0, 10)
        if (body.achievedOn > addDaysIso(today, 1)) throw badRequest('Check the outcome.', [{ field: 'achievedOn', message: 'Choose a date that has already happened.' }])
        const id = await deps.sql.begin(async (tx) => {
          const [row] = await tx<{ id: string }[]>`
            insert into public.participant_outcomes (organisation_id, enrolment_id, outcome_option_id, organisation_name, role_title, achieved_on, notes, recorded_by)
            values (${auth.organisationId}, ${e.id}, ${option.id}, ${body.organisationName}, ${body.roleTitle}, ${body.achievedOn}, ${body.notes}, ${auth.memberId})
            on conflict (enrolment_id, outcome_option_id) do update
              set organisation_name = excluded.organisation_name, role_title = excluded.role_title, achieved_on = excluded.achieved_on,
                  notes = excluded.notes, recorded_by = excluded.recorded_by
            returning id
          `
          await audit(tx, { organisationId: auth.organisationId, actorMemberId: auth.memberId, action: 'outcome.recorded', entityType: 'enrolment', entityId: e.id, data: { optionId: option.id }, requestId: c.var.requestId })
          return row!.id
        })
        return c.json({ outcome: { id } }, 201)
      })
  )
}

function addDaysIso(day: string, n: number) {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
