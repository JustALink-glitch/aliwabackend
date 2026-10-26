import type { AuthAdmin } from './auth-admin.js'
import { refreshFlags } from './attention.js'
import type { Sql } from './db.js'
import type { Mailer } from './mailer.js'
import { deliver } from './notifications.js'
import type { FileStorage } from './storage.js'
import { syncZoom } from './zoom-sync.js'
import type { TokenBox, ZoomApi } from './zoom.js'

/**
 * Scheduled work (X2): reminders, overdue alerts, the admins' daily digest and the 30-day deletion.
 * Runs every minute inside the API (startScheduler) or when an outside cron calls /v1/internal/run-jobs.
 * Every message is claimed in delivery_log first, so it goes out once however often this runs.
 */
export interface SchedulerDeps {
  sql: Sql
  mailer: Mailer
  appUrl: string
  storage: FileStorage
  authAdmin: AuthAdmin
  /** Set when this server has Zoom app credentials (F1.07). */
  zoom?: ZoomApi | null
  zoomBox?: TokenBox | null
}

/** How far back a missed alert is still worth sending, e.g. after the API was off for a while. */
const LOOKBACK_HOURS = 72
const LOOKBACK_DAYS = 14

export type JobCounts = Record<'zoom' | 'sessionReminders' | 'assignmentReminders' | 'reportReminders' | 'reportsOverdue' | 'attendanceMissing' | 'digests' | 'deleted', number>

interface Org {
  id: string
  name: string
  time_zone: string
  session_minutes: number
  assignment_hours: number
  report_hours: number
  report_remind: boolean
  report_remind_hours: number
  attendance_remind: boolean
  attendance_hours: number
  zoom: boolean
  digest: string
}

const fmt = (tz: string) => {
  const day = (d: Date) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz }).format(d).replace(',', '')
  const time = (d: Date) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(d)
  return { day, time, range: (a: Date, b: Date) => `${day(a)}, ${time(a)}–${time(b)}`, at: (d: Date) => `${day(d)}, ${time(d)}` }
}

/** Claims a message; false if it already went out. */
async function claim(sql: Sql, organisationId: string, key: string) {
  const [row] = await sql`insert into public.delivery_log (key, organisation_id) values (${key}, ${organisationId}) on conflict do nothing returning key`
  return Boolean(row)
}

export async function runScheduledJobs(deps: SchedulerDeps, now = new Date()): Promise<JobCounts> {
  const counts: JobCounts = { zoom: 0, sessionReminders: 0, assignmentReminders: 0, reportReminders: 0, reportsOverdue: 0, attendanceMissing: 0, digests: 0, deleted: 0 }
  counts.deleted = await purgeDeletedOrganisations(deps, now)

  // Workspaces scheduled for deletion are read-only: nothing to remind anyone about.
  const orgs = await deps.sql<Org[]>`
    select o.id, o.name, o.time_zone, s.session_reminder_minutes_before as session_minutes, s.assignment_reminder_hours_before as assignment_hours,
           s.report_due_hours as report_hours, s.report_reminder_enabled as report_remind, s.report_reminder_hours_before as report_remind_hours,
           s.in_person_reminder_enabled as attendance_remind, s.in_person_reminder_hours as attendance_hours,
           exists (select 1 from public.zoom_connections z where z.organisation_id = o.id) as zoom,
           to_char(s.digest_local_time, 'HH24:MI') as digest
    from public.organisations o join public.organisation_settings s on s.organisation_id = o.id
    where o.status = 'active'
  `
  for (const org of orgs) {
    try {
      if (org.zoom && deps.zoom && deps.zoomBox) {
        const z = await syncZoom({ ...deps, zoom: deps.zoom, box: deps.zoomBox }, org.id, now)
        counts.zoom += z.created + z.updated + z.deleted + z.registered + z.imported
      }
      counts.sessionReminders += await sessionReminders(deps, org, now)
      counts.assignmentReminders += await assignmentReminders(deps, org, now)
      const reports = await sessionReports(deps, org, now)
      counts.reportReminders += reports.reminders
      counts.reportsOverdue += reports.overdue
      counts.attendanceMissing += await attendanceMissing(deps, org, now)
      counts.digests += await digests(deps, org, now)
    } catch (error) {
      // One organisation's problem shouldn't stop everyone else's reminders.
      console.error(`Scheduled jobs failed for ${org.id}`, error)
    }
  }
  return counts
}

