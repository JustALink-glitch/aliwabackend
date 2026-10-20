import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { logger } from 'hono/logger'
import { requestId } from 'hono/request-id'
import { secureHeaders } from 'hono/secure-headers'
import type { LoadMembership, VerifyToken } from './lib/auth.js'
import { AppError } from './lib/errors.js'
import { requireAuth, type AuthVariables } from './middleware/auth.js'
import { meRoutes } from './routes/me.js'

export interface AppDeps {
  corsOrigins: string[]
  verifyToken: VerifyToken
  loadMembership: LoadMembership
  /** Show internal error messages in responses. Never true in production. */
  exposeErrors?: boolean
  log?: boolean
}

export function createApp(deps: AppDeps) {
  const app = new Hono<{ Variables: AuthVariables }>()

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

  const v1 = new Hono<{ Variables: AuthVariables }>()
  v1.use(requireAuth(deps))
  v1.route('/me', meRoutes)
  app.route('/v1', v1)

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
