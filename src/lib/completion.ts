import type { Sql, Tx } from './db.js'

export interface CompletionRule {
  attendance: { enabled: boolean; minPct: number }
  submissions: { enabled: boolean; minPct: number }
  grade: { enabled: boolean; minPct: number }
  requiresApproval: boolean
  autoIssue: boolean
}

export type Criterion = { enabled: boolean; needed: number; value: number | null; met: boolean | null; detail: string }

export interface EnrolmentCompletion {
  enrolmentId: string
  memberId: string
  name: string
  email: string
  cohort: { id: string; name: string; endsOn: string; ended: boolean; programmeId: string; programmeName: string }
  attendance: Criterion
  submissions: Criterion
  grade: Criterion
  /** All switched-on criteria are met (so far, or at the end). */
  meetsRule: boolean
  /** not_yet: cohort still running · eligible: ended and met, waiting for an admin · issued · not_completed */
  status: 'not_yet' | 'eligible' | 'issued' | 'not_completed'
  certificate: { id: string; code: string; issuedAt: Date; title: string | null } | null
  review: { decision: 'completed' | 'not_completed'; at: Date; by: string | null } | null
}

interface Row {
  enrolment_id: string
  member_id: string
  first_name: string
  last_name: string
  email: string
  enrolment_status: string
  cohort_id: string
  cohort_name: string
  ends_on: string
  ended: boolean
  programme_id: string
  programme_name: string
  p_att: string | null
  p_sub: string | null
  p_grade: string | null
  expected: number
  present: number
  published: number
  submitted: number
  grade_avg: string | null
  graded: number
  cert_id: string | null
  cert_code: string | null
  cert_at: Date | null
  cert_title: string | null
  review_decision: 'completed' | 'not_completed' | null
  review_at: Date | null
  review_first: string | null
  review_last: string | null
}

export async function completionRule(sql: Sql | Tx, organisationId: string): Promise<CompletionRule> {
  const [s] = await sql<
    {
      completion_attendance_enabled: boolean
      completion_attendance_min_pct: string
      completion_submissions_enabled: boolean
      completion_submissions_min_pct: string
      completion_grade_enabled: boolean
      completion_grade_min_pct: string
      completion_requires_approval: boolean
      certificates_auto_issue: boolean
    }[]
  >`
    select completion_attendance_enabled, completion_attendance_min_pct, completion_submissions_enabled, completion_submissions_min_pct,
           completion_grade_enabled, completion_grade_min_pct, completion_requires_approval, certificates_auto_issue
    from public.organisation_settings where organisation_id = ${organisationId}
  `
  return {
    attendance: { enabled: s?.completion_attendance_enabled ?? true, minPct: Number(s?.completion_attendance_min_pct ?? 75) },
    submissions: { enabled: s?.completion_submissions_enabled ?? true, minPct: Number(s?.completion_submissions_min_pct ?? 80) },
    grade: { enabled: s?.completion_grade_enabled ?? true, minPct: Number(s?.completion_grade_min_pct ?? 50) },
    requiresApproval: s?.completion_requires_approval ?? true,
    autoIssue: s?.certificates_auto_issue ?? false,
  }
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : null)

/**
 * Where each enrolment stands against the completion rule (§05 "Completion"): attendance is present ÷ expected
 * held sessions, submissions are handed in ÷ published work due so far, grade is the average across graded work.
 * A programme's own thresholds replace the organisation's.
 */
