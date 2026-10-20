import { createHash, randomBytes } from 'node:crypto'
import type { Sql, Tx } from './db.js'
import { renderEmail, type Mailer } from './mailer.js'

/** One-time invitation links are valid for 72 hours (§05 Invitations). */
export const INVITATION_TTL_HOURS = 72

export function newInvitationToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: hashInvitationToken(token) }
}

export function hashInvitationToken(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}

/**
 * Revokes any live invitation for the member and issues a new one.
 * "Resend cancels the old link." Returns the raw token to put in the email — it is never stored.
 */
export async function issueInvitation(
  tx: Sql | Tx,
  input: { organisationId: string; memberId: string; invitedBy: string | null; now: Date },
): Promise<{ token: string; expiresAt: Date }> {
  await tx`
    update public.invitations set revoked_at = ${input.now}
    where member_id = ${input.memberId} and accepted_at is null and revoked_at is null
  `
  const { token, hash } = newInvitationToken()
  const expiresAt = new Date(input.now.getTime() + INVITATION_TTL_HOURS * 3600 * 1000)
  await tx`
    insert into public.invitations (organisation_id, member_id, token_hash, expires_at, invited_by, sent_at)
    values (${input.organisationId}, ${input.memberId}, ${hash}, ${expiresAt}, ${input.invitedBy}, ${input.now})
  `
  return { token, expiresAt }
}

const ROLE_LABEL: Record<string, string> = {
  owner: 'an owner',
  admin: 'an admin',
  trainer: 'a trainer',
  assistant_trainer: 'an assistant trainer',
  participant: 'a participant',
}

/** Sends the invitation email (T0.01 / P0.01). Returns false instead of throwing so the invite still stands. */
export async function sendInvitationEmail(
  mailer: Mailer,
  input: { to: string; firstName: string; organisationName: string; role: string; link: string },
): Promise<boolean> {
  const { text, html } = renderEmail({
    title: `You're invited to ${input.organisationName}`,
    intro: `Hi ${input.firstName}, you've been added to ${input.organisationName} on Synqop as ${ROLE_LABEL[input.role] ?? 'a member'}. Set a password to get started.`,
    buttonLabel: 'Set your password',
    buttonUrl: input.link,
    note: `This link works once and expires in ${INVITATION_TTL_HOURS} hours. If you weren't expecting it, you can ignore this email.`,
  })
  try {
    await mailer.send({ to: input.to, subject: `You're invited to ${input.organisationName} on Synqop`, text, html })
    return true
  } catch (error) {
    console.error('Invitation email failed', error)
    return false
  }
}

export function invitationLink(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/$/, '')}/invite/${token}`
}
