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
import { parseBody, password } from '../lib/validation.js'

interface InvitationRow {
  invitation_id: string
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
}

type InvitationState = 'valid' | 'expired' | 'used' | 'invalid'

const invalid = () => new AppError(404, 'invitation_invalid', 'This invitation link is not valid. Ask your administrator for a new one.')
const used = () => new AppError(410, 'invitation_used', 'This invitation has already been used. Sign in instead.')
const expired = () => new AppError(410, 'invitation_expired', 'This invitation link has expired. Request a new link.')

// base64url of 32 bytes
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

async function findInvitation(db: Sql | Tx, token: string, lock = false): Promise<InvitationRow | null> {
  if (!TOKEN_PATTERN.test(token)) return null
  const [row] = await db<InvitationRow[]>`
    select i.id as invitation_id, i.expires_at, i.accepted_at, i.revoked_at,
           m.id as member_id, m.status as member_status, m.email, m.first_name, m.last_name, m.role,
           o.id as organisation_id, o.name as organisation_name, o.status as organisation_status
    from public.invitations i
    join public.organisation_members m on m.id = i.member_id
    join public.organisations o on o.id = i.organisation_id
    where i.token_hash = ${hashInvitationToken(token)}
    ${lock ? db`for update of i, m` : db``}
  `
  return row ?? null
}

function stateOf(row: InvitationRow | null, now: Date): InvitationState {
  if (!row || row.revoked_at || row.organisation_status !== 'active' || row.member_status === 'deactivated') {
    return 'invalid'
  }
  if (row.accepted_at || row.member_status === 'active') return 'used'
  if (row.expires_at <= now) return 'expired'
  return 'valid'
}

function assertValid(row: InvitationRow | null, now: Date): asserts row is InvitationRow {
  const state = stateOf(row, now)
  if (state === 'invalid') throw invalid()
  if (state === 'used') throw used()
  if (state === 'expired') throw expired()
}

const Accept = z.object({ password })

/**
 * Public invitation endpoints (T0/P0). The token in the link is the only credential:
 * 256 random bits, stored only as a hash, single use, 72 hours.
 */
export function invitationRoutes(deps: AppDeps) {
  const now = deps.now ?? (() => new Date())

  return new Hono()
    // What the "Set your password" screen needs to show.
    .get('/:token', async (c) => {
      const row = await findInvitation(deps.sql, c.req.param('token'))
      assertValid(row, now())
      return c.json({
        invitation: {
          email: row.email,
          firstName: row.first_name,
          lastName: row.last_name,
          role: row.role,
          organisationName: row.organisation_name,
          expiresAt: row.expires_at,
        },
      })
    })

    // Set a password and join. The browser then signs in with email + password.
    .post('/:token/accept', async (c) => {
      const token = c.req.param('token')
      const body = await parseBody(c, Accept)
      const preview = await findInvitation(deps.sql, token)
      assertValid(preview, now())

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
          name: `${preview.first_name} ${preview.last_name}`,
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
            set user_id = ${userId}, status = 'active', joined_at = ${now()}
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

    // Expired link → request a new one (T0/P0 expired state). Goes to the invitee's own inbox.
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
        const issued = await issueInvitation(tx, {
          organisationId: row!.organisation_id,
          memberId: row!.member_id,
          invitedBy: null,
          now: at,
        })
        await audit(tx, {
          organisationId: row!.organisation_id,
          actorMemberId: row!.member_id,
          action: 'member.invitation_renewed',
          entityType: 'member',
          entityId: row!.member_id,
          requestId: c.var.requestId,
        })
        return { row: row!, token: issued.token }
      })

      await sendInvitationEmail(deps.mailer, {
        to: result.row.email,
        firstName: result.row.first_name,
        organisationName: result.row.organisation_name,
        role: result.row.role,
        link: invitationLink(deps.appUrl, result.token),
      })
      // Don't reveal the address beyond what the link holder already saw.
      return c.json({ sent: true })
    })
}
