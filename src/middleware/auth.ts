import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { isMembership, type AuthContext, type Identity, type LoadMembership, type VerifyToken } from '../lib/auth.js'
import { AppError, forbidden, unauthorized } from '../lib/errors.js'
import type { Role } from '../lib/roles.js'

export type IdentityVariables = { identity: Identity }
export type AuthVariables = { identity: Identity; auth: AuthContext }

async function verifyBearer(c: Context, verifyToken: VerifyToken): Promise<Identity> {
  const header = c.req.header('Authorization')
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : null
  if (!token) throw unauthorized()
  const identity = await verifyToken(token)
  if (!identity) throw unauthorized('Your session has expired. Sign in again.')
  return identity
}

/**
 * Requires a valid Supabase access token, nothing more. For the few routes used before a
 * person belongs to an organisation (creating one). Sets `c.var.identity`.
 */
export function requireIdentity(deps: { verifyToken: VerifyToken }) {
  return createMiddleware<{ Variables: IdentityVariables }>(async (c, next) => {
    c.set('identity', await verifyBearer(c, deps.verifyToken))
    await next()
  })
}

/** Writes still allowed while an organisation is scheduled for deletion. */
const READ_ONLY_ALLOWED = ['/v1/privacy', '/v1/reports']

/**
 * Requires a valid token and an active organisation membership.
 * Sets `c.var.auth` — the only trusted source of user, organisation and role.
 * Never read organisation or role from the request body or query.
 */
export function requireAuth(deps: { verifyToken: VerifyToken; loadMembership: LoadMembership }) {
  return createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    const identity = await verifyBearer(c, deps.verifyToken)
    const membership = await deps.loadMembership(identity.userId)
    if (!isMembership(membership)) {
      // The frontend uses the code: resume organisation set-up (R1.03a) or show "access ended" (P1.04w).
      throw membership.reason === 'no_organisation'
        ? new AppError(403, 'no_organisation', 'This account has not set up or joined an organisation yet.')
        : new AppError(403, 'access_ended', 'Your access to this organisation has ended. Contact your administrator.')
    }
    // F1.11b: while deletion is scheduled people can read and download, but not change anything.
    // Owners can still export data, generate reports and cancel the deletion.
    if (membership.readOnly && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !READ_ONLY_ALLOWED.some((p) => c.req.path.startsWith(p))) {
      throw new AppError(423, 'read_only', 'This workspace is scheduled for deletion, so nothing can be changed. An owner can cancel the deletion in Settings › Data & privacy.')
    }
    c.set('identity', identity)
    c.set('auth', { ...identity, ...membership })
    await next()
  })
}

/** Allows only the listed roles. Use after `requireAuth`. */
export function requireRole(...roles: Role[]) {
  return createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    if (!roles.includes(c.var.auth.role)) throw forbidden()
    await next()
  })
}