/** X2.01 Session reminder, N minutes before (F1 setting; 60 by default). */
async function sessionReminders(deps: SchedulerDeps, org: Org, now: Date) {
  if (org.session_minutes <= 0) return 0
  const f = fmt(org.time_zone)
  const sessions = await deps.sql<
    { id: string; cohort_id: string; course: string; starts_at: Date; ends_at: Date; mode: string; location: string | null; trainer: string | null; number: number }[]
  >`
    select s.id, x.cohort_id, co.name as course, s.starts_at, s.ends_at, s.mode::text, s.location,
           nullif(trim(coalesce(t.first_name, '') || ' ' || coalesce(t.last_name, '')), '') as trainer,
           (select count(*)::int from public.sessions p where p.cohort_course_id = s.cohort_course_id and p.cancelled_at is null and p.starts_at <= s.starts_at) as number
    from public.sessions s
    join public.cohort_courses x on x.id = s.cohort_course_id
    join public.courses co on co.id = x.course_id
    left join public.organisation_members t on t.id = s.trainer_member_id
    where s.organisation_id = ${org.id} and s.cancelled_at is null
      and s.starts_at > ${now} and s.starts_at <= ${new Date(now.getTime() + org.session_minutes * 60_000)}
  `
  let n = 0
  for (const s of sessions) {
    if (!(await claim(deps.sql, org.id, `session_reminder:${s.id}`))) continue
    const people = await deps.sql<{ id: string }[]>`select member_id as id from public.enrolments where cohort_id = ${s.cohort_id} and status = 'active'`
    const minutes = Math.round((s.starts_at.getTime() - now.getTime()) / 60_000)
    const when = minutes >= 55 ? `${Math.round(minutes / 60)} hour${Math.round(minutes / 60) === 1 ? '' : 's'}` : `${minutes} minutes`
    const where = s.mode === 'online' ? 'Online' : (s.location ?? 'In person')
    n += await deliver(deps, {
      organisationId: org.id,
      to: { memberIds: people.map((p) => p.id) },
      event: 'session_starting',
      title: `${s.course} starts at ${f.time(s.starts_at)}`,
      body: where,
      link: `/participant/sessions/${s.id}`,
      email: {
        subject: `Starts at ${f.time(s.starts_at)} — ${s.course}`,
        title: `Your session starts in ${when}`,
        intro: (first) =>
          `Hi ${first}, session ${s.number} of ${s.course} starts at ${f.time(s.starts_at)}. ${s.mode === 'online' ? 'Join from the session page so your attendance is recorded.' : 'Your trainer will take attendance in the room.'}`,
        details: [
          { label: 'When', value: f.range(s.starts_at, s.ends_at) },
          { label: 'Where', value: where },
          ...(s.trainer ? [{ label: 'Trainer', value: s.trainer }] : []),
        ],
        buttonLabel: 'Open session',
        footer: 'You get this because session reminders are on. Change them in Settings › Notifications.',
      },
    })
  }
  return n
}

