import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { audit, type Sql, type Tx } from '../lib/db.js'
import type { AuthContext } from '../lib/auth.js'
import { AppError, forbidden, notFound } from '../lib/errors.js'
import { shortName } from '../lib/names.js'
import { can, staffScope } from '../lib/staff.js'
import { markFor } from '../lib/zoom-sync.js'
import { optionalText, parseBody, uuid } from '../lib/validation.js'
import type { AuthVariables } from '../middleware/auth.js'

const Status = z.enum(['present', 'absent', 'excused'])

const SaveRegister = z.object({
  marks: z
    .array(z.object({ memberId: uuid, status: Status, note: optionalText(300) }))
    .min(1, 'Mark at least one person.')
    .max(1000),
})

const ZoomMatches = z.object({
  matches: z.array(z.object({ id: uuid, memberId: uuid })).max(500).default([]),
  ignore: z.array(uuid).max(500).default([]),
})

const EditMark = z.object({
  status: Status,
  reason: z.string().trim().min(1, 'Add a reason. It’s saved to the attendance log.').max(500),
  note: optionalText(300),
})

interface SessionInfo {
  id: string
  cohort_course_id: string
  organisation_id: string
  cohort_id: string
  status: string
  starts_at: Date
}

interface RegisterRow {
  member_id: string
  first_name: string
  last_name: string
  email: string
  enrolment_status: string | null
  record_id: string | null
  status: 'present' | 'absent' | 'excused' | null
  source: 'zoom' | 'manual' | 'edited' | null
  joined_at: Date | null
  minutes_in_meeting: number | null
  is_late: boolean | null
  note: string | null
  updated_at: Date | null
}

/**
 * /v1/sessions/:id/attendance — C2.01 register, C2.02 edit, C2.03 marking, C2.05 history.
 * Owners and admins everywhere; trainers on their own courses (T4); assistants if F1.04 allows.
 */
