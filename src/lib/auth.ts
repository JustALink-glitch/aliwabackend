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
  /** The organisation is scheduled for deletion (F1.11b): nothing can be changed. */
  readOnly?: boolean
}

export type AuthContext = Identity & Membership

export type VerifyToken = (token: string) => Promise<Identity | null>
/** Why there is no access: never joined any organisation, or access was ended by an admin. */
export type NoMembership = { reason: 'no_organisation' | 'access_ended' }
export type LoadMembership = (userId: string) => Promise<Membership | NoMembership>

export const isMembership = (value: Membership | NoMembership): value is Membership => 'memberId' in value

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

/** Looks up the user's membership. Only an active member gets access. */
export function createMembershipLoader(sql: Sql): LoadMembership {
  return async (userId) => {
    const [row] = await sql<{ id: string; organisation_id: string; role: string; status: string; deleting: boolean; deleted: boolean }[]>`
      select m.id, m.organisation_id, m.role, m.status,
             o.status = 'pending_deletion' as deleting, coalesce(o.deletion_scheduled_for <= now(), false) as deleted
      from public.organisation_members m join public.organisations o on o.id = m.organisation_id
      where m.user_id = ${userId}
    `
    if (!row) return { reason: 'no_organisation' }
    // Past its deletion date the workspace is gone for everyone, even before the data is purged.
    if (row.status !== 'active' || !isRole(row.role) || row.deleted) return { reason: 'access_ended' }
    return { memberId: row.id, organisationId: row.organisation_id, role: row.role, readOnly: row.deleting }
  }
}
