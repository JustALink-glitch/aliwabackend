import type { SupabaseClient } from '@supabase/supabase-js'
import type { Sql } from './db.js'

export type CreateUserResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'email_exists' | 'weak_password' }

/** The few Supabase Auth admin operations the API needs. Swappable in tests. */
export interface AuthAdmin {
  findUserIdByEmail(email: string): Promise<string | null>
  createUser(input: { email: string; password: string; name: string }): Promise<CreateUserResult>
  setPassword(userId: string, password: string): Promise<{ ok: true } | { ok: false; reason: 'weak_password' }>
  deleteUser(userId: string): Promise<void>
  /** A one-time password-reset link (valid 1 hour), or null if no account uses this email. Sends nothing. */
  generateRecoveryLink(email: string, redirectTo: string): Promise<string | null>
  /** B2.05: change someone's sign-in email (an admin change; the new address is told separately). */
  updateEmail(userId: string, email: string): Promise<{ ok: true } | { ok: false; reason: 'email_exists' }>
}

export function createSupabaseAuthAdmin(supabase: SupabaseClient, sql: Sql): AuthAdmin {
  return {
    async findUserIdByEmail(email) {
      const [row] = await sql<{ id: string }[]>`
        select id from auth.users where lower(email) = ${email.toLowerCase()} limit 1
      `
      return row?.id ?? null
    },

    async createUser({ email, password, name }) {
      const { data, error } = await supabase.auth.admin.createUser({
        email,
        password,
        // The invitation link already proved the person controls this inbox.
        email_confirm: true,
        user_metadata: { name },
      })
      if (error) {
        if (error.code === 'email_exists') return { ok: false, reason: 'email_exists' }
        if (error.code === 'weak_password') return { ok: false, reason: 'weak_password' }
        throw error
      }
      return { ok: true, userId: data.user.id }
    },

    async setPassword(userId, password) {
      const { error } = await supabase.auth.admin.updateUserById(userId, { password, email_confirm: true })
      if (error) {
        if (error.code === 'weak_password') return { ok: false, reason: 'weak_password' }
        throw error
      }
      return { ok: true }
    },

    async deleteUser(userId) {
      const { error } = await supabase.auth.admin.deleteUser(userId)
      if (error) throw error
    },

    async updateEmail(userId, email) {
      const { error } = await supabase.auth.admin.updateUserById(userId, { email, email_confirm: true })
      if (error) {
        if (error.code === 'email_exists') return { ok: false, reason: 'email_exists' }
        throw error
      }
      return { ok: true }
    },

    async generateRecoveryLink(email, redirectTo) {
      const { data, error } = await supabase.auth.admin.generateLink({
        type: 'recovery',
        email,
        options: { redirectTo },
      })
      if (error) {
        if (error.code === 'user_not_found' || error.status === 404) return null
        throw error
      }
      return data.properties.action_link
    },
  }
}
