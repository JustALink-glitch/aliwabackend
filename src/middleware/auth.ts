import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { AuthContext, Identity, LoadMembership, VerifyToken } from '../lib/auth.js'
import { forbidden, unauthorized } from '../lib/errors.js'
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

/**
 * Requires a valid token and an active organisation membership.
 * Sets `c.var.auth` — the only trusted source of user, organisation and role.
 * Never read organisation or role from the request body or query.
 */
export function requireAuth(deps: { verifyToken: VerifyToken; loadMembership: LoadMembership }) {
  return createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    const identity = await verifyBearer(c, deps.verifyToken)
    const membership = await deps.loadMembership(identity.userId)
    if (!membership) throw forbidden('This account is not active in any organisation.')
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
