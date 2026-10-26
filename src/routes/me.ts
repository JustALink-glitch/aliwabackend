import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { audit } from '../lib/db.js'
import { AppError } from '../lib/errors.js'
import { EVENTS } from '../lib/notifications.js'
import { fullName, parseBody } from '../lib/validation.js'
import { requireAuth, type AuthVariables } from '../middleware/auth.js'

const Profile = z.object({
  fullName,
  // G1.04: how the name appears in the top bar and history. Empty = "First L.".
  displayName: z
    .string()
    .trim()
    .max(80, 'Use 80 characters or fewer.')
    .nullish()
    .transform((value) => (value === undefined ? undefined : value || null)),
  phone: z
    .string()
    .trim()
    .max(40)
    .nullish()
    .transform((value) => (value ? value : null))
    .refine((value) => value === null || /^\+?[\d\s()-]{7,}$/.test(value), 'Enter a phone number, e.g. +234 806 555 0121.'),
  // T9.01 Short bio, shown to participants on sessions. Left out = unchanged.
  bio: z
    .string()
    .trim()
    .max(300, 'Keep it to 300 characters or fewer.')
    .nullish()
    .transform((value) => (value === undefined ? undefined : value || null)),
})

/** Profile photos: JPG, PNG or WebP up to 2 MB. */
const PHOTO_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
const MAX_PHOTO_BYTES = 2 * 1024 * 1024
const fieldError = (field: string, message: string) => new AppError(400, 'bad_request', 'Some fields need attention.', [{ field, message }])
const PhotoUpload = z.object({ type: z.string() })
const Photo = z.object({ path: z.string().min(1).max(400) })

const Preferences = z.object({
  preferences: z.array(z.object({ event: z.string(), email: z.boolean(), inApp: z.boolean() })).max(20),
  /** F1.09 Digest time, "08:00", in the organisation's time zone. Only for roles with a daily digest. */
  digestTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Choose a time.')
    .optional(),
})