export function attendanceRoutes(deps: AppDeps) {
  /** The session, if this person can see it; with `write`, only if they can take its attendance. */
  async function findSession(sql: Sql | Tx, auth: AuthContext, id: string, write = false): Promise<SessionInfo> {
    if (!uuid.safeParse(id).success) throw notFound('Session not found.')
    const [row] = await sql<SessionInfo[]>`
      select s.id, s.cohort_course_id, s.organisation_id, x.cohort_id, public.status(s) as status, s.starts_at
      from public.sessions s join public.cohort_courses x on x.id = s.cohort_course_id
      where s.id = ${id} and s.organisation_id = ${auth.organisationId}
    `
    if (!row) throw notFound('Session not found.')
    const allowed = can(await staffScope(sql, auth), row.cohort_course_id)
    if (!allowed.see) throw notFound('Session not found.')
    if (write && !allowed.attendance) throw forbidden('Your organisation doesn’t let assistant trainers take attendance.')
    return row
  }

  function requireOpen(session: SessionInfo) {
    if (session.status === 'cancelled') throw new AppError(409, 'session_cancelled', 'This session was cancelled, so it has no attendance.')
    if (session.status === 'scheduled') throw new AppError(409, 'session_not_started', 'Attendance opens when the session starts.')
  }

  /** Everyone expected (active in the cohort) plus anyone already marked, e.g. since withdrawn. */
  function selectRegister(sql: Sql | Tx, session: SessionInfo) {
    return sql<RegisterRow[]>`
      select m.id as member_id, m.first_name, m.last_name, m.email, e.status as enrolment_status,
             a.id as record_id, a.status, a.source, a.joined_at, a.minutes_in_meeting, a.is_late, a.note, a.updated_at
      from public.organisation_members m
      left join public.enrolments e on e.member_id = m.id and e.cohort_id = ${session.cohort_id}
      left join public.attendance_records a on a.member_id = m.id and a.session_id = ${session.id}
      where m.organisation_id = ${session.organisation_id}
        and (e.status = 'active' or a.id is not null)
      order by m.first_name, m.last_name
    `
  }

  return (
    // Mounted inside sessionRoutes, which already requires staff; each route checks the session's course.
    new Hono<{ Variables: AuthVariables }>()

      .get('/:id/attendance', async (c) => {
        const session = await findSession(deps.sql, c.var.auth, c.req.param('id'))
        const [rows, [changes]] = await Promise.all([
          selectRegister(deps.sql, session),
          deps.sql<{ count: number; last_by_first: string | null; last_by_last: string | null }[]>`
            select count(*)::int as count,
                   (array_agg(m.first_name order by ch.created_at desc))[1] as last_by_first,
                   (array_agg(m.last_name order by ch.created_at desc))[1] as last_by_last
            from public.attendance_changes ch
            join public.attendance_records a on a.id = ch.attendance_record_id
            left join public.organisation_members m on m.id = ch.changed_by
            where a.session_id = ${session.id}
          `,
        ])
        const [firstSave] = await deps.sql<{ created_at: Date; first_name: string | null; last_name: string | null }[]>`
          select e.created_at, m.first_name, m.last_name from public.audit_events e
          left join public.organisation_members m on m.id = e.actor_member_id
          where e.entity_type = 'session' and e.entity_id = ${session.id} and e.action = 'attendance.register_saved'
          order by e.created_at limit 1
        `
        const counts = { present: 0, absent: 0, excused: 0, notRecorded: 0 }
        for (const r of rows) {
          if (r.status) counts[r.status]++
          else counts.notRecorded++
        }
        const recorded = counts.present + counts.absent + counts.excused
        const [zoom] = await deps.sql<{ meeting: boolean; imported_at: Date | null; unmatched: number; problem: string | null }[]>`
          select s.zoom_meeting_id is not null as meeting, s.attendance_imported_at as imported_at, s.zoom_import_error as problem,
                 (select count(*)::int from public.zoom_unmatched_attendees u where u.session_id = s.id and u.resolved_at is null and not u.dismissed) as unmatched
          from public.sessions s where s.id = ${session.id}
        `
        return c.json({
          status: session.status,
          // C2.01: Zoom imports the register once the meeting ends; C2.04 for names it couldn't match.
          zoom: { meeting: zoom!.meeting, importedAt: zoom!.imported_at, unmatched: zoom!.unmatched, problem: zoom!.problem },
          counts,
          expected: rows.filter((r) => r.enrolment_status === 'active').length,
          rate: recorded ? Math.round((counts.present / recorded) * 100) : null,
          firstSaved: firstSave ? { at: firstSave.created_at, by: shortName(firstSave.first_name, firstSave.last_name) } : null,
          changes: { count: changes?.count ?? 0, lastBy: shortName(changes?.last_by_first, changes?.last_by_last) },
          register: rows.map((r) => ({
            memberId: r.member_id,
            name: `${r.first_name} ${r.last_name}`.trim(),
            email: r.email,
            stillEnrolled: r.enrolment_status === 'active',
            status: r.status,
            source: r.source,
            joinedAt: r.joined_at,
            minutesInMeeting: r.minutes_in_meeting,
            late: Boolean(r.is_late),
            note: r.note,
          })),
        })
      })

      // C2.04 / T4.04 Zoom attendees Synqop couldn't match by email, with a suggestion for each.
      .get('/:id/attendance/zoom', async (c) => {
        const session = await findSession(deps.sql, c.var.auth, c.req.param('id'))
        const [attendees, register] = await Promise.all([
          deps.sql<{ id: string; display_name: string; email: string | null; joined_at: Date | null; minutes_in_meeting: number | null }[]>`
            select id, display_name, email, joined_at, minutes_in_meeting from public.zoom_unmatched_attendees
            where session_id = ${session.id} and resolved_at is null and not dismissed order by display_name
          `,
          selectRegister(deps.sql, session),
        ])
        const people = register.filter((r) => r.enrolment_status === 'active')
        // Suggest someone not yet counted as present whose name shares a word with the Zoom name.
        const words = (v: string) => v.toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length > 1)
        const suggest = (name: string, email: string | null) => {
          const zoomWords = new Set([...words(name), ...(email ? words(email.split('@')[0]!) : [])])
          const scored = people
            .filter((p) => p.status !== 'present')
            .map((p) => ({ p, score: words(`${p.first_name} ${p.last_name}`).filter((w) => zoomWords.has(w) || [...zoomWords].some((z) => z.length > 2 && w.startsWith(z))).length }))
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score)
          return scored.length && (scored.length === 1 || scored[0]!.score > scored[1]!.score) ? scored[0]!.p.member_id : null
        }
        return c.json({
          attendees: attendees.map((a) => ({
            id: a.id,
            name: a.display_name,
            email: a.email,
            joinedAt: a.joined_at,
            minutes: a.minutes_in_meeting ?? 0,
            suggestedMemberId: suggest(a.display_name, a.email),
          })),
          participants: people.map((p) => ({ memberId: p.member_id, name: `${p.first_name} ${p.last_name}`.trim(), status: p.status, source: p.source })),
        })
      })

      // Matched names count with the Zoom rules; ignored names aren't counted. Hand-made marks are kept.
      .post('/:id/attendance/zoom', async (c) => {
        const body = await parseBody(c, ZoomMatches)
        const { organisationId, memberId: actorId } = c.var.auth
        const session = await findSession(deps.sql, c.var.auth, c.req.param('id'), true)
        const result = await deps.sql.begin(async (tx) => {
          const [s] = await tx<{ starts_at: Date; ends_at: Date; present_pct: number; late_on: boolean; late_minutes: number }[]>`
            select s.starts_at, s.ends_at, st.zoom_present_min_pct::int as present_pct, st.zoom_late_enabled as late_on, st.zoom_late_after_minutes as late_minutes
            from public.sessions s join public.organisation_settings st on st.organisation_id = s.organisation_id where s.id = ${session.id}
          `
          const enrolled = new Set(
            (await tx<{ id: string }[]>`select member_id as id from public.enrolments where cohort_id = ${session.cohort_id} and status = 'active'`).map((r) => r.id),
          )
          let matched = 0
          let kept = 0
          for (const m of body.matches) {
            if (!enrolled.has(m.memberId)) throw new AppError(400, 'bad_request', 'Some fields need attention.', [{ field: 'matches', message: 'Choose someone in this cohort.' }])
            const [a] = await tx<{ joined_at: Date | null; minutes_in_meeting: number | null }[]>`
              update public.zoom_unmatched_attendees set matched_member_id = ${m.memberId}, resolved_by = ${actorId}, resolved_at = now()
              where id = ${m.id} and session_id = ${session.id} and resolved_at is null returning joined_at, minutes_in_meeting
            `
            if (!a) continue
            matched++
            // Two Zoom names can be the same person (phone and laptop): add their minutes together.
            const [prev] = await tx<{ minutes_in_meeting: number | null; joined_at: Date | null; source: string }[]>`
              select minutes_in_meeting, joined_at, source from public.attendance_records where session_id = ${session.id} and member_id = ${m.memberId}
            `
            if (prev && prev.source !== 'zoom') {
              kept++
              continue
            }
            const minutes = (prev?.minutes_in_meeting ?? 0) + (a.minutes_in_meeting ?? 0)
            const joinedAt = [prev?.joined_at, a.joined_at].filter((d): d is Date => Boolean(d)).sort((x, y) => x.getTime() - y.getTime())[0] ?? null
            const mark = markFor(s!, joinedAt, minutes)
            await tx`
              insert into public.attendance_records (organisation_id, session_id, member_id, status, source, joined_at, minutes_in_meeting, is_late, recorded_by)
              values (${organisationId}, ${session.id}, ${m.memberId}, ${mark.status}, 'zoom', ${joinedAt}, ${minutes}, ${mark.late}, ${actorId})
              on conflict (session_id, member_id) do update set status = excluded.status, joined_at = excluded.joined_at,
                minutes_in_meeting = excluded.minutes_in_meeting, is_late = excluded.is_late, recorded_by = excluded.recorded_by, updated_at = now()
            `
          }
          const ignored = body.ignore.length
            ? (
                await tx`
                  update public.zoom_unmatched_attendees set dismissed = true, resolved_by = ${actorId}, resolved_at = now()
                  where session_id = ${session.id} and id = any(${body.ignore}::uuid[]) and resolved_at is null returning id
                `
              ).length
            : 0
          await audit(tx, { organisationId, actorMemberId: actorId, action: 'attendance.zoom_matched', entityType: 'session', entityId: session.id, data: { matched, ignored, kept }, requestId: c.var.requestId })
          return { matched, ignored, kept }
        })
        return c.json(result)
      })

      // C2.03 Save register: marks people who aren't marked yet. Changing a mark goes through C2.02 with a reason.
      .put('/:id/attendance', async (c) => {
        const body = await parseBody(c, SaveRegister)
        const { organisationId, memberId: actorId } = c.var.auth
        const session = await findSession(deps.sql, c.var.auth, c.req.param('id'), true)
        requireOpen(session)
        const saved = await deps.sql.begin(async (tx) => {
          const register = await selectRegister(tx, session)
          const byId = new Map(register.map((r) => [r.member_id, r]))
          const conflicts: string[] = []
          let created = 0
          for (const mark of body.marks) {
            const row = byId.get(mark.memberId)
            if (!row || (!row.record_id && row.enrolment_status !== 'active')) {
              throw new AppError(400, 'bad_request', 'Someone in the register isn’t in this cohort.')
            }
            if (row.record_id) {
              if (row.status !== mark.status) conflicts.push(`${row.first_name} ${row.last_name}`)
              continue
            }
            await tx`
              insert into public.attendance_records (organisation_id, session_id, member_id, status, source, note, recorded_by)
              values (${organisationId}, ${session.id}, ${mark.memberId}, ${mark.status}, 'manual', ${mark.note}, ${actorId})
            `
            created++
          }
          if (conflicts.length) {
            throw new AppError(409, 'already_recorded', `${conflicts.join(', ')} ${conflicts.length === 1 ? 'was' : 'were'} already marked. Use Edit to change a mark, with a reason.`, { names: conflicts })
          }
          if (created) {
            const summary = Object.fromEntries(
              (['present', 'absent', 'excused'] as const).map((s) => [s, body.marks.filter((m) => m.status === s && !byId.get(m.memberId)?.record_id).length]),
            )
            await audit(tx, {
              organisationId,
              actorMemberId: actorId,
              action: 'attendance.register_saved',
              entityType: 'session',
              entityId: session.id,
              data: { marked: created, ...summary },
              requestId: c.var.requestId,
            })
          }
          return created
        })
        return c.json({ marked: saved })
      })

      // C2.02 Edit one person's attendance. A reason is always required and logged.
      .patch('/:id/attendance/:memberId', async (c) => {
        const body = await parseBody(c, EditMark)
        const { organisationId, memberId: actorId } = c.var.auth
        const session = await findSession(deps.sql, c.var.auth, c.req.param('id'), true)
        requireOpen(session)
        const memberId = c.req.param('memberId')
        if (!uuid.safeParse(memberId).success) throw notFound('Participant not found.')
        await deps.sql.begin(async (tx) => {
          const register = await selectRegister(tx, session)
          const row = register.find((r) => r.member_id === memberId)
          if (!row) throw notFound('This person isn’t in this session’s register.')
          if (row.status === body.status && (body.note ?? null) === (row.note ?? null)) return
          let recordId = row.record_id
          if (recordId) {
            await tx`
              update public.attendance_records
              set status = ${body.status}, source = 'edited', note = ${body.note ?? row.note}, recorded_by = ${actorId}, updated_at = now()
              where id = ${recordId}
            `
          } else {
            const [created] = await tx<{ id: string }[]>`
              insert into public.attendance_records (organisation_id, session_id, member_id, status, source, note, recorded_by)
              values (${organisationId}, ${session.id}, ${memberId}, ${body.status}, 'manual', ${body.note}, ${actorId})
              returning id
            `
            recordId = created!.id
          }
          await tx`
            insert into public.attendance_changes (organisation_id, attendance_record_id, changed_by, from_status, to_status, reason)
            values (${organisationId}, ${recordId}, ${actorId}, ${row.status}, ${body.status}, ${body.reason})
          `
        })
        return c.json({ ok: true })
      })

      // C2.05 Attendance history: register saves and every change, newest first.
      .get('/:id/attendance/history', async (c) => {
        const session = await findSession(deps.sql, c.var.auth, c.req.param('id'))
        const [changes, saves] = await Promise.all([
          deps.sql<{ at: Date; first_name: string; last_name: string; from_status: string | null; to_status: string; reason: string; by_first: string | null; by_last: string | null }[]>`
            select ch.created_at as at, p.first_name, p.last_name, ch.from_status, ch.to_status, ch.reason,
                   b.first_name as by_first, b.last_name as by_last
            from public.attendance_changes ch
            join public.attendance_records a on a.id = ch.attendance_record_id
            join public.organisation_members p on p.id = a.member_id
            left join public.organisation_members b on b.id = ch.changed_by
            where a.session_id = ${session.id}
          `,
          deps.sql<{ at: Date; data: { marked: number; present: number; absent: number; excused: number }; by_first: string | null; by_last: string | null }[]>`
            select e.created_at as at, e.data, m.first_name as by_first, m.last_name as by_last
            from public.audit_events e left join public.organisation_members m on m.id = e.actor_member_id
            where e.entity_type = 'session' and e.entity_id = ${session.id} and e.action = 'attendance.register_saved'
          `,
        ])
        const entries = [
          ...changes.map((ch) => ({
            kind: 'change' as const,
            at: ch.at,
            participant: `${ch.first_name} ${ch.last_name}`.trim(),
            from: ch.from_status,
            to: ch.to_status,
            by: ch.by_first ? `${ch.by_first} ${ch.by_last}` : null,
            reason: ch.reason,
          })),
          ...saves.map((s) => ({
            kind: 'register' as const,
            at: s.at,
            marked: s.data.marked,
            present: s.data.present,
            absent: s.data.absent,
            excused: s.data.excused,
            by: s.by_first ? `${s.by_first} ${s.by_last}` : null,
          })),
        ].sort((a, b) => b.at.getTime() - a.at.getTime())
        return c.json({ entries })
      })
  )
}
