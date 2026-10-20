import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { logger } from 'hono/logger'
import { requestId } from 'hono/request-id'
import { secureHeaders } from 'hono/secure-headers'
import type { LoadMembership, VerifyToken } from './lib/auth.js'
import type { AuthAdmin } from './lib/auth-admin.js'
import type { Sql } from './lib/db.js'
import { AppError } from './lib/errors.js'
import type { Mailer } from './lib/mailer.js'
import { invitationRoutes } from './routes/invitations.js'
import { meRoutes } from './routes/me.js'
import { memberRoutes } from './routes/members.js'
import { organisationRoutes } from './routes/organisations.js'
import { passwordResetRoutes } from './routes/password-reset.js'

export interface AppDeps {
  corsOrigins: string[]
  verifyToken: VerifyToken
  loadMembership: LoadMembership
  sql: Sql
  authAdmin: AuthAdmin
  mailer: Mailer
  /** Frontend base URL, for links in emails. */
  appUrl: string
  /** Clock, injectable for tests. */
  now?: () => Date
  /** Show internal error messages in responses. Never true in production. */
  exposeErrors?: boolean
  log?: boolean
}

export function createApp(deps: AppDeps) {
  const app = new Hono()

  app.use(requestId())
  if (deps.log !== false) app.use(logger())
  app.use(secureHeaders())
  app.use(
    cors({
      origin: (origin) => (deps.corsOrigins.includes(origin.replace(/\/$/, '')) ? origin : null),
      allowHeaders: ['Content-Type', 'Authorization'],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      maxAge: 600,
    }),
  )
  // JSON bodies only; file uploads go straight to storage via signed URLs.
  app.use(bodyLimit({ maxSize: 1024 * 1024 }))

  app.get('/health', (c) => c.json({ status: 'ok' }))

  // Each router applies its own auth. Public: invitations, password reset. Signed in, no organisation yet:
  // organisations. Everything else requires an active membership.
  app.route('/v1/invitations', invitationRoutes(deps))
  app.route('/v1/auth/password-reset', passwordResetRoutes(deps))
  app.route('/v1/organisations', organisationRoutes(deps))
  app.route('/v1/me', meRoutes(deps))
  app.route('/v1/members', memberRoutes(deps))

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Route not found.' } }, 404))

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status)
    }
    if (err instanceof HTTPException) {
      return c.json({ error: { code: 'http_error', message: err.message } }, err.status)
    }
    console.error(`[${c.var.requestId}]`, err)
    return c.json(
      {
        error: {
          code: 'internal_error',
          message: deps.exposeErrors ? err.message : 'Something went wrong. Try again.',
          requestId: c.var.requestId,
        },
      },
      500,
    )
  })

  return app
}

export type App = ReturnType<typeof createApp>
