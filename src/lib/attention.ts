import type { Sql, Tx } from './db.js'

export type Rule = 'low_attendance' | 'missed_in_row' | 'overdue_assignments' | 'inactive' | 'low_grade'

export interface RuleSettings {
  attendance: { enabled: boolean; belowPct: number }
  missedInRow: { enabled: boolean; count: number }
  overdue: { enabled: boolean; count: number }
  inactivity: { enabled: boolean; days: number }
  grade: { enabled: boolean; belowPct: number }
  /** F1.06 "Who sees flags" and "Closing a flag". */
  trainersSee: boolean
  clearAutomatically: boolean
  trainersCanResolve: boolean
}

export async function ruleSettings(sql: Sql | Tx, organisationId: string): Promise<RuleSettings> {
  const [s] = await sql<
    {
      flag_attendance_enabled: boolean
      flag_attendance_below_pct: string
      flag_missed_in_row_enabled: boolean
      flag_missed_in_row_count: number
      flag_overdue_enabled: boolean
      flag_overdue_count: number
      flag_inactivity_enabled: boolean
      flag_inactivity_days: number
      flag_grade_enabled: boolean
      flag_grade_below_pct: string
      flag_trainers_see: boolean
      flag_clear_automatically: boolean
      flag_trainers_can_resolve: boolean
    }[]
  >`
    select flag_attendance_enabled, flag_attendance_below_pct, flag_missed_in_row_enabled, flag_missed_in_row_count,
           flag_overdue_enabled, flag_overdue_count, flag_inactivity_enabled, flag_inactivity_days, flag_grade_enabled, flag_grade_below_pct,
           flag_trainers_see, flag_clear_automatically, flag_trainers_can_resolve
    from public.organisation_settings where organisation_id = ${organisationId}
  `
  return {
    attendance: { enabled: s?.flag_attendance_enabled ?? true, belowPct: Number(s?.flag_attendance_below_pct ?? 75) },
    missedInRow: { enabled: s?.flag_missed_in_row_enabled ?? true, count: s?.flag_missed_in_row_count ?? 2 },
    overdue: { enabled: s?.flag_overdue_enabled ?? true, count: s?.flag_overdue_count ?? 1 },
    inactivity: { enabled: s?.flag_inactivity_enabled ?? true, days: s?.flag_inactivity_days ?? 7 },
    grade: { enabled: s?.flag_grade_enabled ?? true, belowPct: Number(s?.flag_grade_below_pct ?? 50) },
    trainersSee: s?.flag_trainers_see ?? true,
    clearAutomatically: s?.flag_clear_automatically ?? true,
    trainersCanResolve: s?.flag_trainers_can_resolve ?? false,
  }
}

interface Facts {
  enrolment_id: string
  enrolled_at: Date
  present: number
  recorded: number
  /** Most recent held, recorded sessions first: 'present' | 'absent' | 'excused'. */
  recent_marks: string[]
  recent_dates: Date[]
  last_present_at: Date | null
  overdue_titles: string[]
  overdue_dates: Date[]
  grade_avg: string | null
  graded: number
  last_sign_in_at: Date | null
  last_submission_at: Date | null
}

/** What each rule says about one enrolment right now, with the details shown on D1. */
function evaluate(f: Facts, r: RuleSettings, now: Date): Partial<Record<Rule, Record<string, unknown>>> {
  const out: Partial<Record<Rule, Record<string, unknown>>> = {}
  if (r.attendance.enabled && f.recorded > 0) {
    const pct = Math.round((f.present / f.recorded) * 100)
    if (pct < r.attendance.belowPct) out.low_attendance = { attendancePct: pct, present: f.present, recorded: f.recorded, threshold: r.attendance.belowPct }
  }
  if (r.missedInRow.enabled) {
    let missed = 0
    while (missed < f.recent_marks.length && f.recent_marks[missed] === 'absent') missed++
    if (missed >= r.missedInRow.count) {
      out.missed_in_row = { missed, of: Math.min(f.recent_marks.length, missed + 1), dates: f.recent_dates.slice(0, missed), lastPresentAt: f.last_present_at }
    }
  }
  if (r.overdue.enabled && f.overdue_titles.length >= r.overdue.count) {
    out.overdue_assignments = { count: f.overdue_titles.length, titles: f.overdue_titles, dueDates: f.overdue_dates }
  }
  if (r.inactivity.enabled) {
    const last = [f.last_sign_in_at, f.last_present_at, f.last_submission_at, f.enrolled_at].filter(Boolean).map((d) => d!.getTime())
    const days = Math.floor((now.getTime() - Math.max(...last)) / 86400000)
    if (days >= r.inactivity.days) out.inactive = { days, lastSignInAt: f.last_sign_in_at }
  }
  if (r.grade.enabled && f.graded > 0 && f.grade_avg !== null && Number(f.grade_avg) < r.grade.belowPct) {
    out.low_grade = { averagePct: Math.round(Number(f.grade_avg)), graded: f.graded, threshold: r.grade.belowPct }
  }
  return out
}

