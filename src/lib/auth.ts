import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { Sql } from './db.js'
import { isRole, type Role } from './roles.js'

/** The verified identity from a Supabase Auth access token. */
export interface Identity {
  userId: string
  email: string | null
}

/** The signed-in user's place in their organisation. One email = one organisation. */
export interface Membership {
  memberId: string
  organisationId: string
  role: Role
}

export type AuthContext = Identity & Membership

export type VerifyToken = (token: string) => Promise<Identity | null>
export type LoadMembership = (userId: string) => Promise<Membership | null>

/**
 * Verifies Supabase Auth access tokens locally against the project's published
 * signing keys (JWKS). Keys are cached by `jose`, so there is no network call per request.
 */
export function createTokenVerifier(supabaseUrl: string): VerifyToken {
  const issuer = `${supabaseUrl.replace(/\/$/, '')}/auth/v1`
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`))

  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer, audience: 'authenticated' })
      if (typeof payload.sub !== 'string') return null
      return {
        userId: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : null,
      }
    } catch {
      return null
    }
  }
}

/** Looks up the active membership for a user. Deactivated or invited members get no access. */
export function createMembershipLoader(sql: Sql): LoadMembership {
  return async (userId) => {
    const [row] = await sql<{ id: string; organisation_id: string; role: string }[]>`
      select id, organisation_id, role
      from public.organisation_members
      where user_id = ${userId} and status = 'active'
    `
    if (!row || !isRole(row.role)) return null
    return { memberId: row.id, organisationId: row.organisation_id, role: row.role }
  }
}
