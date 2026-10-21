import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { audit, type Sql, type Tx } from '../lib/db.js'
import { AppError, badRequest } from '../lib/errors.js'
import {
  hashInvitationToken,
  invitationLink,
  issueInvitation,
  sendInvitationEmail,
} from '../lib/invitations.js'
import { fullName, parseBody, password } from '../lib/validation.js'
import { shortName } from '../lib/names.js'

interface InvitationRow {
  invitation_id: string
  sent_at: Date
  expires_at: Date
  accepted_at: Date | null
  revoked_at: Date | null
  member_id: string
  member_status: string
  email: string
  first_name: string
  last_name: string
  role: string
  organisation_id: string
  organisation_name: string
  organisation_status: string
  inviter_member_id: string | null
  inviter_first_name: string | null
  inviter_last_name: string | null
  latest_sent_at: Date
}

/**
 * valid    — can be used now
 * expired  — older than 72 h; the invitee can ask for a new link (T1.01e)
 * replaced — a newer link was sent (resend); the invitee can ask for a new link
 * used     — already accepted
 * invalid  — unknown, or the person/organisation is no longer active
 */
type InvitationState = 'valid' | 'expired' | 'replaced' | 'used' | 'invalid'

const invalid = () =>
  new AppError(404, 'invitation_invalid', 'This invitation link is not valid. Ask your administrator for a new one.')
const used = () => new AppError(410, 'invitation_used', 'This invitation has already been used. Sign in instead.')
const notUsable = (state: 'expired' | 'replaced') =>
  state === 'expired'
    ? new AppError(410, 'invitation_expired', 'This invitation link has expired. Request a new link.')
    : new AppError(410, 'invitation_replaced', 'A newer invitation link was sent. Use the latest email, or request a new link.')

/** A new link can be requested at most once a minute per person. */
const RENEW_COOLDOWN_MS = 60 * 1000

// base64url of 32 bytes
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

async function findInvitation(db: Sql | Tx, token: string, lock = false): Promise<InvitationRow | null> {
  if (!TOKEN_PATTERN.test(token)) return null
  const [row] = await db<InvitationRow[]>`
    select i.id as invitation_id, i.sent_at, i.expires_at, i.accepted_at, i.revoked_at,
           m.id as member_id, m.status as member_status, m.email, m.first_name, m.last_name, m.role,
           o.id as organisation_id, o.name as organisation_name, o.status as organisation_status,
           inviter.id as inviter_member_id, inviter.first_name as inviter_first_name,
           inviter.last_name as inviter_last_name,
           (select max(sent_at) from public.invitations latest where latest.member_id = m.id) as latest_sent_at
    from public.invitations i
    join public.organisation_members m on m.id = i.member_id
    join public.organisations o on o.id = i.organisation_id
    left join public.organisation_members inviter on inviter.id = coalesce(i.invited_by, m.invited_by)
    where i.token_hash = ${hashInvitationToken(token)}
    ${lock ? db`for update of i, m` : db``}
  `
  return row ?? null
}

function stateOf(row: InvitationRow | null, now: Date): InvitationState {
  if (!row || row.organisation_status !== 'active' || row.member_status === 'deactivated') return 'invalid'
  if (row.accepted_at || row.member_status === 'active') return 'used'
  if (row.revoked_at) return 'replaced'
  if (row.expires_at <= now) return 'expired'
  return 'valid'
}

function assertValid(row: InvitationRow | null, now: Date): asserts row is InvitationRow {
  const state = stateOf(row, now)
  if (state === 'invalid') throw invalid()
  if (state === 'used') throw used()
  if (state === 'expired' || state === 'replaced') throw notUsable(state)
}

/** "Abdulhameed O." — how the designs name the person who sent the invitation. */
const inviterName = (row: InvitationRow) => shortName(row.inviter_first_name, row.inviter_last_name)

const Accept = z.object({
  password,
  // Optional: the invitee may correct the name the admin entered (T1.01).
  fullName: fullName.optional(),
})

/**
 * Public invitation endpoints (T1 / P1). The token in the link is the only credential:
 * 256 random bits, stored only as a hash, single use, 72 hours.
 */
