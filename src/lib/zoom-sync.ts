import type { Sql } from './db.js'
import type { Mailer } from './mailer.js'
import { deliver } from './notifications.js'
import { withZoom, ZoomError, type TokenBox, type ZoomApi, type ZoomParticipant } from './zoom.js'

/**
 * Zoom work the scheduler does every minute for connected organisations (F1.07, C1.02, C2.04):
 * keep a Zoom meeting for every upcoming online session, register participants for personal links,
 * and import attendance once each meeting has ended. Nothing here runs inside a user's request,
 * so Zoom being slow or down never blocks scheduling.
 */
export interface ZoomSyncDeps {
  sql: Sql
  mailer: Mailer
  appUrl: string
  zoom: ZoomApi
  box: TokenBox
}

/** How far ahead meetings are created, and how long after a meeting attendance is still imported. */
const AHEAD_DAYS = 60
const REGISTER_DAYS = 14
const IMPORT_AFTER_MINUTES = 10
const IMPORT_FOR_DAYS = 3
/** Zoom limits meeting changes per day; keep each run small. */
const PER_RUN = 25

export type ZoomCounts = { created: number; updated: number; deleted: number; registered: number; imported: number; failed: number }

interface SessionRow {
  id: string
  course: string
  cohort: string
  starts_at: Date
  ends_at: Date
  zoom_meeting_id: string | null
}

const errorText = (error: unknown) =>
  error instanceof ZoomError ? `Zoom: ${error.message}` : `Couldn’t reach Zoom (${(error as Error).message ?? 'unknown error'}). Synqop will try again.`

export async function syncZoom(deps: ZoomSyncDeps, organisationId: string, now = new Date()): Promise<ZoomCounts> {
  const counts: ZoomCounts = { created: 0, updated: 0, deleted: 0, registered: 0, imported: 0, failed: 0 }
  const [settings] = await deps.sql<{ time_zone: string; personal: boolean }[]>`
    select o.time_zone, s.join_link_mode = 'personal' as personal from public.organisations o join public.organisation_settings s on s.organisation_id = o.id where o.id = ${organisationId}
  `
  if (!settings) return counts
  const meeting = (s: SessionRow) => ({
    topic: `${s.course} · ${s.cohort}`,
    startTime: s.starts_at,
    durationMinutes: Math.max(15, Math.round((s.ends_at.getTime() - s.starts_at.getTime()) / 60_000)),
    timeZone: settings.time_zone,
    registration: settings.personal,
  })
  const select = (where: ReturnType<Sql>) => deps.sql<SessionRow[]>`
    select s.id, co.name as course, h.name as cohort, s.starts_at, s.ends_at, s.zoom_meeting_id
    from public.sessions s join public.cohort_courses x on x.id = s.cohort_course_id join public.courses co on co.id = x.course_id join public.cohorts h on h.id = x.cohort_id
    where s.organisation_id = ${organisationId} and ${where}
    order by s.starts_at limit ${PER_RUN}
  `

  await withZoom(
    deps,
    organisationId,
    async (token) => {
      // Cancelled, moved in person, or given a pasted link: remove the meeting Synqop made.
      for (const s of await select(deps.sql`s.zoom_sync_needed and s.zoom_meeting_id is not null and (s.cancelled_at is not null or not s.zoom_managed)`)) {
        try {
          await deps.zoom.deleteMeeting(token, s.zoom_meeting_id!)
          await deps.sql`update public.sessions set zoom_meeting_id = null, zoom_managed = false, zoom_sync_needed = false, zoom_sync_error = null where id = ${s.id}`
          await deps.sql`delete from public.session_join_links where session_id = ${s.id}`
          counts.deleted++
        } catch (error) {
          if (error instanceof ZoomError && error.revoked) throw error
          counts.failed++
          await deps.sql`update public.sessions set zoom_sync_error = ${errorText(error)} where id = ${s.id}`
        }
      }

      // Time changed: move the meeting.
      for (const s of await select(deps.sql`s.zoom_sync_needed and s.zoom_managed and s.cancelled_at is null and s.zoom_meeting_id is not null`)) {
        try {
          await deps.zoom.updateMeeting(token, s.zoom_meeting_id!, meeting(s))
          await deps.sql`update public.sessions set zoom_sync_needed = false, zoom_sync_error = null where id = ${s.id}`
          counts.updated++
        } catch (error) {
          if (error instanceof ZoomError && error.revoked) throw error
          counts.failed++
          await deps.sql`update public.sessions set zoom_sync_error = ${errorText(error)} where id = ${s.id}`
        }
      }

      // Upcoming online sessions without a link get a meeting.
      for (const s of await select(deps.sql`
        s.cancelled_at is null and s.mode = 'online' and not s.zoom_managed and s.zoom_meeting_id is null and s.zoom_join_url is null
        and s.starts_at > ${now} and s.starts_at < ${new Date(now.getTime() + AHEAD_DAYS * 86_400_000)}
      `)) {
        try {
          const created = await deps.zoom.createMeeting(token, meeting(s))
          // If someone pasted a link while Zoom was working, theirs wins and the new meeting is removed next run.
          const [kept] = await deps.sql`
            update public.sessions set zoom_meeting_id = ${created.id}, zoom_join_url = ${created.joinUrl}, zoom_managed = true, zoom_sync_needed = false, zoom_sync_error = null
            where id = ${s.id} and zoom_join_url is null and zoom_meeting_id is null returning id
          `
          if (!kept) await deps.zoom.deleteMeeting(token, created.id).catch(() => undefined)
          else counts.created++
        } catch (error) {
          if (error instanceof ZoomError && error.revoked) throw error
          counts.failed++
          await deps.sql`update public.sessions set zoom_sync_error = ${errorText(error)} where id = ${s.id}`
        }
      }

      // Personal links: register everyone in the cohort for meetings in the next two weeks.
      if (settings.personal) {
        const missing = await deps.sql<{ session_id: string; meeting_id: string; member_id: string; email: string; first_name: string; last_name: string }[]>`
          select s.id as session_id, s.zoom_meeting_id as meeting_id, m.id as member_id, m.email, m.first_name, m.last_name
          from public.sessions s join public.cohort_courses x on x.id = s.cohort_course_id
          join public.enrolments e on e.cohort_id = x.cohort_id and e.status = 'active'
          join public.organisation_members m on m.id = e.member_id and m.status <> 'deactivated'
          where s.organisation_id = ${organisationId} and s.zoom_managed and s.zoom_meeting_id is not null and s.cancelled_at is null
            and s.ends_at > ${now} and s.starts_at < ${new Date(now.getTime() + REGISTER_DAYS * 86_400_000)}
            and not exists (select 1 from public.session_join_links l where l.session_id = s.id and l.member_id = m.id)
          order by s.starts_at limit ${PER_RUN * 4}
        `
        for (const r of missing) {
          try {
            const reg = await deps.zoom.addRegistrant(token, r.meeting_id, { email: r.email, firstName: r.first_name, lastName: r.last_name })
            await deps.sql`
              insert into public.session_join_links (organisation_id, session_id, member_id, join_url, zoom_registrant_id)
              values (${organisationId}, ${r.session_id}, ${r.member_id}, ${reg.joinUrl}, ${reg.registrantId})
              on conflict (session_id, member_id) do nothing
            `
            counts.registered++
          } catch (error) {
            if (error instanceof ZoomError && error.revoked) throw error
            // A meeting created without registration can't take registrants; they use the meeting link.
            counts.failed++
            break
          }
        }
      }

      counts.imported += await importAttendance(deps, organisationId, token, now)
      return true
    },
    now,
  )
  return counts
}