/**
 * Re-checks every active participant in running cohorts (§05 "Needs attention"): opens flags for rules that match,
 * clears open flags that no longer match. A resolved flag doesn't reopen while the rule keeps matching;
 * once it stops matching, the next match opens a new flag.
 */
export async function refreshFlags(sql: Sql, organisationId: string, now = new Date()): Promise<void> {
  const rules = await ruleSettings(sql, organisationId)
  const facts = await sql<Facts[]>`
    with mine as (
      select e.id as enrolment_id, e.member_id, e.cohort_id, e.enrolled_at
      from public.enrolments e join public.cohorts h on h.id = e.cohort_id
      where e.organisation_id = ${organisationId} and e.status = 'active' and public.status(h) = 'active'
    ), marks as (
      select m.enrolment_id, a.status, s.starts_at
      from mine m
      join public.cohort_courses x on x.cohort_id = m.cohort_id
      join public.sessions s on s.cohort_course_id = x.id and s.cancelled_at is null and s.ends_at <= ${now}
      join public.attendance_records a on a.session_id = s.id and a.member_id = m.member_id
    ), overdue as (
      select m.enrolment_id, a.title, a.due_at
      from mine m
      join public.cohort_courses x on x.cohort_id = m.cohort_id
      join public.assignments a on a.cohort_course_id = x.id and a.published_at is not null and a.due_at < ${now}
      where not exists (select 1 from public.submissions s where s.assignment_id = a.id and s.member_id = m.member_id)
    )
    select m.enrolment_id, m.enrolled_at,
           (select count(*)::int from marks k where k.enrolment_id = m.enrolment_id and k.status = 'present') as present,
           (select count(*)::int from marks k where k.enrolment_id = m.enrolment_id) as recorded,
           coalesce((select array_agg(k.status::text order by k.starts_at desc) from marks k where k.enrolment_id = m.enrolment_id), '{}') as recent_marks,
           coalesce((select array_agg(k.starts_at order by k.starts_at desc) from marks k where k.enrolment_id = m.enrolment_id), '{}') as recent_dates,
           (select max(k.starts_at) from marks k where k.enrolment_id = m.enrolment_id and k.status = 'present') as last_present_at,
           coalesce((select array_agg(o.title order by o.due_at) from overdue o where o.enrolment_id = m.enrolment_id), '{}') as overdue_titles,
           coalesce((select array_agg(o.due_at order by o.due_at) from overdue o where o.enrolment_id = m.enrolment_id), '{}') as overdue_dates,
           (select avg(g.score_pct) from public.submissions s join public.grades g on g.submission_id = s.id
             join public.assignments a on a.id = s.assignment_id join public.cohort_courses x on x.id = a.cohort_course_id
             where s.member_id = m.member_id and x.cohort_id = m.cohort_id and g.score_pct is not null) as grade_avg,
           (select count(*)::int from public.submissions s join public.grades g on g.submission_id = s.id
             join public.assignments a on a.id = s.assignment_id join public.cohort_courses x on x.id = a.cohort_course_id
             where s.member_id = m.member_id and x.cohort_id = m.cohort_id and g.score_pct is not null) as graded,
           u.last_sign_in_at,
           (select max(s.submitted_at) from public.submissions s where s.member_id = m.member_id) as last_submission_at
    from mine m
    join public.organisation_members om on om.id = m.member_id
    left join auth.users u on u.id = om.user_id
  `
  const matches = new Map<string, Partial<Record<Rule, Record<string, unknown>>>>()
  for (const f of facts) matches.set(f.enrolment_id, evaluate(f, rules, now))

  await sql.begin(async (tx) => {
    // Flags not yet cleared: open ones, and resolved ones still "holding" their rule.
    const live = await tx<{ id: string; enrolment_id: string; rule: Rule; resolved_at: Date | null }[]>`
      select f.id, f.enrolment_id, f.rule, f.resolved_at from public.attention_flags f
      where f.organisation_id = ${organisationId} and f.cleared_at is null
    `
    const held = new Set(live.map((f) => `${f.enrolment_id}:${f.rule}`))
    for (const f of live) {
      const details = matches.get(f.enrolment_id)?.[f.rule]
      // With "Clear automatically" off, an open flag waits for someone to resolve it; resolved ones still close.
      if (!details && (rules.clearAutomatically || f.resolved_at)) {
        await tx`update public.attention_flags set cleared_at = ${now} where id = ${f.id}`
      } else if (details && !f.resolved_at) {
        await tx`update public.attention_flags set details = ${tx.json(details as never)} where id = ${f.id}`
      }
    }
    for (const [enrolmentId, rulesMatched] of matches) {
      for (const [rule, details] of Object.entries(rulesMatched) as [Rule, Record<string, unknown>][]) {
        if (held.has(`${enrolmentId}:${rule}`)) continue
        await tx`
          insert into public.attention_flags (organisation_id, enrolment_id, rule, details, raised_at)
          values (${organisationId}, ${enrolmentId}, ${rule}, ${tx.json(details as never)}, ${now})
          on conflict do nothing
        `
      }
    }
  })
}