/** X2.02 Assignment due, to participants who haven't submitted, N hours before (24 by default). */
async function assignmentReminders(deps: SchedulerDeps, org: Org, now: Date) {
  if (org.assignment_hours <= 0) return 0
  const f = fmt(org.time_zone)
  const due = await deps.sql<{ id: string; title: string; course: string; cohort_id: string; due_at: Date }[]>`
    select a.id, a.title, co.name as course, x.cohort_id, a.due_at
    from public.assignments a join public.cohort_courses x on x.id = a.cohort_course_id join public.courses co on co.id = x.course_id
    where a.organisation_id = ${org.id} and a.published_at is not null
      and a.due_at > ${now} and a.due_at <= ${new Date(now.getTime() + org.assignment_hours * 3_600_000)}
  `
  let n = 0
  for (const a of due) {
    if (!(await claim(deps.sql, org.id, `assignment_due:${a.id}`))) continue
    const people = await deps.sql<{ id: string }[]>`
      select e.member_id as id from public.enrolments e
      where e.cohort_id = ${a.cohort_id} and e.status = 'active'
        and not exists (select 1 from public.submissions s where s.assignment_id = ${a.id} and s.member_id = e.member_id)
    `
    if (!people.length) continue
    const tomorrow = f.day(a.due_at) !== f.day(now)
    n += await deliver(deps, {
      organisationId: org.id,
      to: { memberIds: people.map((p) => p.id) },
      event: 'assignment_due',
      title: `${a.title} is due ${tomorrow ? 'tomorrow' : 'today'} at ${f.time(a.due_at)}`,
      body: a.course,
      link: `/participant/assignments/${a.id}`,
      email: {
        subject: `Due ${tomorrow ? 'tomorrow' : 'today'} — ${a.title}`,
        title: `${a.title} is due ${tomorrow ? 'tomorrow' : 'today'}`,
        intro: (first) => `Hi ${first}, you haven’t submitted ${a.title} yet. It’s due ${tomorrow ? 'tomorrow' : 'today'} at ${f.time(a.due_at)}.`,
        details: [
          { label: 'Course', value: a.course },
          { label: 'Due', value: f.at(a.due_at) },
          { label: 'Status', value: 'Not submitted' },
        ],
        buttonLabel: 'Submit assignment',
        note: 'You can replace your submission until the due time.',
        footer: 'You get this because assignment reminders are on. Change them in Settings › Notifications.',
      },
    })
  }
  return n
}

/** F1.08 reminder before a session report is due, then X2.05 when it's overdue (trainer email, admins in-app). */
async function sessionReports(deps: SchedulerDeps, org: Org, now: Date) {
  const f = fmt(org.time_zone)
  const open = await deps.sql<{ id: string; course: string; cohort: string; starts_at: Date; ends_at: Date; due_at: Date; trainers: string[]; trainer_name: string | null }[]>`
    select s.id, co.name as course, h.name as cohort, s.starts_at, s.ends_at, s.ends_at + make_interval(hours => ${org.report_hours}) as due_at,
           coalesce(case when s.trainer_member_id is not null then array[s.trainer_member_id] end,
                    (select array_agg(t.member_id) from public.cohort_course_trainers t where t.cohort_course_id = s.cohort_course_id and t.is_lead), '{}') as trainers,
           (select m.first_name || ' ' || m.last_name from public.organisation_members m where m.id = s.trainer_member_id) as trainer_name
    from public.sessions s
    join public.cohort_courses x on x.id = s.cohort_course_id join public.courses co on co.id = x.course_id join public.cohorts h on h.id = x.cohort_id
    left join public.session_reports r on r.session_id = s.id
    where s.organisation_id = ${org.id} and s.cancelled_at is null and s.ends_at <= ${now}
      and s.ends_at > ${new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000)} and r.submitted_at is null
  `
  let reminders = 0
  let overdue = 0
  for (const s of open) {
    const link = `/trainer/reports/${s.id}`
    const details = [
      { label: 'Session', value: `${s.course} · ${s.cohort}` },
      { label: 'Held', value: f.range(s.starts_at, s.ends_at) },
      { label: 'Due', value: f.at(s.due_at) },
    ]
    if (s.due_at <= now) {
      if (now.getTime() - s.due_at.getTime() > LOOKBACK_HOURS * 3_600_000) continue
      if (!(await claim(deps.sql, org.id, `report_overdue:${s.id}`))) continue
      overdue += await deliver(deps, {
        organisationId: org.id,
        to: { memberIds: s.trainers },
        event: 'report_overdue',
        title: 'Your session report is overdue',
        body: `${s.course} · ${f.day(s.starts_at)}`,
        link,
        email: {
          subject: `Overdue — session report for ${f.day(s.starts_at)}`,
          title: 'Your session report is overdue',
          intro: (first) => `Hi ${first}, the report for this session was due on ${f.at(s.due_at)}. Admins can see it’s late — a late report still counts.`,
          details,
          buttonLabel: 'Write report',
          footer: 'You get this because report reminders are on.',
        },
      })
      await deliver(deps, {
        organisationId: org.id,
        to: { roles: ['owner', 'admin'] },
        event: 'report_overdue',
        title: 'Session report overdue',
        body: `${s.trainer_name ? `${s.trainer_name} · ` : ''}${s.course}, ${f.day(s.starts_at)}`,
        link: `/admin/courses/reports/${s.id}`,
      })
    } else if (org.report_remind && s.due_at.getTime() - now.getTime() <= org.report_remind_hours * 3_600_000) {
      if (!(await claim(deps.sql, org.id, `report_reminder:${s.id}`))) continue
      reminders += await deliver(deps, {
        organisationId: org.id,
        to: { memberIds: s.trainers },
        event: 'report_due',
        title: `Session report due at ${f.time(s.due_at)}`,
        body: `${s.course} · ${f.day(s.starts_at)}`,
        link,
        email: {
          subject: `Due ${f.at(s.due_at)} — session report for ${f.day(s.starts_at)}`,
          title: 'Your session report is due soon',
          intro: (first) => `Hi ${first}, please send the report for this session by ${f.at(s.due_at)}. It takes a couple of minutes.`,
          details,
          buttonLabel: 'Write report',
          footer: 'You get this because report reminders are on.',
        },
      })
    }
  }
  return { reminders, overdue }
}

