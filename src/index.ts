import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { loadEnv } from './env.js'
import { createMembershipLoader, createTokenVerifier } from './lib/auth.js'
import { createSupabaseAuthAdmin } from './lib/auth-admin.js'
import { createSql } from './lib/db.js'
import { createConsoleMailer, createResendMailer } from './lib/mailer.js'
import { startScheduler } from './lib/scheduler.js'
import { createSupabaseStorage } from './lib/storage.js'
import { createZoomApi, tokenBox } from './lib/zoom.js'
import { createAdminClient } from './lib/supabase.js'

const env = loadEnv()
const sql = createSql(env.DATABASE_URL)
const supabase = createAdminClient(env)

const mailer = env.RESEND_API_KEY ? createResendMailer({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM }) : createConsoleMailer()
const storage = createSupabaseStorage(supabase)
const authAdmin = createSupabaseAuthAdmin(supabase, sql)
const zoom =
  env.ZOOM_CLIENT_ID && env.ZOOM_CLIENT_SECRET && env.ZOOM_REDIRECT_URL
    ? createZoomApi({
        clientId: env.ZOOM_CLIENT_ID,
        clientSecret: env.ZOOM_CLIENT_SECRET,
        redirectUrl: env.ZOOM_REDIRECT_URL,
        oauthBase: env.ZOOM_OAUTH_BASE,
        apiBase: env.ZOOM_API_BASE,
      })
    : null
const zoomBox = env.ZOOM_CLIENT_SECRET ? tokenBox(env.ZOOM_CLIENT_SECRET) : null

const app = createApp({
  corsOrigins: env.CORS_ORIGINS,
  appUrl: env.APP_URL,
  sql,
  verifyToken: createTokenVerifier(env.SUPABASE_URL),
  loadMembership: createMembershipLoader(sql),
  authAdmin,
  storage,
  mailer,
  cronSecret: env.CRON_SECRET,
  zoom,
  zoomBox,
  exposeErrors: env.NODE_ENV === 'development',
})

const server = serve({ fetch: app.fetch, port: env.PORT }, ({ port }) => {
  console.info(`Synqop API listening on http://localhost:${port}`)
})

const stopScheduler = env.SCHEDULER === 'on' ? startScheduler({ sql, mailer, appUrl: env.APP_URL, storage, authAdmin, zoom, zoomBox }) : () => {}

const shutdown = () => {
  stopScheduler()
  server.close()
  void sql.end({ timeout: 5 })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