/** C2.01 / C2.04: attendance from the Zoom report, once the meeting has ended. */
async function importAttendance(deps: ZoomSyncDeps, organisationId: string, token: string, now: Date) {
  const ended = await deps.sql<
    { id: string; cohort_id: string; course: string; cohort: string; starts_at: Date; ends_at: Date; meeting_id: string; trainers: string[]; present_pct: number; late_on: boolean; late_minutes: number }[]
  >`
    select s.id, x.cohort_id, co.name as course, h.name as cohort, s.starts_at, s.ends_at, s.zoom_meeting_id as meeting_id,
           coalesce(case when s.trainer_member_id is not null then array[s.trainer_member_id] end,
                    (select array_agg(t.member_id) from public.cohort_course_trainers t where t.cohort_course_id = s.cohort_course_id and t.is_lead), '{}') as trainers,
           st.zoom_present_min_pct::int as present_pct, st.zoom_late_enabled as late_on, st.zoom_late_after_minutes as late_minutes
    from public.sessions s join public.cohort_courses x on x.id = s.cohort_course_id join public.courses co on co.id = x.course_id join public.cohorts h on h.id = x.cohort_id
    join public.organisation_settings st on st.organisation_id = s.organisation_id
    where s.organisation_id = ${organisationId} and s.cancelled_at is null and s.zoom_meeting_id is not null and s.attendance_imported_at is null
      and s.ends_at <= ${new Date(now.getTime() - IMPORT_AFTER_MINUTES * 60_000)} and s.ends_at > ${new Date(now.getTime() - IMPORT_FOR_DAYS * 86_400_000)}
    order by s.ends_at limit ${PER_RUN}
  `
  let imported = 0
  for (const s of ended) {
    let rows: ZoomParticipant[] | null
    try {
      rows = await deps.zoom.participants(token, s.meeting_id)
    } catch (error) {
      if (error instanceof ZoomError && error.revoked) throw error
      await deps.sql`update public.sessions set zoom_import_error = ${errorText(error)} where id = ${s.id}`
      continue
    }
    if (rows === null) continue // Not ready yet; next run.
    const unmatched = await applyReport(deps.sql, organisationId, s, rows)
    imported++
    if (unmatched > 0) {
      const link = `/courses/sessions/${s.id}/attendance/zoom`
      const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(s.starts_at).replace(',', '')
      const title = `${unmatched} Zoom ${unmatched === 1 ? 'attendee' : 'attendees'} to review`
      await deliver(deps, { organisationId, to: { roles: ['owner', 'admin'] }, event: 'zoom_review', title, body: `${s.course} · ${day}`, link: `/admin${link}` })
      if (s.trainers.length) await deliver(deps, { organisationId, to: { memberIds: s.trainers }, event: 'zoom_review', title, body: `${s.course} · ${day}`, link: `/trainer/sessions/${s.id}/attendance/zoom` })
    }
  }
  return imported
}