/** /v1/me — who is signed in, their organisation and role; their profile and notification settings. */
export function meRoutes(deps: AppDeps) {
  return new Hono<{ Variables: AuthVariables }>()
    .use(requireAuth(deps))
    .get('/', async (c) => {
      const { userId, email, organisationId, role, memberId } = c.var.auth
      const [organisation] = await deps.sql<{ name: string; time_zone: string; deletion_scheduled_for: Date | null }[]>`
        select name, time_zone, deletion_scheduled_for from public.organisations where id = ${organisationId}
      `
      // Name shown in the top bar and account menu (G1.03).
      const [member] = await deps.sql<
        { first_name: string; last_name: string; phone: string | null; display_name: string | null; bio: string | null; photo_path: string | null; last_sign_in_at: Date | null }[]
      >`
        select m.first_name, m.last_name, m.phone, m.display_name, m.bio, m.photo_path, u.last_sign_in_at
        from public.organisation_members m left join auth.users u on u.id = m.user_id where m.id = ${memberId}
      `
      const photoUrl = member?.photo_path ? await deps.storage.viewUrl(member.photo_path, 3600).catch(() => null) : null
      return c.json({
        user: { id: userId, email },
        membership: { id: memberId, organisationId, role, firstName: member?.first_name ?? '', lastName: member?.last_name ?? '', phone: member?.phone ?? null,
          displayName: member?.display_name ?? null,
          bio: member?.bio ?? null,
          photoUrl,
          lastSignInAt: member?.last_sign_in_at ?? null,
        },
        organisation: organisation
          ? { id: organisationId, name: organisation.name, timeZone: organisation.time_zone, deletionScheduledFor: organisation.deletion_scheduled_for }
          : null,
      })
    })

    // P8.01 Profile: display name and phone. Email is the sign-in and can't be changed here.
    .patch('/', async (c) => {
      const body = await parseBody(c, Profile)
      const { organisationId, memberId } = c.var.auth
      await deps.sql.begin(async (tx) => {
        await tx`
          update public.organisation_members
          set first_name = ${body.fullName.firstName}, last_name = ${body.fullName.lastName}, phone = ${body.phone},
              ${body.displayName !== undefined ? tx`display_name = ${body.displayName},` : tx``}
              ${body.bio !== undefined ? tx`bio = ${body.bio},` : tx``} updated_at = now()
          where id = ${memberId}
        `
        await audit(tx, {
          organisationId,
          actorMemberId: memberId,
          action: 'member.profile_updated',
          entityType: 'member',
          entityId: memberId,
          data: {},
          requestId: c.var.requestId,
        })
      })
      return c.json({ ok: true })
    })

    // T9.01 / T1.03 / P1.02 Profile photo: upload straight to storage, then save the path.
    .post('/photo/upload', async (c) => {
      const body = await parseBody(c, PhotoUpload)
      const ext = PHOTO_TYPES[body.type]
      if (!ext) throw fieldError('photo', 'Use a JPG, PNG or WebP image.')
      const { organisationId, memberId } = c.var.auth
      return c.json({ upload: await deps.storage.createUpload(`${organisationId}/photos/${memberId}/${randomUUID()}.${ext}`) })
    })
    .put('/photo', async (c) => {
      const body = await parseBody(c, Photo)
      const { organisationId, memberId } = c.var.auth
      if (!body.path.startsWith(`${organisationId}/photos/${memberId}/`) || body.path.includes('..')) throw fieldError('photo', 'Choose the photo again.')
      const stat = await deps.storage.stat(body.path)
      if (!stat) throw fieldError('photo', 'The photo didn’t finish uploading. Choose it again.')
      if (stat.size > MAX_PHOTO_BYTES) throw fieldError('photo', 'Photos can be up to 2 MB.')
      if (stat.type && !PHOTO_TYPES[stat.type]) throw fieldError('photo', 'Use a JPG, PNG or WebP image.')
      const [old] = await deps.sql<{ photo_path: string | null }[]>`select photo_path from public.organisation_members where id = ${memberId}`
      await deps.sql`update public.organisation_members set photo_path = ${body.path}, updated_at = now() where id = ${memberId}`
      if (old?.photo_path && old.photo_path !== body.path) await deps.storage.remove([old.photo_path]).catch(() => undefined)
      return c.json({ photoUrl: await deps.storage.viewUrl(body.path, 3600) })
    })
    .delete('/photo', async (c) => {
      const { memberId } = c.var.auth
      const [old] = await deps.sql<{ photo_path: string | null }[]>`
        update public.organisation_members m set photo_path = null, updated_at = now() from (select photo_path from public.organisation_members where id = ${memberId}) o
        where m.id = ${memberId} returning o.photo_path
      `
      if (old?.photo_path) await deps.storage.remove([old.photo_path]).catch(() => undefined)
      return c.body(null, 204)
    })

    // T1.04 / P1.03 "You're all set": what this person teaches or studies, after accepting an invitation.
    .get('/welcome', async (c) => {
      const { organisationId, memberId, role } = c.var.auth
      const [org] = await deps.sql<{ name: string; time_zone: string; zoom: boolean; assistants: boolean; attendance: boolean; resources: boolean; grade: boolean; assignments: boolean; reports: boolean }[]>`
        select o.name, o.time_zone, exists (select 1 from public.zoom_connections z where z.organisation_id = o.id) as zoom,
               s.assistants_enabled as assistants, s.assistant_can_take_attendance as attendance, s.assistant_can_add_resources as resources,
               s.assistant_can_grade as grade, s.assistant_can_create_assignments as assignments, s.assistant_can_write_reports as reports
        from public.organisations o join public.organisation_settings s on s.organisation_id = o.id where o.id = ${organisationId}
      `
      if (!org) throw new AppError(404, 'not_found', 'Organisation not found.')
      const base = { organisationName: org.name, timeZone: org.time_zone, zoom: org.zoom }
      if (role === 'trainer' || role === 'assistant_trainer') {
        const teaching = await deps.sql<{ course: string; cohort: string; lead: boolean; lead_name: string | null; next_at: Date | null; mode: string | null; location: string | null }[]>`
          select co.name as course, h.name as cohort, t.is_lead as lead,
                 (select m.first_name || ' ' || m.last_name from public.cohort_course_trainers l join public.organisation_members m on m.id = l.member_id
                  where l.cohort_course_id = x.id and l.is_lead and l.member_id <> ${memberId} and m.status <> 'deactivated' limit 1) as lead_name,
                 n.starts_at as next_at, n.mode, n.location
          from public.cohort_course_trainers t
          join public.cohort_courses x on x.id = t.cohort_course_id join public.courses co on co.id = x.course_id join public.cohorts h on h.id = x.cohort_id
          left join lateral (select s.starts_at, s.mode::text, s.location from public.sessions s where s.cohort_course_id = x.id and s.cancelled_at is null and s.ends_at > now() order by s.starts_at limit 1) n on true
          where t.member_id = ${memberId} and h.archived_at is null and public.status(h) in ('active', 'upcoming', 'draft')
          order by n.starts_at nulls last, co.name
        `
        return c.json({
          ...base,
          kind: 'trainer' as const,
          teaching: teaching.map((t) => ({ course: t.course, cohort: t.cohort, lead: t.lead, leadName: t.lead_name, nextAt: t.next_at, mode: t.mode, location: t.location })),
          assistantCan: { attendance: org.attendance, resources: org.resources, grade: org.grade, assignments: org.assignments, reports: org.reports },
        })
      }
      if (role === 'participant') {
        const [cohort] = await deps.sql<{ id: string; name: string; programme: string; first_at: Date | null }[]>`
          select h.id, h.name, p.name as programme,
                 (select min(s.starts_at) from public.sessions s join public.cohort_courses x on x.id = s.cohort_course_id
                  where x.cohort_id = h.id and s.cancelled_at is null and s.ends_at > now()) as first_at
          from public.enrolments e join public.cohorts h on h.id = e.cohort_id join public.programmes p on p.id = h.programme_id
          where e.member_id = ${memberId} and e.status = 'active' order by h.starts_on desc limit 1
        `
        const courses = cohort
          ? await deps.sql<{ course: string; trainer: string | null; first_at: Date | null; mode: string | null; location: string | null }[]>`
              select co.name as course,
                     (select m.first_name || ' ' || m.last_name from public.cohort_course_trainers l join public.organisation_members m on m.id = l.member_id
                      where l.cohort_course_id = x.id and l.is_lead and m.status <> 'deactivated' limit 1) as trainer,
                     n.starts_at as first_at, n.mode, n.location
              from public.cohort_courses x join public.courses co on co.id = x.course_id
              left join lateral (select s.starts_at, s.mode::text, s.location from public.sessions s where s.cohort_course_id = x.id and s.cancelled_at is null and s.ends_at > now() order by s.starts_at limit 1) n on true
              where x.cohort_id = ${cohort.id}
              order by n.starts_at nulls last, co.name
            `
          : []
        return c.json({
          ...base,
          kind: 'participant' as const,
          cohort: cohort ? { name: cohort.name, programme: cohort.programme, firstSessionAt: cohort.first_at } : null,
          courses: courses.map((x) => ({ course: x.course, trainer: x.trainer, firstAt: x.first_at, mode: x.mode, location: x.location })),
        })
      }
      return c.json({ ...base, kind: 'staff' as const })
    })

    // P8.01 / P8.02 Notification preferences: defaults unless the person changed them.
    .get('/notification-preferences', async (c) => {
      const { memberId, role } = c.var.auth
      const events = EVENTS[role] ?? []
      const [saved, [digest]] = await Promise.all([
        deps.sql<{ event: string; email: boolean; in_app: boolean }[]>`
          select event, email, in_app from public.notification_preferences where member_id = ${memberId}
        `,
        deps.sql<{ time: string; org_time: string; report_hours: number; remind_hours: number; attendance_hours: number }[]>`
          select to_char(coalesce(m.digest_time, s.digest_local_time), 'HH24:MI') as time, to_char(s.digest_local_time, 'HH24:MI') as org_time,
                 s.report_due_hours as report_hours, s.report_reminder_hours_before as remind_hours, s.in_person_reminder_hours as attendance_hours
          from public.organisation_members m join public.organisation_settings s on s.organisation_id = m.organisation_id where m.id = ${memberId}
        `,
      ])
      const hours = (n: number) => `${n} hour${n === 1 ? '' : 's'}`
      // Trainer events say when they arrive, from the organisation's settings.
      const describe = (key: string) =>
        role !== 'trainer' && role !== 'assistant_trainer' || !digest
          ? null
          : key === 'report_due'
            ? `${hours(digest.remind_hours)} before the due time`
            : key === 'report_overdue'
              ? `When the ${digest.report_hours} hours pass`
              : key === 'submissions_to_grade'
                ? `Daily digest at ${digest.org_time}`
                : key === 'attendance_missing'
                  ? `${hours(digest.attendance_hours)} after an in-person session`
                  : null
      return c.json({
        digestTime: digest?.time ?? '08:00',
        preferences: events.map((e) => {
          const row = saved.find((s) => s.event === e.key)
          return { event: e.key, label: e.label, when: describe(e.key) ?? e.when, email: row?.email ?? e.email, inApp: row?.in_app ?? e.inApp }
        }),
      })
    })

    .put('/notification-preferences', async (c) => {
      const body = await parseBody(c, Preferences)
      const { memberId, organisationId, role } = c.var.auth
      const known = new Set((EVENTS[role] ?? []).map((e) => e.key))
      for (const p of body.preferences.filter((p) => known.has(p.event))) {
        await deps.sql`
          insert into public.notification_preferences (organisation_id, member_id, event, email, in_app)
          values (${organisationId}, ${memberId}, ${p.event}, ${p.email}, ${p.inApp})
          on conflict (member_id, event) do update set email = excluded.email, in_app = excluded.in_app, updated_at = now()
        `
      }
      if (body.digestTime && (role === 'owner' || role === 'admin')) {
        await deps.sql`update public.organisation_members set digest_time = ${body.digestTime}::time where id = ${memberId}`
      }
      return c.json({ ok: true })
    })
}
