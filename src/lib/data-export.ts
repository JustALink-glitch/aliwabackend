import { csvCell } from './exports.js'
import type { PendingQuery, Row } from 'postgres'
import type { Sql } from './db.js'
import type { FileStorage } from './storage.js'
import { safeFileName } from './storage.js'

/** F1.10 export options, in the order of the design. */
export const EXPORT_PARTS = ['people', 'attendance', 'assignments', 'files', 'reports', 'interventions'] as const
export type ExportPart = (typeof EXPORT_PARTS)[number]

export const partLabel: Record<ExportPart, string> = {
  people: 'Participants, trainers and enrolments',
  attendance: 'Attendance, including edit history',
  assignments: 'Assignments, submissions and grades',
  files: 'Submission files',
  reports: 'Session reports and feedback',
  interventions: 'Interventions, outcomes and certificates',
}

/** "Everything except files", "Participants only", or a short list. */
export function includesLabel(parts: string[]): string {
  const set = new Set(parts)
  const all = EXPORT_PARTS.every((p) => set.has(p))
  if (all) return 'Everything'
  if (EXPORT_PARTS.filter((p) => p !== 'files').every((p) => set.has(p)) && !set.has('files')) return 'Everything except files'
  if (set.size === 1 && set.has('people')) return 'Participants only'
  const short: Record<ExportPart, string> = {
    people: 'People',
    attendance: 'Attendance',
    assignments: 'Assignments',
    files: 'Files',
    reports: 'Reports',
    interventions: 'Interventions',
  }
  return EXPORT_PARTS.filter((p) => set.has(p))
    .map((p) => short[p])
    .join(', ')
}

/** Submission files stop being added past this, so the ZIP stays a size people can download. */
export const FILES_LIMIT_BYTES = 200 * 1024 * 1024

type Cell = string | number | null | undefined
type Table = { name: string; columns: string[]; rows: Cell[][] }