export function invitationRoutes(deps: AppDeps) {
  const now = deps.now ?? (() => new Date())

  return new Hono()
    // What the "Set your password" or "This link has expired" screen needs to show.
    .get('/:token', async (c) => {
      const row = await findInvitation(deps.sql, c.req.param('token'))
      const state = stateOf(row, now())
      if (state === 'invalid') throw invalid()
      if (state === 'used') throw used()
      return c.json({
        invitation: {
          state,
          email: row!.email,
          firstName: row!.first_name,
          lastName: row!.last_name,
          role: row!.role,
          organisationName: row!.organisation_name,
          invitedBy: inviterName(row!),
          sentAt: row!.sent_at,
          expiresAt: row!.expires_at,
        },
      })
    })

    // Set a password and join. The browser then signs in with email + password.
    .post('/:token/accept', async (c) => {
      const token = c.req.param('token')
      const body = await parseBody(c, Accept)
      const preview = await findInvitation(deps.sql, token)
      assertValid(preview, now())

      const firstName = body.fullName?.firstName ?? preview.first_name
      const lastName = body.fullName?.lastName ?? preview.last_name

      // Supabase Auth lives outside our transaction: create (or reuse) the account first,
      // then link it; undo a newly created account if linking fails.
      let userId = await deps.authAdmin.findUserIdByEmail(preview.email)
      let createdUserId: string | null = null
      if (userId) {
        const [linked] = await deps.sql`
          select 1 from public.organisation_members where user_id = ${userId}
        `
        if (linked) {
          throw new AppError(409, 'account_exists', 'An account with this email already exists. Sign in instead.')
        }
        const result = await deps.authAdmin.setPassword(userId, body.password)
        if (!result.ok) throw badRequest('Choose a stronger password.')
      } else {
        const result = await deps.authAdmin.createUser({
          email: preview.email,
          password: body.password,
          name: `${firstName} ${lastName}`,
        })
        if (!result.ok) {
          throw result.reason === 'weak_password'
            ? badRequest('Choose a stronger password.')
            : new AppError(409, 'account_exists', 'An account with this email already exists. Sign in instead.')
        }
        userId = createdUserId = result.userId
      }

      try {
        await deps.sql.begin(async (tx) => {
          const row = await findInvitation(tx, token, true)
          assertValid(row, now())
          await tx`
            update public.organisation_members
            set user_id = ${userId}, status = 'active', joined_at = ${now()},
                first_name = ${firstName}, last_name = ${lastName}
            where id = ${row.member_id}
          `
          await tx`update public.invitations set accepted_at = ${now()} where id = ${row.invitation_id}`
          await audit(tx, {
            organisationId: row.organisation_id,
            actorMemberId: row.member_id,
            action: 'member.joined',
            entityType: 'member',
            entityId: row.member_id,
            requestId: c.var.requestId,
          })
        })
      } catch (error) {
        if (createdUserId) {
          await deps.authAdmin.deleteUser(createdUserId).catch((cleanupError) => {
            console.error('Could not remove auth user after failed invitation accept', cleanupError)
          })
        }
        throw error
      }

      return c.json({ email: preview.email })
    })

    // Expired or replaced link → email a fresh one to the invitee (T1.01e → T1.01s).
    // The admin who invited them is told (in-app notification).
    .post('/:token/renew', async (c) => {
      const token = c.req.param('token')
      const at = now()

      const result = await deps.sql.begin(async (tx) => {
        const row = await findInvitation(tx, token, true)
        const state = stateOf(row, at)
        if (state === 'invalid') throw invalid()
        if (state === 'used') throw used()
        if (state === 'valid') {
          throw new AppError(409, 'invitation_still_valid', 'This link still works. Use it to set your password.')
        }
        if (at.getTime() - row!.latest_sent_at.getTime() < RENEW_COOLDOWN_MS) {
          throw new AppError(429, 'too_soon', 'A new link was just sent. Check your email, or try again in a minute.')
        }
        const issued = await issueInvitation(tx, {
          organisationId: row!.organisation_id,
          memberId: row!.member_id,
          invitedBy: row!.inviter_member_id,
          now: at,
        })

        // Tell the inviter, or every owner and admin if the inviter is gone.
        const name = `${row!.first_name} ${row!.last_name}`
        await tx`
          insert into public.notifications (organisation_id, recipient_member_id, event, title, body, link_path)
          select ${row!.organisation_id}, m.id, 'invitation_renewal_requested',
                 ${`${name} asked for a new invitation link`},
                 ${'Their previous link had expired. A new one was emailed to them automatically.'},
                 ${'/admin/' + (row!.role === 'participant' ? 'participants' : 'trainers')}
          from public.organisation_members m
          where m.organisation_id = ${row!.organisation_id} and m.status = 'active'
            and (
              m.id = ${row!.inviter_member_id}
              or (${row!.inviter_member_id}::uuid is null and m.role in ('owner', 'admin'))
            )
        `
        await audit(tx, {
          organisationId: row!.organisation_id,
          actorMemberId: row!.member_id,
          action: 'member.invitation_renewed',
          entityType: 'member',
          entityId: row!.member_id,
          requestId: c.var.requestId,
        })
        return { row: row!, token: issued.token, expiresAt: issued.expiresAt }
      })

      await sendInvitationEmail(deps.mailer, {
        to: result.row.email,
        firstName: result.row.first_name,
        organisationName: result.row.organisation_name,
        role: result.row.role,
        link: invitationLink(deps.appUrl, result.token),
      })
      // The link holder already saw this address on the expired screen.
      return c.json({ sent: true, email: result.row.email, expiresAt: result.expiresAt })
    })
}