export async function completionFor(
  sql: Sql | Tx,
  organisationId: string,
  filter: { memberId?: string; cohortId?: string; enrolmentIds?: string[] } = {},
): Promise<{ rule: CompletionRule; enrolments: EnrolmentCompletion[] }> {
  const rule = await completionRule(sql, organisationId)
  const rows = await sql<Row[]>`
    select e.id as enrolment_id, m.id as member_id, m.first_name, m.last_name, m.email, e.status as enrolment_status,
           h.id as cohort_id, h.name as cohort_name, h.ends_on::text, (public.status(h) in ('completed', 'archived')) as ended,
           p.id as programme_id, p.name as programme_name,
           p.completion_attendance_min_pct as p_att, p.completion_submissions_min_pct as p_sub, p.completion_grade_min_pct as p_grade,
           (select count(*)::int from public.sessions s join public.cohort_courses x on x.id = s.cohort_course_id
             where x.cohort_id = h.id and s.cancelled_at is null and s.ends_at <= now()) as expected,
           (select count(*)::int from public.attendance_records a join public.sessions s on s.id = a.session_id
             join public.cohort_courses x on x.id = s.cohort_course_id
             where x.cohort_id = h.id and a.member_id = m.id and a.status = 'present' and s.cancelled_at is null) as present,
           (select count(*)::int from public.assignments a join public.cohort_courses x on x.id = a.cohort_course_id
             where x.cohort_id = h.id and a.published_at is not null and a.due_at <= now()) as published,
           (select count(*)::int from public.submissions s join public.assignments a on a.id = s.assignment_id
             join public.cohort_courses x on x.id = a.cohort_course_id
             where x.cohort_id = h.id and s.member_id = m.id and a.published_at is not null and a.due_at <= now()) as submitted,
           (select avg(g.score_pct) from public.grades g join public.submissions s on s.id = g.submission_id
             join public.assignments a on a.id = s.assignment_id join public.cohort_courses x on x.id = a.cohort_course_id
             where x.cohort_id = h.id and s.member_id = m.id and g.score_pct is not null) as grade_avg,
           (select count(*)::int from public.grades g join public.submissions s on s.id = g.submission_id
             join public.assignments a on a.id = s.assignment_id join public.cohort_courses x on x.id = a.cohort_course_id
             where x.cohort_id = h.id and s.member_id = m.id and g.score_pct is not null) as graded,
           c.id as cert_id, c.verification_code as cert_code, c.issued_at as cert_at, c.title as cert_title,
           r.decision as review_decision, r.decided_at as review_at, rb.first_name as review_first, rb.last_name as review_last
    from public.enrolments e
    join public.organisation_members m on m.id = e.member_id
    join public.cohorts h on h.id = e.cohort_id
    join public.programmes p on p.id = h.programme_id
    left join public.certificates c on c.enrolment_id = e.id and c.revoked_at is null
    left join public.completion_reviews r on r.enrolment_id = e.id
    left join public.organisation_members rb on rb.id = r.decided_by
    where e.organisation_id = ${organisationId} and e.status in ('active', 'completed') and h.archived_at is null
      ${filter.memberId ? sql`and e.member_id = ${filter.memberId}` : sql``}
      ${filter.cohortId ? sql`and h.id = ${filter.cohortId}` : sql``}
      ${filter.enrolmentIds ? sql`and e.id = any(${filter.enrolmentIds}::uuid[])` : sql``}
    order by h.ends_on desc, m.first_name, m.last_name
  `
  const enrolments = rows.map((r): EnrolmentCompletion => {
    const att = pct(r.present, r.expected)
    const sub = pct(r.submitted, r.published)
    const grade = r.grade_avg === null ? null : Math.round(Number(r.grade_avg))
    const need = {
      att: Number(r.p_att ?? rule.attendance.minPct),
      sub: Number(r.p_sub ?? rule.submissions.minPct),
      grade: Number(r.p_grade ?? rule.grade.minPct),
    }
    const crit = (enabled: boolean, needed: number, value: number | null, detail: string): Criterion => ({
      enabled,
      needed,
      value,
      // Nothing to measure yet counts as met (e.g. no assignments set).
      met: !enabled ? null : value === null ? true : value >= needed,
      detail,
    })
    const attendance = crit(rule.attendance.enabled, need.att, att, `${r.present} of ${r.expected} sessions`)
    const submissions = crit(rule.submissions.enabled, need.sub, sub, `${r.submitted} of ${r.published} due so far`)
    const gradeC = crit(rule.grade.enabled, need.grade, grade, `${r.graded} graded`)
    const meetsRule = [attendance, submissions, gradeC].every((c) => c.met !== false)
    const status: EnrolmentCompletion['status'] = r.cert_id
      ? 'issued'
      : !r.ended
        ? 'not_yet'
        : r.review_decision === 'not_completed' || !meetsRule
          ? 'not_completed'
          : 'eligible'
    return {
      enrolmentId: r.enrolment_id,
      memberId: r.member_id,
      name: `${r.first_name} ${r.last_name}`.trim(),
      email: r.email,
      cohort: { id: r.cohort_id, name: r.cohort_name, endsOn: r.ends_on, ended: r.ended, programmeId: r.programme_id, programmeName: r.programme_name },
      attendance,
      submissions,
      grade: gradeC,
      meetsRule,
      status,
      certificate: r.cert_id ? { id: r.cert_id, code: r.cert_code!, issuedAt: r.cert_at!, title: r.cert_title } : null,
      review: r.review_decision ? { decision: r.review_decision, at: r.review_at!, by: r.review_first ? `${r.review_first} ${r.review_last}`.trim() : null } : null,
    }
  })
  return { rule, enrolments }
}

/** A short code printed on the certificate: SYN-XXXX-XXXX (no look-alike characters). */
export function certificateCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const pick = () => Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('')
  return `SYN-${pick()}-${pick()}`
}