const csv = (t: Table) =>
  Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from([t.columns, ...t.rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n', 'utf8')])

/**
 * Builds the files for a data export: CSVs per area, the submission files if asked for,
 * and a README. Times are in the organisation's time zone.
 */
export async function buildDataExport(sql: Sql, storage: FileStorage, organisationId: string, parts: string[]) {
  const want = new Set(parts)
  const [org] = await sql<{ name: string; time_zone: string }[]>`select name, time_zone from public.organisations where id = ${organisationId}`
  const tz = org!.time_zone
  const at = (column: PendingQuery<Row[]>) => sql`to_char(${column} at time zone ${tz}, 'YYYY-MM-DD HH24:MI')`
  const person = (alias: string) => sql.unsafe(`nullif(trim(coalesce(${alias}.first_name, '') || ' ' || coalesce(${alias}.last_name, '')), '')`)
  const tables: Table[] = []
  const add = (name: string, columns: string[], rows: Cell[][]) => tables.push({ name, columns, rows })

  // Always: how the organisation is set up, so the other files make sense.
  add(
    'programmes.csv',
    ['Programme', 'Description', 'Created', 'Archived'],
    await sql`select name, description, ${at(sql`created_at`)}, ${at(sql`archived_at`)} from public.programmes where organisation_id = ${organisationId} order by name`.values(),
  )
  add(
    'cohorts.csv',
    ['Programme', 'Cohort', 'Starts', 'Ends', 'Delivery', 'Archived'],
    await sql`
      select p.name as programme, h.name, h.starts_on::text, h.ends_on::text, h.delivery_mode::text, ${at(sql`h.archived_at`)}
      from public.cohorts h join public.programmes p on p.id = h.programme_id where h.organisation_id = ${organisationId} order by p.name, h.starts_on`.values(),
  )
  add(
    'courses.csv',
    ['Programme', 'Cohort', 'Course'],
    await sql`
      select p.name as programme, h.name as cohort, co.name as course
      from public.cohort_courses x join public.cohorts h on h.id = x.cohort_id join public.programmes p on p.id = x.programme_id join public.courses co on co.id = x.course_id
      where x.organisation_id = ${organisationId} order by p.name, h.name, co.name`.values(),
  )
  add(
    'sessions.csv',
    ['Cohort', 'Course', 'Session', 'Starts', 'Ends', 'Mode', 'Location', 'Trainer', 'Cancelled', 'Cancellation reason'],
    await sql`
      select h.name as cohort, co.name as course, s.title, ${at(sql`s.starts_at`)} as starts, ${at(sql`s.ends_at`)} as ends, s.mode::text, s.location,
             ${person('t')} as trainer, ${at(sql`s.cancelled_at`)} as cancelled, s.cancellation_reason
      from public.sessions s join public.cohort_courses x on x.id = s.cohort_course_id join public.cohorts h on h.id = x.cohort_id join public.courses co on co.id = x.course_id
      left join public.organisation_members t on t.id = s.trainer_member_id
      where s.organisation_id = ${organisationId} order by s.starts_at`.values(),
  )

  if (want.has('people')) {
    add(
      'participants.csv',
      ['Name', 'Email', 'Phone', 'Status', 'Invited', 'Joined'],
      await sql`
        select ${person('m')} as name, m.email, m.phone, m.status::text, ${at(sql`m.invited_at`)}, ${at(sql`m.joined_at`)}
        from public.organisation_members m where m.organisation_id = ${organisationId} and m.role = 'participant' order by m.last_name, m.first_name`.values(),
    )
    add(
      'staff.csv',
      ['Name', 'Email', 'Phone', 'Role', 'Status', 'Joined'],
      await sql`
        select ${person('m')} as name, m.email, m.phone, m.role::text, m.status::text, ${at(sql`m.joined_at`)}
        from public.organisation_members m where m.organisation_id = ${organisationId} and m.role <> 'participant' order by m.role, m.last_name`.values(),
    )
    add(
      'trainer_assignments.csv',
      ['Cohort', 'Course', 'Trainer', 'Email'],
      await sql`
        select h.name as cohort, co.name as course, ${person('m')} as trainer, m.email
        from public.cohort_course_trainers t join public.cohort_courses x on x.id = t.cohort_course_id join public.cohorts h on h.id = x.cohort_id
        join public.courses co on co.id = x.course_id join public.organisation_members m on m.id = t.member_id
        where t.organisation_id = ${organisationId} order by h.name, co.name`.values(),
    )
    add(
      'enrolments.csv',
      ['Participant', 'Email', 'Programme', 'Cohort', 'Status', 'Status reason', 'Enrolled'],
      await sql`
        select ${person('m')} as name, m.email, p.name as programme, h.name as cohort, e.status::text, e.status_reason, ${at(sql`e.enrolled_at`)}
        from public.enrolments e join public.organisation_members m on m.id = e.member_id join public.cohorts h on h.id = e.cohort_id join public.programmes p on p.id = h.programme_id
        where e.organisation_id = ${organisationId} order by p.name, h.name, m.last_name`.values(),
    )
  }

  if (want.has('attendance')) {
    add(
      'attendance.csv',
      ['Session starts', 'Cohort', 'Course', 'Participant', 'Email', 'Status', 'Source', 'Late', 'Minutes in meeting', 'Note', 'Recorded by', 'Recorded'],
      await sql`
        select ${at(sql`s.starts_at`)} as starts, h.name as cohort, co.name as course, ${person('m')} as name, m.email, a.status::text, a.source::text,
               case when a.is_late then 'Yes' else '' end as late, a.minutes_in_meeting, a.note, ${person('r')} as by, ${at(sql`a.updated_at`)} as at
        from public.attendance_records a join public.sessions s on s.id = a.session_id join public.cohort_courses x on x.id = s.cohort_course_id
        join public.cohorts h on h.id = x.cohort_id join public.courses co on co.id = x.course_id join public.organisation_members m on m.id = a.member_id
        left join public.organisation_members r on r.id = a.recorded_by
        where a.organisation_id = ${organisationId} order by s.starts_at, m.last_name`.values(),
    )
    add(
      'attendance_changes.csv',
      ['Session starts', 'Participant', 'From', 'To', 'Reason', 'Changed by', 'Changed'],
      await sql`
        select ${at(sql`s.starts_at`)} as starts, ${person('m')} as name, c.from_status::text, c.to_status::text, c.reason, ${person('b')} as by, ${at(sql`c.created_at`)} as at
        from public.attendance_changes c join public.attendance_records a on a.id = c.attendance_record_id join public.sessions s on s.id = a.session_id
        join public.organisation_members m on m.id = a.member_id left join public.organisation_members b on b.id = c.changed_by
        where c.organisation_id = ${organisationId} order by c.created_at`.values(),
    )
  }

  if (want.has('assignments')) {
    add(
      'assignments.csv',
      ['Cohort', 'Course', 'Assignment', 'Due', 'Grading scale', 'Max points', 'Published', 'Brief'],
      await sql`
        select h.name as cohort, co.name as course, a.title, ${at(sql`a.due_at`)} as due, a.grading_scale::text, a.max_points::text, ${at(sql`a.published_at`)} as published, a.brief
        from public.assignments a join public.cohort_courses x on x.id = a.cohort_course_id join public.cohorts h on h.id = x.cohort_id join public.courses co on co.id = x.course_id
        where a.organisation_id = ${organisationId} order by h.name, a.due_at`.values(),
    )
    add(
      'submissions.csv',
      ['Cohort', 'Assignment', 'Participant', 'Email', 'Submitted', 'Late', 'Text', 'Link', 'Note', 'Files'],
      await sql`
        select h.name as cohort, a.title, ${person('m')} as name, m.email, ${at(sql`s.submitted_at`)} as submitted, case when s.is_late then 'Yes' else '' end as late,
               s.text_body, s.link_url, s.note, (select string_agg(f.name, '; ' order by f.created_at) from public.submission_files f where f.submission_id = s.id) as files
        from public.submissions s join public.assignments a on a.id = s.assignment_id join public.cohort_courses x on x.id = a.cohort_course_id
        join public.cohorts h on h.id = x.cohort_id join public.organisation_members m on m.id = s.member_id
        where s.organisation_id = ${organisationId} order by h.name, a.title, m.last_name`.values(),
    )
    add(
      'grades.csv',
      ['Cohort', 'Assignment', 'Participant', 'Points', 'Percentage', 'Letter', 'Passed', 'Score %', 'Feedback', 'Graded by', 'Graded'],
      await sql`
        select h.name as cohort, a.title, ${person('m')} as name, g.points::text, g.percentage::text, g.letter::text,
               case when g.passed is null then '' when g.passed then 'Yes' else 'No' end as passed, g.score_pct::text, g.feedback, ${person('b')} as by, ${at(sql`g.graded_at`)} as at
        from public.grades g join public.submissions s on s.id = g.submission_id join public.assignments a on a.id = s.assignment_id
        join public.cohort_courses x on x.id = a.cohort_course_id join public.cohorts h on h.id = x.cohort_id
        join public.organisation_members m on m.id = s.member_id left join public.organisation_members b on b.id = g.graded_by
        where g.organisation_id = ${organisationId} order by h.name, a.title, m.last_name`.values(),
    )
  }

  if (want.has('reports')) {
    add(
      'session_reports.csv',
      ['Session starts', 'Cohort', 'Course', 'Written by', 'Submitted', 'Question', 'Answer'],
      await sql`
        select ${at(sql`s.starts_at`)} as starts, h.name as cohort, co.name as course, ${person('w')} as by, ${at(sql`r.submitted_at`)} as submitted,
               coalesce(q.question_prompt, 'Summary') as question, coalesce(array_to_string(q.choices, '; '), q.answer, r.summary) as answer
        from public.session_reports r join public.sessions s on s.id = r.session_id join public.cohort_courses x on x.id = s.cohort_course_id
        join public.cohorts h on h.id = x.cohort_id join public.courses co on co.id = x.course_id
        left join public.organisation_members w on w.id = r.author_member_id
        left join public.session_report_answers q on q.report_id = r.id
        where r.organisation_id = ${organisationId} order by s.starts_at`.values(),
    )
    // Feedback stays anonymous, as it is in the app.
    add(
      'session_feedback.csv',
      ['Session starts', 'Cohort', 'Course', 'Rating', 'Comment', 'Left'],
      await sql`
        select ${at(sql`s.starts_at`)} as starts, h.name as cohort, co.name as course, f.rating, f.comment, ${at(sql`f.created_at`)} as at
        from public.session_feedback f join public.sessions s on s.id = f.session_id join public.cohort_courses x on x.id = s.cohort_course_id
        join public.cohorts h on h.id = x.cohort_id join public.courses co on co.id = x.course_id
        where f.organisation_id = ${organisationId} order by s.starts_at`.values(),
    )
  }

  if (want.has('interventions')) {
    add(
      'interventions.csv',
      ['Participant', 'Cohort', 'Contacted', 'Method', 'Outcome', 'Notes', 'Review on', 'Recorded by'],
      await sql`
        select ${person('m')} as name, h.name as cohort, ${at(sql`i.contacted_at`)} as contacted, i.method::text, i.outcome::text, i.notes, i.review_on::text, ${person('b')} as by
        from public.interventions i join public.enrolments e on e.id = i.enrolment_id join public.organisation_members m on m.id = e.member_id
        join public.cohorts h on h.id = e.cohort_id left join public.organisation_members b on b.id = i.recorded_by
        where i.organisation_id = ${organisationId} order by i.contacted_at`.values(),
    )
    add(
      'outcomes.csv',
      ['Participant', 'Cohort', 'Outcome', 'Organisation', 'Role', 'Achieved on', 'Notes', 'Recorded by'],
      await sql`
        select ${person('m')} as name, h.name as cohort, o.label, po.organisation_name, po.role_title, po.achieved_on::text, po.notes, ${person('b')} as by
        from public.participant_outcomes po join public.enrolments e on e.id = po.enrolment_id join public.organisation_members m on m.id = e.member_id
        join public.cohorts h on h.id = e.cohort_id left join public.programme_outcome_options o on o.id = po.outcome_option_id
        left join public.organisation_members b on b.id = po.recorded_by
        where po.organisation_id = ${organisationId} order by h.name, m.last_name`.values(),
    )
    add(
      'certificates.csv',
      ['Participant', 'Cohort', 'Title', 'Verification code', 'Issued', 'Signed by', 'Revoked', 'Revoked reason'],
      await sql`
        select ${person('m')} as name, h.name as cohort, c.title, c.verification_code, ${at(sql`c.issued_at`)} as issued,
               concat_ws(', ', c.signatory_name, c.signatory_title) as signed, ${at(sql`c.revoked_at`)} as revoked, c.revoked_reason
        from public.certificates c join public.enrolments e on e.id = c.enrolment_id join public.organisation_members m on m.id = e.member_id
        join public.cohorts h on h.id = e.cohort_id
        where c.organisation_id = ${organisationId} order by c.issued_at`.values(),
    )
  }

  const files: { name: string; data: Uint8Array }[] = tables.map((t) => ({ name: t.name, data: csv(t) }))

  // Submission files go under files/<cohort>/<assignment>/<participant> - <name>.
  const left: Cell[][] = []
  if (want.has('files')) {
    const rows = await sql<{ path: string; name: string; size: string; cohort: string; assignment: string; person: string }[]>`
      select f.storage_path as path, f.name, f.size_bytes::text as size, h.name as cohort, a.title as assignment, ${person('m')} as person
      from public.submission_files f join public.submissions s on s.id = f.submission_id join public.assignments a on a.id = s.assignment_id
      join public.cohort_courses x on x.id = a.cohort_course_id join public.cohorts h on h.id = x.cohort_id join public.organisation_members m on m.id = s.member_id
      where f.organisation_id = ${organisationId} order by h.name, a.title, m.last_name
    `
    let total = 0
    const used = new Set<string>()
    for (const r of rows) {
      const size = Number(r.size)
      if (total + size > FILES_LIMIT_BYTES) {
        left.push([r.cohort, r.assignment, r.person, r.name, 'Over the export size limit'])
        continue
      }
      const data = await storage.read(r.path).catch(() => null)
      if (!data) {
        left.push([r.cohort, r.assignment, r.person, r.name, 'File not found in storage'])
        continue
      }
      total += data.length
      let name = `files/${safeFileName(r.cohort)}/${safeFileName(r.assignment)}/${safeFileName(`${r.person} - ${r.name}`)}`
      for (let n = 2; used.has(name); n++) name = name.replace(/(\.[^./]*)?$/, `-${n}$1`)
      used.add(name)
      files.push({ name, data })
    }
    if (left.length) files.push({ name: 'files_not_included.csv', data: csv({ name: '', columns: ['Cohort', 'Assignment', 'Participant', 'File', 'Why'], rows: left }) })
  }

  const readme = [
    `${org!.name} — data export from Synqop`,
    '',
    `Includes: ${EXPORT_PARTS.filter((p) => want.has(p))
      .map((p) => partLabel[p])
      .join('; ')}.`,
    `Times are in ${tz}. Each CSV is UTF-8 and opens in Excel, Google Sheets or Numbers.`,
    'Session feedback is anonymous, as it is in Synqop.',
    left.length ? `${left.length} submission file(s) aren't included; see files_not_included.csv.` : '',
  ]
    .filter(Boolean)
    .join('\r\n')
  files.unshift({ name: 'README.txt', data: Buffer.from(readme + '\r\n', 'utf8') })
  return { organisationName: org!.name, files }
}
