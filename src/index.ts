import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { loadEnv } from './env.js'
import { createMembershipLoader, createTokenVerifier } from './lib/auth.js'
import { createAdminClient } from './lib/supabase.js'

const env = loadEnv()
const db = createAdminClient(env)

const app = createApp({
  corsOrigins: env.CORS_ORIGINS,
  verifyToken: createTokenVerifier(env.SUPABASE_URL),
  loadMembership: createMembershipLoader(db),
  exposeErrors: env.NODE_ENV === 'development',
})

serve({ fetch: app.fetch, port: env.PORT }, ({ port }) => {
  console.info(`Synqop API listening on http://localhost:${port}`)
})
