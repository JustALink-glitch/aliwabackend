import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createApp, type AppDeps } from '../src/app.js'
import type { Identity, Membership } from '../src/lib/auth.js'
import type { AuthAdmin } from '../src/lib/auth-admin.js'
import type { Sql } from '../src/lib/db.js'
import type { FileStorage } from '../src/lib/storage.js'
import { requireRole, type AuthVariables } from '../src/middleware/auth.js'

const identity: Identity = { userId: 'user-1', email: 'ada@aliwa.org' }
const membership: Membership = { memberId: 'member-1', organisationId: 'org-1', role: 'admin' }

function makeApp(overrides: Partial<AppDeps> = {}) {
  return createApp({
    corsOrigins: ['http://localhost:5173'],
    verifyToken: async (token) => (token === 'good' ? identity : null),
    loadMembership: async () => membership,
    // Unit tests don't touch the database: every query returns no rows.
    sql: (async () => []) as unknown as Sql,
    authAdmin: {} as AuthAdmin,
    mailer: { send: async () => {} },
    storage: {} as FileStorage,
    appUrl: 'http://localhost:5173',
    log: false,
    ...overrides,
  })
}

type ErrorBody = { error: { code: string; message: string; requestId?: string } }
const json = async (res: Response) => (await res.json()) as ErrorBody

const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } })

describe('health', () => {
  it('is public', async () => {
    const res = await makeApp().request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })
})

describe('authentication', () => {
  it('rejects requests without a token', async () => {
    const res = await makeApp().request('/v1/me')
    expect(res.status).toBe(401)
    expect((await json(res)).error.code).toBe('unauthorized')
  })

  it('rejects an invalid token', async () => {
    const res = await makeApp().request('/v1/me', bearer('bad'))
    expect(res.status).toBe(401)
  })

  it('rejects a valid user with no active membership, saying why', async () => {
    const none = await makeApp({ loadMembership: async () => ({ reason: 'no_organisation' }) }).request('/v1/me', bearer('good'))
    expect(none.status).toBe(403)
    expect((await json(none)).error.code).toBe('no_organisation')
    const ended = await makeApp({ loadMembership: async () => ({ reason: 'access_ended' }) }).request('/v1/me', bearer('good'))
    expect((await json(ended)).error.code).toBe('access_ended')
  })

  it('returns the user, organisation and role from the server, not the request', async () => {
    const res = await makeApp().request('/v1/me?organisationId=org-2&role=owner', bearer('good'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      user: { id: 'user-1', email: 'ada@aliwa.org' },
      membership: { id: 'member-1', organisationId: 'org-1', role: 'admin', firstName: '', lastName: '', phone: null, displayName: null, lastSignInAt: null },
      organisation: null,
    })
  })
})

describe('requireRole', () => {
  function guarded(role: Membership['role']) {
    const app = new Hono<{ Variables: AuthVariables }>()
    app.use(async (c, next) => {
      c.set('auth', { ...identity, ...membership, role })
      await next()
    })
    app.get('/owner-only', requireRole('owner'), (c) => c.text('ok'))
    return app
  }

  it('allows the listed role', async () => {
    expect((await guarded('owner').request('/owner-only')).status).toBe(200)
  })

  it('blocks other roles', async () => {
    const app = guarded('admin')
    app.onError((err, c) => c.text(err.message, 403))
    expect((await app.request('/owner-only')).status).toBe(403)
  })
})

describe('errors', () => {
  const failing = (exposeErrors: boolean) =>
    makeApp({
      exposeErrors,
      loadMembership: async () => {
        throw new Error('relation "organisation_members" does not exist')
      },
    })

  it('hides internal messages by default', async () => {
    const res = await failing(false).request('/v1/me', bearer('good'))
    expect(res.status).toBe(500)
    const body = await json(res)
    expect(body.error.message).toBe('Something went wrong. Try again.')
    expect(body.error.requestId).toBeTruthy()
  })

  it('shows them in development', async () => {
    const res = await failing(true).request('/v1/me', bearer('good'))
    expect((await json(res)).error.message).toContain('organisation_members')
  })

  it('returns JSON for unknown routes', async () => {
    const res = await makeApp().request('/nope')
    expect(res.status).toBe(404)
    expect((await json(res)).error.code).toBe('not_found')
  })
})

describe('CORS', () => {
  it('allows configured origins only', async () => {
    const app = makeApp()
    const allowed = await app.request('/health', { headers: { Origin: 'http://localhost:5173' } })
    const blocked = await app.request('/health', { headers: { Origin: 'https://evil.example' } })
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    expect(blocked.headers.get('access-control-allow-origin')).toBeNull()
  })
})
