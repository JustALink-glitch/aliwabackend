import PDFDocument from 'pdfkit'
import type { Sql } from './db.js'

/** E1 report kinds (E1.02). */
export const REPORT_KINDS = ['cohort_summary', 'programme_summary', 'attendance', 'assignments', 'feedback'] as const
export type ReportKind = (typeof REPORT_KINDS)[number]

export const kindLabel: Record<ReportKind, string> = {
  cohort_summary: 'Cohort summary',
  programme_summary: 'Programme summary',
  attendance: 'Attendance',
  assignments: 'Assignments and grades',
  feedback: 'Feedback',
}

export interface ReportParams {
  kind: ReportKind
  programmeId: string
  cohortId: string | null
  from: string | null
  to: string | null
}

type Section = { heading: string; facts: [string, string][] } | { heading: string; columns: string[]; rows: (string | number)[][]; note?: string }

/** A report as data: rendered to CSV or PDF afterwards. */
export interface ReportDocument {
  title: string
  subtitle: string
  organisation: string
  sections: Section[]
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—')
const avg = (v: string | number | null, digits = 0) => (v === null || v === undefined ? '—' : Number(v).toFixed(digits))

/** Builds the report from data already captured, using the same definitions as the dashboard. */
export async function buildReport(sql: Sql, organisationId: string, p: ReportParams): Promise<ReportDocument> {
  const [org] = await sql<{ name: string; time_zone: string }[]>`select name, time_zone from public.organisations where id = ${organisationId}`
  const tz = org!.time_zone
  const [programme] = await sql<{ id: string; name: string }[]>`select id, name from public.programmes where id = ${p.programmeId} and organisation_id = ${organisationId}`
  if (!programme) throw new Error('Programme not found')
  const cohorts = await sql<{ id: string; name: string; starts_on: string; ends_on: string; status: string }[]>`
    select id, name, starts_on::text, ends_on::text, public.status(h) as status from public.cohorts h
    where programme_id = ${programme.id} and organisation_id = ${organisationId} ${p.cohortId ? sql`and id = ${p.cohortId}` : sql``}
    order by starts_on
  `
  if (p.cohortId && !cohorts.length) throw new Error('Cohort not found')
  const ids = cohorts.map((c) => c.id)
  // Inclusive local dates → instants in the organisation's time zone.
  const from = p.from ? sql`(${p.from}::date)::timestamp at time zone ${tz}` : sql`'-infinity'::timestamptz`
  const to = p.to ? sql`(${p.to}::date + 1)::timestamp at time zone ${tz}` : sql`'infinity'::timestamptz`
  const scopeName = p.cohortId ? cohorts[0]!.name : programme.name
  const title = `${kindLabel[p.kind]} — ${scopeName}`
  const subtitle = periodLabel(p.from, p.to)
  const base = { title, subtitle, organisation: org!.name }

  if (p.kind === 'cohort_summary' || p.kind === 'programme_summary') {
    const rows = await sql<{
      id: string
      active: number
      deferred: number
      withdrawn: number
      completed: number
      held: number
      cancelled: number
      present: number
      recorded: number
      published: number
      submissions: number
      expected_submissions: number
      grade_avg: string | null
      feedback: number
      rating: string | null
      flagged: number
      interventions: number
      certificates: number
    }[]>`
      select h.id,
             (select count(*)::int from public.enrolments e where e.cohort_id = h.id and e.status = 'active') as active,
             (select count(*)::int from public.enrolments e where e.cohort_id = h.id and e.status = 'deferred') as deferred,
             (select count(*)::int from public.enrolments e where e.cohort_id = h.id and e.status = 'withdrawn') as withdrawn,
             (select count(*)::int from public.enrolments e where e.cohort_id = h.id and e.status = 'completed') as completed,
             (select count(*)::int from public.sessions s join public.cohort_courses x on x.id = s.cohort_course_id
               where x.cohort_id = h.id and public.status(s) = 'held' and s.starts_at >= ${from} and s.starts_at < ${to}) as held,
             (select count(*)::int from public.sessions s join public.cohort_courses x on x.id = s.cohort_course_id
               where x.cohort_id = h.id and s.cancelled_at is not null and s.starts_at >= ${from} and s.starts_at < ${to}) as cancelled,
             (select count(*)::int from public.attendance_records a join public.sessions s on s.id = a.session_id join public.cohort_courses x on x.id = s.cohort_course_id
               where x.cohort_id = h.id and s.cancelled_at is null and a.status = 'present' and s.starts_at >= ${from} and s.starts_at < ${to}) as present,
             (select count(*)::int from public.attendance_records a join public.sessions s on s.id = a.session_id join public.cohort_courses x on x.id = s.cohort_course_id
               where x.cohort_id = h.id and s.cancelled_at is null and s.starts_at >= ${from} and s.starts_at < ${to}) as recorded,
             (select count(*)::int from public.assignments a join public.cohort_courses x on x.id = a.cohort_course_id
               where x.cohort_id = h.id and a.published_at is not null and a.due_at >= ${from} and a.due_at < ${to} and a.due_at <= now()) as published,
             (select count(*)::int from public.submissions s join public.assignments a on a.id = s.assignment_id join public.cohort_courses x on x.id = a.cohort_course_id
               where x.cohort_id = h.id and a.published_at is not null and a.due_at >= ${from} and a.due_at < ${to} and a.due_at <= now()) as submissions,
             (select count(*)::int * (select count(*)::int from public.enrolments e where e.cohort_id = h.id and e.status in ('active', 'completed'))
               from public.assignments a join public.cohort_courses x on x.id = a.cohort_course_id
               where x.cohort_id = h.id and a.published_at is not null and a.due_at >= ${from} and a.due_at < ${to} and a.due_at <= now()) as expected_submissions,
             (select avg(g.score_pct) from public.grades g join public.submissions s on s.id = g.submission_id join public.assignments a on a.id = s.assignment_id
               join public.cohort_courses x on x.id = a.cohort_course_id where x.cohort_id = h.id and a.due_at >= ${from} and a.due_at < ${to}) as grade_avg,
             (select count(*)::int from public.session_feedback f join public.sessions s on s.id = f.session_id join public.cohort_courses x on x.id = s.cohort_course_id
               where x.cohort_id = h.id and s.starts_at >= ${from} and s.starts_at < ${to}) as feedback,
             (select avg(f.rating) from public.session_feedback f join public.sessions s on s.id = f.session_id join public.cohort_courses x on x.id = s.cohort_course_id
               where x.cohort_id = h.id and s.starts_at >= ${from} and s.starts_at < ${to}) as rating,
             (select count(distinct f.enrolment_id)::int from public.attention_flags f join public.enrolments e on e.id = f.enrolment_id
               where e.cohort_id = h.id and f.cleared_at is null and f.resolved_at is null) as flagged,
             (select count(*)::int from public.interventions i join public.enrolments e on e.id = i.enrolment_id
               where e.cohort_id = h.id and i.contacted_at >= ${from} and i.contacted_at < ${to}) as interventions,
             (select count(*)::int from public.certificates c join public.enrolments e on e.id = c.enrolment_id where e.cohort_id = h.id and c.revoked_at is null) as certificates
      from public.cohorts h where h.id = any(${ids}::uuid[])
    `
    const byId = new Map(rows.map((r) => [r.id, r]))
    if (p.kind === 'cohort_summary') {
      const r = byId.get(cohorts[0]!.id)!
      return {
        ...base,
        sections: [
          {
            heading: 'Enrolment',
            facts: [
              ['Active', String(r.active)],
              ['Completed', String(r.completed)],
              ['Deferred', String(r.deferred)],
              ['Withdrawn', String(r.withdrawn)],
            ],
          },
          {
            heading: 'Delivery and attendance',
            facts: [
              ['Sessions held', String(r.held)],
              ['Sessions cancelled', String(r.cancelled)],
              ['Attendance (present ÷ recorded)', r.recorded ? `${pct(r.present, r.recorded)} · ${r.present} of ${r.recorded}` : 'Nothing recorded'],
            ],
          },
          {
            heading: 'Assignments',
            facts: [
              ['Assignments due', String(r.published)],
              ['Submitted', r.expected_submissions ? `${pct(r.submissions, r.expected_submissions)} · ${r.submissions} of ${r.expected_submissions}` : 'Nothing due yet'],
              ['Average grade', r.grade_avg === null ? '—' : `${avg(r.grade_avg)}%`],
            ],
          },
          {
            heading: 'Feedback and follow-up',
            facts: [
              ['Feedback responses', String(r.feedback)],
              ['Average rating (1–5)', avg(r.rating, 1)],
              ['Needs attention now', String(r.flagged)],
              ['Interventions recorded', String(r.interventions)],
              ['Certificates issued', String(r.certificates)],
            ],
          },
        ],
      }
    }
    return {
      ...base,
      sections: [
        {
          heading: 'By cohort',
          columns: ['Cohort', 'Status', 'Active', 'Completed', 'Held', 'Attendance', 'Submitted', 'Avg grade', 'Rating', 'Flagged'],
          rows: cohorts.map((c) => {
            const r = byId.get(c.id)!
            return [c.name, c.status, r.active, r.completed, r.held, pct(r.present, r.recorded), pct(r.submissions, r.expected_submissions), r.grade_avg === null ? '—' : `${avg(r.grade_avg)}%`, avg(r.rating, 1), r.flagged]
          }),
          note: 'Attendance is present ÷ recorded; excused counts as not present. Submitted is work handed in ÷ work due so far.',
        },
      ],
    }
  }

  if (p.kind === 'attendance') {
    const rows = await sql<{ starts_at: Date; course: string; cohort: string; trainer: string | null; present: number; excused: number; absent: number; expected: number }[]>`
      select s.starts_at, co.name as course, h.name as cohort, m.first_name || ' ' || m.last_name as trainer,
             count(a.id) filter (where a.status = 'present')::int as present,
             count(a.id) filter (where a.status = 'excused')::int as excused,
             count(a.id) filter (where a.status = 'absent')::int as absent,
             (select count(*)::int from public.enrolments e where e.cohort_id = h.id and e.status = 'active') as expected
      from public.sessions s
      join public.cohort_courses x on x.id = s.cohort_course_id join public.courses co on co.id = x.course_id join public.cohorts h on h.id = x.cohort_id
      left join public.organisation_members m on m.id = s.trainer_member_id
      left join public.attendance_records a on a.session_id = s.id
      where h.id = any(${ids}::uuid[]) and s.cancelled_at is null and s.ends_at <= now() and s.starts_at >= ${from} and s.starts_at < ${to}
      group by s.id, co.name, h.id, h.name, m.first_name, m.last_name
      order by s.starts_at
    `
    return {
      ...base,
      sections: [
        {
          heading: 'Sessions',
          columns: ['Date', 'Time', 'Course', ...(p.cohortId ? [] : ['Cohort']), 'Trainer', 'Present', 'Excused', 'Absent', 'Not recorded', 'Attendance'],
          rows: rows.map((r) => {
            const recorded = r.present + r.excused + r.absent
            return [
              localDate(r.starts_at, tz),
              localTime(r.starts_at, tz),
              r.course,
              ...(p.cohortId ? [] : [r.cohort]),
              r.trainer ?? '—',
              r.present,
              r.excused,
              r.absent,
              Math.max(0, r.expected - recorded),
              pct(r.present, recorded),
            ]
          }),
          note: 'Attendance is present ÷ recorded; excused counts as not present. Cancelled sessions are left out.',
        },
      ],
    }
  }

  if (p.kind === 'assignments') {
    const rows = await sql<{ title: string; course: string; cohort: string; due_at: Date; scale: string; expected: number; submitted: number; late: number; graded: number; grade_avg: string | null }[]>`
      select a.title, co.name as course, h.name as cohort, a.due_at, a.grading_scale as scale,
             (select count(*)::int from public.enrolments e where e.cohort_id = h.id and e.status in ('active', 'completed')) as expected,
             (select count(*)::int from public.submissions s where s.assignment_id = a.id) as submitted,
             (select count(*)::int from public.submissions s where s.assignment_id = a.id and s.is_late) as late,
             (select count(*)::int from public.grades g join public.submissions s on s.id = g.submission_id where s.assignment_id = a.id) as graded,
             (select avg(g.score_pct) from public.grades g join public.submissions s on s.id = g.submission_id where s.assignment_id = a.id) as grade_avg
      from public.assignments a
      join public.cohort_courses x on x.id = a.cohort_course_id join public.courses co on co.id = x.course_id join public.cohorts h on h.id = x.cohort_id
      where h.id = any(${ids}::uuid[]) and a.published_at is not null and a.due_at >= ${from} and a.due_at < ${to}
      order by a.due_at
    `
    return {
      ...base,
      sections: [
        {
          heading: 'Assignments',
          columns: ['Assignment', 'Course', ...(p.cohortId ? [] : ['Cohort']), 'Due', 'Scale', 'Submitted', 'Late', 'Graded', 'Average grade'],
          rows: rows.map((r) => [
            r.title,
            r.course,
            ...(p.cohortId ? [] : [r.cohort]),
            localDate(r.due_at, tz),
            r.scale.replace('_', '/'),
            `${r.submitted} of ${r.expected}`,
            r.late,
            r.graded,
            r.grade_avg === null ? '—' : `${avg(r.grade_avg)}%`,
          ]),
          note: 'Average grade converts every scale to a percentage.',
        },
      ],
    }
  }

  // Feedback: by session, then by trainer. Always anonymous.
  const rows = await sql<{ starts_at: Date; course: string; cohort: string; trainer: string | null; responses: number; rating: string | null; attended: number }[]>`
    select s.starts_at, co.name as course, h.name as cohort, m.first_name || ' ' || m.last_name as trainer,
           count(f.id)::int as responses, avg(f.rating) as rating,
           (select count(*)::int from public.attendance_records a where a.session_id = s.id and a.status = 'present') as attended
    from public.sessions s
    join public.cohort_courses x on x.id = s.cohort_course_id join public.courses co on co.id = x.course_id join public.cohorts h on h.id = x.cohort_id
    left join public.organisation_members m on m.id = s.trainer_member_id
    left join public.session_feedback f on f.session_id = s.id
    where h.id = any(${ids}::uuid[]) and s.cancelled_at is null and s.ends_at <= now() and s.starts_at >= ${from} and s.starts_at < ${to}
    group by s.id, co.name, h.name, m.first_name, m.last_name
    order by s.starts_at
  `
  const trainers = new Map<string, { sessions: number; responses: number; total: number }>()
  for (const r of rows) {
    const key = r.trainer ?? 'No trainer'
    const t = trainers.get(key) ?? { sessions: 0, responses: 0, total: 0 }
    t.sessions++
    t.responses += r.responses
    t.total += r.rating === null ? 0 : Number(r.rating) * r.responses
    trainers.set(key, t)
  }
  return {
    ...base,
    sections: [
      {
        heading: 'By session',
        columns: ['Date', 'Course', ...(p.cohortId ? [] : ['Cohort']), 'Trainer', 'Attended', 'Responses', 'Average rating'],
        rows: rows.map((r) => [localDate(r.starts_at, tz), r.course, ...(p.cohortId ? [] : [r.cohort]), r.trainer ?? '—', r.attended, r.responses, avg(r.rating, 1)]),
      },
      {
        heading: 'By trainer',
        columns: ['Trainer', 'Sessions', 'Responses', 'Average rating'],
        rows: [...trainers.entries()].map(([name, t]) => [name, t.sessions, t.responses, t.responses ? (t.total / t.responses).toFixed(1) : '—']),
        note: 'Feedback is anonymous. Ratings are 1 to 5.',
      },
    ],
  }
}

export function periodLabel(from: string | null, to: string | null): string {
  const fmt = (d: string, year: boolean) =>
    new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(year && { year: 'numeric' }), timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`)).replace(',', '')
  if (from && to) return `${fmt(from, from.slice(0, 4) !== to.slice(0, 4))} – ${fmt(to, true)}`
  if (from) return `From ${fmt(from, true)}`
  if (to) return `Up to ${fmt(to, true)}`
  return 'Programme to date'
}

const localDate = (d: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
const localTime = (d: Date, tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d)

export const csvCell = (v: string | number | null | undefined) => {
  // Text starting with = + - @ would run as a formula in Excel; a leading apostrophe keeps it as text.
  const s = v === null || v === undefined ? '' : typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** CSV: one block per section, separated by a blank line. UTF-8 with BOM so Excel reads it correctly. */
export function renderCsv(doc: ReportDocument): Buffer {
  const lines: string[] = [csvCell(doc.title), csvCell(`${doc.organisation} · ${doc.subtitle}`), '']
  for (const s of doc.sections) {
    lines.push(csvCell(s.heading))
    if ('facts' in s) for (const [k, v] of s.facts) lines.push([k, v].map(csvCell).join(','))
    else {
      lines.push(s.columns.map(csvCell).join(','))
      for (const r of s.rows) lines.push(r.map(csvCell).join(','))
    }
    lines.push('')
  }
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines.join('\r\n'), 'utf8')])
}

/** PDF: A4, the report's sections as label/value lists and tables. */
export function renderPdf(doc: ReportDocument, generatedAt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', margin: 48, info: { Title: doc.title, Author: doc.organisation, Creator: 'Synqop' } })
    const chunks: Buffer[] = []
    pdf.on('data', (c: Buffer) => chunks.push(c))
    pdf.on('end', () => resolve(Buffer.concat(chunks)))
    pdf.on('error', reject)
    const width = pdf.page.width - 96
    const ink = '#0f1729'
    const muted = '#64748b'
    const rule = '#e2e8f0'

    pdf.fillColor(muted).font('Helvetica').fontSize(9).text(`${doc.organisation} · Synqop`, { width })
    pdf.moveDown(0.4).fillColor(ink).font('Helvetica-Bold').fontSize(18).text(doc.title, { width })
    pdf.moveDown(0.2).fillColor(muted).font('Helvetica').fontSize(10).text(`${doc.subtitle} · Generated ${generatedAt}`, { width })
    pdf.moveDown(1)

    for (const s of doc.sections) {
      if (pdf.y > pdf.page.height - 140) pdf.addPage()
      pdf.fillColor(ink).font('Helvetica-Bold').fontSize(12).text(s.heading, 48, pdf.y, { width })
      pdf.moveDown(0.4)
      if ('facts' in s) {
        for (const [k, v] of s.facts) {
          const y = pdf.y
          pdf.fillColor(muted).font('Helvetica').fontSize(10).text(k, 48, y, { width: width * 0.55 })
          pdf.fillColor(ink).font('Helvetica-Bold').text(v, 48 + width * 0.55, y, { width: width * 0.45 })
          pdf.moveTo(48, pdf.y + 4).lineTo(48 + width, pdf.y + 4).strokeColor(rule).lineWidth(0.5).stroke()
          pdf.y += 8
        }
      } else {
        const n = s.columns.length
        // First column wider; the rest share the remaining width.
        const first = n > 4 ? width * 0.26 : width * 0.4
        const col = (width - first) / Math.max(1, n - 1)
        const xs = s.columns.map((_, i) => 48 + (i === 0 ? 0 : first + (i - 1) * col))
        const ws = s.columns.map((_, i) => (i === 0 ? first : col) - 6)
        const row = (cells: (string | number)[], header: boolean) => {
          if (pdf.y > pdf.page.height - 72) pdf.addPage()
          const y = pdf.y
          let h = 0
          cells.forEach((c, i) => {
            pdf.font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(header ? muted : ink)
            h = Math.max(h, pdf.heightOfString(String(c), { width: ws[i] }))
          })
          cells.forEach((c, i) => {
            pdf.font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(header ? muted : ink)
            pdf.text(String(c), xs[i]!, y, { width: ws[i] })
          })
          pdf.y = y + h + 4
          pdf.moveTo(48, pdf.y).lineTo(48 + width, pdf.y).strokeColor(rule).lineWidth(0.5).stroke()
          pdf.y += 4
        }
        row(s.columns, true)
        if (s.rows.length === 0) {
          pdf.fillColor(muted).font('Helvetica').fontSize(9).text('Nothing in this period.', 48, pdf.y, { width })
          pdf.moveDown(0.5)
        }
        for (const r of s.rows) row(r, false)
        if (s.note) {
          pdf.moveDown(0.3).fillColor(muted).font('Helvetica').fontSize(8).text(s.note, 48, pdf.y, { width })
        }
      }
      pdf.moveDown(1)
    }
    pdf.end()
  })
}
