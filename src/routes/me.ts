import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { audit } from '../lib/db.js'
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
})

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
      const [member] = await deps.sql<{ first_name: string; last_name: string; phone: string | null; display_name: string | null; last_sign_in_at: Date | null }[]>`
        select m.first_name, m.last_name, m.phone, m.display_name, u.last_sign_in_at
        from public.organisation_members m left join auth.users u on u.id = m.user_id where m.id = ${memberId}
      `
      return c.json({
        user: { id: userId, email },
        membership: { id: memberId, organisationId, role, firstName: member?.first_name ?? '', lastName: member?.last_name ?? '', phone: member?.phone ?? null,
          displayName: member?.display_name ?? null,
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
              ${body.displayName !== undefined ? tx`display_name = ${body.displayName},` : tx``} updated_at = now()
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

    // P8.01 / P8.02 Notification preferences: defaults unless the person changed them.
    .get('/notification-preferences', async (c) => {
      const { memberId, role } = c.var.auth
      const events = EVENTS[role] ?? []
      const [saved, [digest]] = await Promise.all([
        deps.sql<{ event: string; email: boolean; in_app: boolean }[]>`
          select event, email, in_app from public.notification_preferences where member_id = ${memberId}
        `,
        deps.sql<{ time: string }[]>`
          select to_char(coalesce(m.digest_time, s.digest_local_time), 'HH24:MI') as time
          from public.organisation_members m join public.organisation_settings s on s.organisation_id = m.organisation_id where m.id = ${memberId}
        `,
      ])
      return c.json({
        digestTime: digest?.time ?? '08:00',
        preferences: events.map((e) => {
          const row = saved.find((s) => s.event === e.key)
          return { event: e.key, label: e.label, when: e.when, email: row?.email ?? e.email, inApp: row?.in_app ?? e.inApp }
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
