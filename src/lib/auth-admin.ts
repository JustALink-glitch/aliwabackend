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
  }
}
