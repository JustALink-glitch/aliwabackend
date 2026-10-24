import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { audit, type Sql, type Tx } from '../lib/db.js'
import { AppError, notFound } from '../lib/errors.js'
import { shortName } from '../lib/names.js'
import { optionalText, parseBody, uuid } from '../lib/validation.js'
import type { AuthVariables } from '../middleware/auth.js'

const Status = z.enum(['present', 'absent', 'excused'])

const SaveRegister = z.object({
  marks: z
    .array(z.object({ memberId: uuid, status: Status, note: optionalText(300) }))
    .min(1, 'Mark at least one person.')
    .max(1000),
})

const EditMark = z.object({
  status: Status,
  reason: z.string().trim().min(1, 'Add a reason. It’s saved to the attendance log.').max(500),
  note: optionalText(300),
})

interface SessionInfo {
  id: string
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
 * Owners and admins; trainers get the same rules on their own sessions with T4.
 */
export function attendanceRoutes(deps: AppDeps) {
  async function findSession(sql: Sql | Tx, organisationId: string, id: string): Promise<SessionInfo> {
    if (!uuid.safeParse(id).success) throw notFound('Session not found.')
    const [row] = await sql<SessionInfo[]>`
      select s.id, s.organisation_id, x.cohort_id, public.status(s) as status, s.starts_at
      from public.sessions s join public.cohort_courses x on x.id = s.cohort_course_id
      where s.id = ${id} and s.organisation_id = ${organisationId}
    `
    if (!row) throw notFound('Session not found.')
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
    // Mounted inside sessionRoutes, which already requires an owner or admin.
    new Hono<{ Variables: AuthVariables }>()

      .get('/:id/attendance', async (c) => {
        const session = await findSession(deps.sql, c.var.auth.organisationId, c.req.param('id'))
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
        return c.json({
          status: session.status,
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

      // C2.03 Save register: marks people who aren't marked yet. Changing a mark goes through C2.02 with a reason.
      .put('/:id/attendance', async (c) => {
        const body = await parseBody(c, SaveRegister)
        const { organisationId, memberId: actorId } = c.var.auth
        const session = await findSession(deps.sql, organisationId, c.req.param('id'))
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
        const session = await findSession(deps.sql, organisationId, c.req.param('id'))
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
        const session = await findSession(deps.sql, c.var.auth.organisationId, c.req.param('id'))
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