/** F1.07 "Remind the trainer" when nobody has taken attendance N hours after a session ends. */
async function attendanceMissing(deps: SchedulerDeps, org: Org, now: Date) {
  if (!org.attendance_remind) return 0
  const f = fmt(org.time_zone)
  const cutoff = new Date(now.getTime() - org.attendance_hours * 3_600_000)
  const sessions = await deps.sql<{ id: string; course: string; cohort: string; starts_at: Date; ends_at: Date; trainers: string[] }[]>`
    select s.id, co.name as course, h.name as cohort, s.starts_at, s.ends_at,
           coalesce(case when s.trainer_member_id is not null then array[s.trainer_member_id] end,
                    (select array_agg(t.member_id) from public.cohort_course_trainers t where t.cohort_course_id = s.cohort_course_id and t.is_lead), '{}') as trainers
    from public.sessions s
    join public.cohort_courses x on x.id = s.cohort_course_id join public.courses co on co.id = x.course_id join public.cohorts h on h.id = x.cohort_id
    where s.organisation_id = ${org.id} and s.cancelled_at is null
      and s.ends_at <= ${cutoff} and s.ends_at > ${new Date(cutoff.getTime() - LOOKBACK_HOURS * 3_600_000)}
      -- With Zoom connected, online attendance arrives by itself; only rooms need a person.
      ${org.zoom ? deps.sql`and s.mode <> 'online'` : deps.sql``}
      and not exists (select 1 from public.attendance_records a where a.session_id = s.id)
      and exists (select 1 from public.enrolments e where e.cohort_id = x.cohort_id and e.status = 'active')
  `
  let n = 0
  for (const s of sessions) {
    if (!(await claim(deps.sql, org.id, `attendance_missing:${s.id}`))) continue
    n += await deliver(deps, {
      organisationId: org.id,
      to: { memberIds: s.trainers },
      event: 'attendance_missing',
      title: 'Attendance not recorded yet',
      body: `${s.course} · ${f.day(s.starts_at)}`,
      link: `/trainer/sessions/${s.id}/attendance`,
      email: {
        subject: `Take attendance — ${s.course}, ${f.day(s.starts_at)}`,
        title: 'Attendance isn’t recorded yet',
        intro: (first) => `Hi ${first}, nobody has taken attendance for this session yet. It only takes a minute on the register.`,
        details: [
          { label: 'Session', value: `${s.course} · ${s.cohort}` },
          { label: 'Held', value: f.range(s.starts_at, s.ends_at) },
        ],
        buttonLabel: 'Take attendance',
        footer: 'You get this because attendance reminders are on in your organisation.',
      },
    })
    await deliver(deps, {
      organisationId: org.id,
      to: { roles: ['owner', 'admin'] },
      event: 'attendance_missing',
      title: 'Attendance not recorded',
      body: `${s.course} · ${s.cohort}, ${f.day(s.starts_at)}`,
      link: `/admin/courses/sessions/${s.id}`,
    })
  }
  return n
}

