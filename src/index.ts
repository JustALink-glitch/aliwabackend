import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { loadEnv } from './env.js'
import { createMembershipLoader, createTokenVerifier } from './lib/auth.js'
import { createSupabaseAuthAdmin } from './lib/auth-admin.js'
import { createSql } from './lib/db.js'
import { createConsoleMailer, createResendMailer } from './lib/mailer.js'
import { createSupabaseStorage } from './lib/storage.js'
import { createAdminClient } from './lib/supabase.js'

const env = loadEnv()
const sql = createSql(env.DATABASE_URL)
const supabase = createAdminClient(env)

const app = createApp({
  corsOrigins: env.CORS_ORIGINS,
  appUrl: env.APP_URL,
  sql,
  verifyToken: createTokenVerifier(env.SUPABASE_URL),
  loadMembership: createMembershipLoader(sql),
  authAdmin: createSupabaseAuthAdmin(supabase, sql),
  storage: createSupabaseStorage(supabase),
  mailer: env.RESEND_API_KEY
    ? createResendMailer({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM })
    : createConsoleMailer(),
  exposeErrors: env.NODE_ENV === 'development',
})

const server = serve({ fetch: app.fetch, port: env.PORT }, ({ port }) => {
  console.info(`Synqop API listening on http://localhost:${port}`)
})

const shutdown = () => {
  server.close()
  void sql.end({ timeout: 5 })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
