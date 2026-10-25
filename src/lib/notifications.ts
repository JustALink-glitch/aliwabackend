import type { Role } from './roles.js'
import type { Sql, Tx } from './db.js'
import { renderEmail, type Mailer } from './mailer.js'

/** Notification events people can tune, by role, with their defaults (P8.01 / P8.02). */
export type NotificationEvent = { key: string; label: string; when: string; email: boolean; inApp: boolean }

/** F1.09 Owners and admins. */
const ADMIN_EVENTS: NotificationEvent[] = [
  { key: 'attention_flags', label: 'New Needs attention flags', when: 'Daily digest', email: true, inApp: true },
  { key: 'report_overdue', label: 'Session report overdue', when: '', email: false, inApp: true },
  { key: 'attendance_missing', label: 'Attendance not recorded', when: '2 hours after a session ends', email: false, inApp: true },
  { key: 'zoom_review', label: 'Zoom attendees to review', when: 'Names Synqop couldn’t match', email: false, inApp: true },
  { key: 'participant_left', label: 'Participant deferred or withdrawn', when: '', email: true, inApp: true },
  { key: 'certificate_eligible', label: 'Participants eligible for a certificate', when: '', email: true, inApp: true },
  { key: 'import_finished', label: 'Import finished', when: '', email: false, inApp: true },
  { key: 'report_ready', label: 'Report ready to download', when: '', email: false, inApp: true },
  { key: 'invitation_accepted', label: 'Invitation accepted', when: 'Trainers and members', email: false, inApp: true },
]

export const EVENTS: Partial<Record<Role, NotificationEvent[]>> = {
  owner: ADMIN_EVENTS,
  admin: ADMIN_EVENTS,
  participant: [
    { key: 'session_starting', label: 'Session starting soon', when: '1 hour before', email: true, inApp: true },
    { key: 'assignment_due', label: 'Assignment due', when: '24 hours before', email: true, inApp: true },
    { key: 'grade_saved', label: 'New grade or feedback', when: 'When a trainer saves it', email: true, inApp: true },
    { key: 'session_changed', label: 'Session changed or cancelled', when: 'Straight away', email: true, inApp: true },
    { key: 'new_resource', label: 'New recording or resource', when: 'Daily digest', email: false, inApp: true },
  ],
}


/** Who gets an in-app notification: named people, or everyone in the organisation with these roles. */
export type Recipients = { memberIds: string[] } | { roles: Role[] }

/**
 * Adds an in-app notification (G1.01) for each recipient who hasn't switched that event off.
 * Events without a preference row use the default for the person's role; unknown events are always shown.
 */
export async function notify(
  sql: Sql | Tx,
  input: { organisationId: string; to: Recipients; event: string; title: string; body?: string | null; link?: string | null; except?: string | null },
) {
  const people = await sql<{ id: string; role: Role; in_app: boolean | null }[]>`
    select m.id, m.role, p.in_app
    from public.organisation_members m
    left join public.notification_preferences p on p.member_id = m.id and p.event = ${input.event}
    where m.organisation_id = ${input.organisationId} and m.status = 'active'
      ${'memberIds' in input.to ? sql`and m.id = any(${input.to.memberIds}::uuid[])` : sql`and m.role in ${sql(input.to.roles)}`}
      ${input.except ? sql`and m.id <> ${input.except}` : sql``}
  `
  const ids = people
    .filter((p) => p.in_app ?? EVENTS[p.role]?.find((e) => e.key === input.event)?.inApp ?? true)
    .map((p) => p.id)
  if (!ids.length) return 0
  await sql`
    insert into public.notifications (organisation_id, recipient_member_id, event, title, body, link_path)
    select ${input.organisationId}, id, ${input.event}, ${input.title}, ${input.body ?? null}, ${input.link ?? null}
    from unnest(${ids}::uuid[]) as id
  `
  return ids.length
}

export interface EmailParts {
  subject: string
  title: string
  intro: (firstName: string) => string
  details?: { label: string; value: string }[]
  buttonLabel: string
  note?: string
  /** Why they got it (X2 frames: "You get this because…"). */
  footer?: string
}

/**
 * In-app and email together (X2), outside a transaction. Each person's choices for the event decide
 * which they get; events with no saved choice use the role's default (email on for roles without a list).
 * Returns how many emails went out.
 */
export async function deliver(
  deps: { sql: Sql; mailer: Mailer; appUrl: string },
  input: { organisationId: string; to: Recipients; event: string; title: string; body?: string | null; link: string; email?: EmailParts; except?: string | null; inApp?: boolean },
) {
  const people = await deps.sql<{ id: string; role: Role; email: string; first_name: string; in_app: boolean | null; by_email: boolean | null }[]>`
    select m.id, m.role, m.email, m.first_name, p.in_app, p.email as by_email
    from public.organisation_members m
    left join public.notification_preferences p on p.member_id = m.id and p.event = ${input.event}
    where m.organisation_id = ${input.organisationId} and m.status = 'active'
      ${'memberIds' in input.to ? deps.sql`and m.id = any(${input.to.memberIds}::uuid[])` : deps.sql`and m.role in ${deps.sql(input.to.roles)}`}
      ${input.except ? deps.sql`and m.id <> ${input.except}` : deps.sql``}
  `
  const fallback = (role: Role) => EVENTS[role]?.find((e) => e.key === input.event)
  const inApp = input.inApp === false ? [] : people.filter((p) => p.in_app ?? fallback(p.role)?.inApp ?? true).map((p) => p.id)
  if (inApp.length) {
    await deps.sql`
      insert into public.notifications (organisation_id, recipient_member_id, event, title, body, link_path)
      select ${input.organisationId}, id, ${input.event}, ${input.title}, ${input.body ?? null}, ${input.link}
      from unnest(${inApp}::uuid[]) as id
    `
  }
  if (!input.email) return 0
  const url = `${deps.appUrl.replace(/\/$/, '')}${input.link}`
  let sent = 0
  for (const p of people.filter((p) => p.by_email ?? fallback(p.role)?.email ?? true)) {
    const { text, html } = renderEmail({
      title: input.email.title,
      intro: input.email.intro(p.first_name),
      details: input.email.details,
      buttonLabel: input.email.buttonLabel,
      buttonUrl: url,
      note: input.email.note,
      footer: input.email.footer,
    })
    try {
      await deps.mailer.send({ to: p.email, subject: input.email.subject, text, html })
      sent++
    } catch (error) {
      console.error(`Email for ${input.event} failed`, error)
    }
  }
  return sent
}
