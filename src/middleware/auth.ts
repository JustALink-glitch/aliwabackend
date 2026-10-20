import { createMiddleware } from 'hono/factory'
import type { AuthContext, LoadMembership, VerifyToken } from '../lib/auth.js'
import { forbidden, unauthorized } from '../lib/errors.js'
import type { Role } from '../lib/roles.js'

export type AuthVariables = { auth: AuthContext }

/**
 * Requires a valid Supabase access token and an active organisation membership.
 * Sets `c.var.auth` — the only trusted source of user, organisation and role.
 * Never read organisation or role from the request body or query.
 */
export function requireAuth(deps: { verifyToken: VerifyToken; loadMembership: LoadMembership }) {
  return createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    const header = c.req.header('Authorization')
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : null
    if (!token) throw unauthorized()

    const identity = await deps.verifyToken(token)
    if (!identity) throw unauthorized('Your session has expired. Sign in again.')

    const membership = await deps.loadMembership(identity.userId)
    if (!membership) throw forbidden('This account is not active in any organisation.')

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
