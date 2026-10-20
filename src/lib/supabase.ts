import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../env.js'

/**
 * Server-side Supabase client using the secret (service-role) key.
 * It bypasses row-level security, so every query made with it must be scoped to
 * `c.var.auth.organisationId` — the tenant wall is enforced both here and by RLS.
 */
export function createAdminClient(env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY'>): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}
