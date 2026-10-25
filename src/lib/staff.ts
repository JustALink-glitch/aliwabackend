import type { AuthContext } from './auth.js'
import type { Sql, Tx } from './db.js'

/**
 * What a staff member can do, and where (§02 permission matrix). Admins can do everything everywhere except
 * write session reports. Trainers act on the cohort courses they teach; assistants only where the
 * organisation allows it (F1.04).
 */
export interface StaffScope {
  admin: boolean
  assistant: boolean
  /** Cohort courses this person teaches. Null for admins (all). */
  teaches: Set<string> | null
  assistantCan: { attendance: boolean; resources: boolean; reports: boolean }
}

export const isAdmin = (auth: AuthContext) => auth.role === 'owner' || auth.role === 'admin'

export async function staffScope(sql: Sql | Tx, auth: AuthContext): Promise<StaffScope> {
  if (isAdmin(auth)) return { admin: true, assistant: false, teaches: null, assistantCan: { attendance: true, resources: true, reports: false } }
  const [[s], rows] = await Promise.all([
    sql<{ attendance: boolean; resources: boolean; reports: boolean }[]>`
      select assistant_can_take_attendance and assistants_enabled as attendance, assistant_can_add_resources and assistants_enabled as resources,
             assistant_can_write_reports and assistants_enabled as reports
      from public.organisation_settings where organisation_id = ${auth.organisationId}
    `,
    sql<{ id: string }[]>`select cohort_course_id as id from public.cohort_course_trainers where member_id = ${auth.memberId}`,
  ])
  return {
    admin: false,
    assistant: auth.role === 'assistant_trainer',
    teaches: new Set(rows.map((r) => r.id)),
    assistantCan: { attendance: s?.attendance ?? true, resources: s?.resources ?? true, reports: s?.reports ?? false },
  }
}

const teaches = (s: StaffScope, cohortCourseId: string) => s.teaches === null || s.teaches.has(cohortCourseId)

/** Cohort courses in scope, for SQL filters; null means all. */
export const teachingIds = (s: StaffScope) => (s.teaches ? [...s.teaches] : null)

export const can = (s: StaffScope, cohortCourseId: string) => ({
  see: teaches(s, cohortCourseId),
  /** Schedule, edit, cancel: admins, and lead trainers in their own cohorts. */
  schedule: s.admin || (!s.assistant && teaches(s, cohortCourseId)),
  attendance: teaches(s, cohortCourseId) && (s.admin || !s.assistant || s.assistantCan.attendance),
  resources: teaches(s, cohortCourseId) && (s.admin || !s.assistant || s.assistantCan.resources),
  /** Session reports are written by the session's trainers, never by admins. */
  report: !s.admin && teaches(s, cohortCourseId) && (!s.assistant || s.assistantCan.reports),
})
