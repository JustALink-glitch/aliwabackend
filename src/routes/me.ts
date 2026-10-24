import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { audit } from '../lib/db.js'
import type { Role } from '../lib/roles.js'
import { fullName, parseBody } from '../lib/validation.js'
import { requireAuth, type AuthVariables } from '../middleware/auth.js'

/** Notification events people can tune, by role, with their defaults (P8.01 / P8.02). */
const EVENTS: Partial<Record<Role, { key: string; label: string; when: string; email: boolean; inApp: boolean }[]>> = {
  participant: [
    { key: 'session_starting', label: 'Session starting soon', when: '1 hour before', email: true, inApp: true },
    { key: 'assignment_due', label: 'Assignment due', when: '24 hours before', email: true, inApp: true },
    { key: 'grade_saved', label: 'New grade or feedback', when: 'When a trainer saves it', email: true, inApp: true },
    { key: 'session_changed', label: 'Session changed or cancelled', when: 'Straight away', email: true, inApp: true },
    { key: 'new_resource', label: 'New recording or resource', when: 'Daily digest', email: false, inApp: true },
  ],
}

const Profile = z.object({
  fullName,
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
})

/** /v1/me — who is signed in, their organisation and role; their profile and notification settings. */
export function meRoutes(deps: AppDeps) {
  return new Hono<{ Variables: AuthVariables }>()
    .use(requireAuth(deps))
    .get('/', async (c) => {
      const { userId, email, organisationId, role, memberId } = c.var.auth
      const [organisation] = await deps.sql<{ name: string; time_zone: string }[]>`
        select name, time_zone from public.organisations where id = ${organisationId}
      `
      // Name shown in the top bar and account menu (G1.03).
      const [member] = await deps.sql<{ first_name: string; last_name: string; phone: string | null }[]>`
        select first_name, last_name, phone from public.organisation_members where id = ${memberId}
      `
      return c.json({
        user: { id: userId, email },
        membership: { id: memberId, organisationId, role, firstName: member?.first_name ?? '', lastName: member?.last_name ?? '', phone: member?.phone ?? null },
        organisation: organisation ? { id: organisationId, name: organisation.name, timeZone: organisation.time_zone } : null,
      })
    })

    // P8.01 Profile: display name and phone. Email is the sign-in and can't be changed here.
    .patch('/', async (c) => {
      const body = await parseBody(c, Profile)
      const { organisationId, memberId } = c.var.auth
      await deps.sql.begin(async (tx) => {
        await tx`
          update public.organisation_members
          set first_name = ${body.fullName.firstName}, last_name = ${body.fullName.lastName}, phone = ${body.phone}, updated_at = now()
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
      const saved = await deps.sql<{ event: string; email: boolean; in_app: boolean }[]>`
        select event, email, in_app from public.notification_preferences where member_id = ${memberId}
      `
      return c.json({
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
      return c.json({ ok: true })
    })
}