const flagText: Record<string, (d: Record<string, unknown>) => string> = {
  low_attendance: (d) => `attendance at ${d.attendancePct}%`,
  missed_in_row: (d) => `missed ${d.missed} sessions in a row`,
  overdue_assignments: (d) => `${d.count} overdue assignment${d.count === 1 ? '' : 's'}`,
  inactive: (d) => `no activity for ${d.days} days`,
  low_grade: (d) => `average grade ${d.averagePct}%`,
}

/** X2.06 Daily digest at each admin's digest time (org time zone): new flags and overdue reports. */
async function digests(deps: SchedulerDeps, org: Org, now: Date) {
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: org.time_zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now)
  const get = (t: string) => local.find((p) => p.type === t)?.value ?? '00'
  const today = `${get('year')}-${get('month')}-${get('day')}`
  const clock = `${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}`
  const admins = await deps.sql<{ id: string; time: string }[]>`
    select m.id, coalesce(to_char(m.digest_time, 'HH24:MI'), ${org.digest}) as time from public.organisation_members m
    where m.organisation_id = ${org.id} and m.role in ('owner', 'admin') and m.status = 'active'
  `
  const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))
  // Within three hours of their digest time, so a late start doesn't send this morning's digest at night.
  const due = admins.filter((a) => minutes(clock) >= minutes(a.time) && minutes(clock) - minutes(a.time) < 180)
  if (!due.length) return 0
  let refreshed = false
  let n = 0
  const f = fmt(org.time_zone)
  for (const admin of due) {
    if (!(await claim(deps.sql, org.id, `digest:${admin.id}:${today}`))) continue
    if (!refreshed) {
      await refreshFlags(deps.sql, org.id, now)
      refreshed = true
    }
    const since = new Date(now.getTime() - 86_400_000)
    const [flags, reports] = await Promise.all([
      deps.sql<{ first_name: string; last_name: string; cohort: string; rule: string; details: Record<string, unknown> | null }[]>`
        select m.first_name, m.last_name, h.name as cohort, f.rule::text, f.details
        from public.attention_flags f join public.enrolments e on e.id = f.enrolment_id
        join public.organisation_members m on m.id = e.member_id join public.cohorts h on h.id = e.cohort_id
        where f.organisation_id = ${org.id} and f.cleared_at is null and f.resolved_at is null and f.raised_at > ${since}
        order by f.raised_at desc
      `,
      deps.sql<{ course: string; starts_at: Date; trainer: string | null }[]>`
        select co.name as course, s.starts_at, (select m.first_name || ' ' || m.last_name from public.organisation_members m where m.id = s.trainer_member_id) as trainer
        from public.sessions s join public.cohort_courses x on x.id = s.cohort_course_id join public.courses co on co.id = x.course_id
        left join public.session_reports r on r.session_id = s.id
        where s.organisation_id = ${org.id} and s.cancelled_at is null and r.submitted_at is null
          and s.ends_at + make_interval(hours => ${org.report_hours}) <= ${now} and s.ends_at > ${new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000)}
        order by s.starts_at desc
      `,
    ])
    // Nothing new: no digest today.
    if (!flags.length && !reports.length) continue
    const people = new Set(flags.map((x) => `${x.first_name} ${x.last_name}`)).size
    const details = [
      ...flags.slice(0, 5).map((x, i) => ({
        label: i === 0 ? 'New flags' : '',
        value: `${x.first_name} ${x.last_name} · ${x.cohort} — ${(flagText[x.rule] ?? (() => 'needs follow-up'))(x.details ?? {})}`,
      })),
      ...(flags.length > 5 ? [{ label: '', value: `and ${flags.length - 5} more` }] : []),
      ...reports.slice(0, 5).map((r, i) => ({ label: i === 0 ? 'Reports overdue' : '', value: `${r.course} · ${f.day(r.starts_at)}${r.trainer ? ` (${r.trainer})` : ''}` })),
      ...(reports.length > 5 ? [{ label: '', value: `and ${reports.length - 5} more` }] : []),
    ]
    n += await deliver(deps, {
      organisationId: org.id,
      to: { memberIds: [admin.id] },
      event: 'attention_flags',
      title: flags.length ? `${people} ${people === 1 ? 'participant needs' : 'participants need'} attention` : `${reports.length} session report${reports.length === 1 ? '' : 's'} overdue`,
      body: 'Daily digest',
      link: flags.length ? '/admin/needs-attention' : '/admin/courses/reports',
      email: {
        subject: `Synqop daily digest — ${f.day(now)}`,
        title: 'Your morning digest',
        intro: (first) => `Hi ${first}, here’s what changed since yesterday at ${admin.time}.`,
        details,
        buttonLabel: flags.length ? 'Open Needs attention' : 'Open session reports',
        footer: `Sent at ${admin.time} because the daily digest is on. Change it in Settings › Notifications.`,
      },
    })
  }
  return n
}

