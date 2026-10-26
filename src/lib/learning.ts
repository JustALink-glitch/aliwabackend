import type { Sql } from './db.js'

/**
 * One participant's held sessions (with their mark) and published assignments (with status and grade)
 * in a cohort. `trainerId` limits both to the courses that trainer teaches (T7.02); admins see all (B1.04).
 */
export async function participantLearning(sql: Sql, input: { memberId: string; cohortId: string; trainerId?: string | null }) {
  const mine = input.trainerId
    ? sql`and x.id in (select cohort_course_id from public.cohort_course_trainers where member_id = ${input.trainerId})`
    : sql``
  const [sessions, work] = await Promise.all([
    sql<{ id: string; starts_at: Date; course_name: string; mark: string | null }[]>`
      select s.id, s.starts_at, co.name as course_name, a.status as mark
      from public.sessions s
      join public.cohort_courses x on x.id = s.cohort_course_id
      join public.courses co on co.id = x.course_id
      left join public.attendance_records a on a.session_id = s.id and a.member_id = ${input.memberId}
      where x.cohort_id = ${input.cohortId} and s.cancelled_at is null and s.ends_at <= now() ${mine}
      order by s.starts_at
    `,
    sql<{ id: string; title: string; course_name: string; due_at: Date; submitted_at: Date | null; is_late: boolean | null; graded: boolean; grading_scale: string; max_points: string | null; points: string | null; percentage: string | null; letter: string | null; passed: boolean | null; total: number | null; criteria: number }[]>`
      select a.id, a.title, co.name as course_name, a.due_at, s.submitted_at, s.is_late, (g.id is not null) as graded,
             a.grading_scale, a.max_points, g.points, g.percentage, g.letter, g.passed,
             (select sum(r.score)::int from public.rubric_scores r where r.grade_id = g.id) as total,
             (select count(*)::int from public.rubric_criteria rc where rc.assignment_id = a.id) as criteria
      from public.assignments a
      join public.cohort_courses x on x.id = a.cohort_course_id
      join public.courses co on co.id = x.course_id
      left join public.submissions s on s.assignment_id = a.id and s.member_id = ${input.memberId}
      left join public.grades g on g.submission_id = s.id
      where x.cohort_id = ${input.cohortId} and a.published_at is not null ${mine}
      order by a.due_at desc
    `,
  ])
  const display = (w: (typeof work)[number]) => {
    if (!w.graded) return null
    switch (w.grading_scale) {
      case 'points':
        return `${Number(w.points)} / ${Number(w.max_points)}`
      case 'percentage':
        return `${Number(w.percentage)}%`
      case 'letter':
        return w.letter
      case 'pass_fail':
        return w.passed ? 'Pass' : 'Fail'
      default:
        return `${w.total ?? 0} / ${w.criteria * 4}`
    }
  }
  const recorded = sessions.filter((s) => s.mark)
  return {
    attendance: { present: recorded.filter((s) => s.mark === 'present').length, recorded: recorded.length },
    sessions: sessions.map((s) => ({ id: s.id, startsAt: s.starts_at, course: s.course_name, mark: s.mark })),
    assignments: work.map((w) => ({
      id: w.id,
      title: w.title,
      course: w.course_name,
      dueAt: w.due_at,
      submittedAt: w.submitted_at,
      status: w.graded ? 'graded' : w.submitted_at ? (w.is_late ? 'late' : 'submitted') : w.due_at.getTime() < Date.now() ? 'overdue' : 'not_submitted',
      grade: display(w),
    })),
  }
}