/** Minutes and first join per person, joined up across rejoins. */
export function summarise(rows: ZoomParticipant[]) {
  const people = new Map<string, { name: string; email: string | null; joinedAt: Date; seconds: number }>()
  for (const r of rows) {
    const key = r.email ? `e:${r.email.toLowerCase()}` : `n:${r.name.trim().toLowerCase()}`
    const p = people.get(key)
    if (p) {
      p.seconds += r.durationSeconds
      if (r.joinTime < p.joinedAt) p.joinedAt = r.joinTime
    } else people.set(key, { name: r.name.trim(), email: r.email?.toLowerCase() ?? null, joinedAt: r.joinTime, seconds: r.durationSeconds })
  }
  return [...people.values()]
}

/** Present if in the meeting for at least the organisation's share of the session (F1.07); late after N minutes. */
export function markFor(s: { starts_at: Date; ends_at: Date; present_pct: number; late_on: boolean; late_minutes: number }, joinedAt: Date | null, minutes: number) {
  const length = Math.max(1, Math.round((s.ends_at.getTime() - s.starts_at.getTime()) / 60_000))
  const present = minutes > 0 && minutes >= Math.ceil((length * s.present_pct) / 100)
  const late = present && s.late_on && joinedAt !== null && joinedAt.getTime() > s.starts_at.getTime() + s.late_minutes * 60_000
  return { status: present ? ('present' as const) : ('absent' as const), late }
}

async function applyReport(
  sql: Sql,
  organisationId: string,
  s: { id: string; cohort_id: string; starts_at: Date; ends_at: Date; present_pct: number; late_on: boolean; late_minutes: number },
  rows: ZoomParticipant[],
) {
  const people = summarise(rows)
  return sql.begin(async (tx) => {
    const enrolled = await tx<{ id: string; email: string }[]>`
      select m.id, lower(m.email) as email from public.enrolments e join public.organisation_members m on m.id = e.member_id
      where e.cohort_id = ${s.cohort_id} and e.status = 'active'
    `
    // Trainers and admins are in the meeting too; they aren't attendees to review.
    const staff = new Set(
      (await tx<{ email: string }[]>`select lower(email) as email from public.organisation_members where organisation_id = ${organisationId} and role <> 'participant'`).map((r) => r.email),
    )
    const byEmail = new Map(enrolled.map((m) => [m.email, m.id]))
    const found = new Map<string, { joinedAt: Date; seconds: number }>()
    let unmatched = 0
    for (const p of people) {
      const memberId = p.email ? byEmail.get(p.email) : undefined
      if (memberId) {
        const prev = found.get(memberId)
        found.set(memberId, prev ? { joinedAt: prev.joinedAt < p.joinedAt ? prev.joinedAt : p.joinedAt, seconds: prev.seconds + p.seconds } : { joinedAt: p.joinedAt, seconds: p.seconds })
      } else if (!(p.email && staff.has(p.email))) {
        unmatched++
        await tx`
          insert into public.zoom_unmatched_attendees (organisation_id, session_id, display_name, email, joined_at, minutes_in_meeting)
          values (${organisationId}, ${s.id}, ${p.name.slice(0, 200) || 'Unknown'}, ${p.email}, ${p.joinedAt}, ${Math.round(p.seconds / 60)})
        `
      }
    }
    for (const m of enrolled) {
      const f = found.get(m.id)
      const minutes = f ? Math.round(f.seconds / 60) : 0
      const mark = markFor(s, f?.joinedAt ?? null, minutes)
      // Marks someone already made by hand stay as they are.
      await tx`
        insert into public.attendance_records (organisation_id, session_id, member_id, status, source, joined_at, minutes_in_meeting, is_late)
        values (${organisationId}, ${s.id}, ${m.id}, ${mark.status}, 'zoom', ${f?.joinedAt ?? null}, ${f ? minutes : null}, ${mark.late})
        on conflict (session_id, member_id) do nothing
      `
    }
    await tx`update public.sessions set attendance_imported_at = now(), zoom_import_error = null where id = ${s.id}`
    return unmatched
  })
}