/** F1.11: after 30 days, the workspace and everything in it are deleted, files and sign-ins included. */
async function purgeDeletedOrganisations(deps: SchedulerDeps, now: Date) {
  const due = await deps.sql<{ id: string }[]>`
    select id from public.organisations where status = 'pending_deletion' and deletion_scheduled_for <= ${now}
  `
  let n = 0
  for (const org of due) {
    try {
      // Every table with a storage_path column holds this organisation's uploaded files.
      const columns = await deps.sql<{ table_name: string }[]>`
        select c.table_name from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
        where c.table_schema = 'public' and c.column_name = 'storage_path' and t.table_type = 'BASE TABLE'
      `
      const paths: string[] = []
      for (const { table_name } of columns) {
        const rows = await deps.sql<{ path: string }[]>`select storage_path as path from ${deps.sql('public.' + table_name)} where organisation_id = ${org.id} and storage_path is not null`
        paths.push(...rows.map((r) => r.path))
      }
      const users = await deps.sql<{ user_id: string }[]>`select user_id from public.organisation_members where organisation_id = ${org.id} and user_id is not null`
      await deps.sql.begin(async (tx) => {
        await tx`select set_config('synqop.purging', 'on', true)`
        // Delete table by table, children first: a table that's still referenced fails and waits for the next pass.
        const tables = (
          await tx<{ table_name: string }[]>`
            select c.table_name from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
            where c.table_schema = 'public' and c.column_name = 'organisation_id' and t.table_type = 'BASE TABLE'
          `
        ).map((r) => r.table_name)
        let left = tables
        while (left.length) {
          const failed: string[] = []
          for (const table of left) {
            try {
              await tx.savepoint((sp) => sp`delete from ${sp('public.' + table)} where organisation_id = ${org.id}`)
            } catch {
              failed.push(table)
            }
          }
          if (failed.length === left.length) throw new Error(`Couldn’t delete from ${failed.join(', ')}`)
          left = failed
        }
        await tx`delete from public.organisations where id = ${org.id}`
      })
      for (let i = 0; i < paths.length; i += 100) await deps.storage.remove(paths.slice(i, i + 100)).catch((e) => console.error('Removing files failed', e))
      for (const { user_id } of users) await deps.authAdmin.deleteUser(user_id).catch((e) => console.error('Removing sign-in failed', e))
      n++
    } catch (error) {
      console.error(`Deleting organisation ${org.id} failed`, error)
    }
  }
  return n
}

/** Runs the jobs every minute. Overlapping runs are skipped; returns a stop function. */
export function startScheduler(deps: SchedulerDeps, everyMs = 60_000) {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const counts = await runScheduledJobs(deps)
      const sent = Object.entries(counts).filter(([, v]) => v > 0)
      if (sent.length) console.info(`Scheduled jobs: ${sent.map(([k, v]) => `${k} ${v}`).join(', ')}`)
    } catch (error) {
      console.error('Scheduled jobs failed', error)
    } finally {
      running = false
    }
  }
  const first = setTimeout(tick, 5_000)
  const timer = setInterval(tick, everyMs)
  return () => {
    clearTimeout(first)
    clearInterval(timer)
  }
}
