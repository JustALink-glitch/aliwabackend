import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTokenVerifier } from '../src/lib/auth.js'
import { loadEnv } from '../src/env.js'

// A stand-in for a Supabase project: serves its signing key at the JWKS path.
let server: Server
let baseUrl: string
let privateKey: CryptoKey
let otherKey: CryptoKey

beforeAll(async () => {
  const pair = await generateKeyPair('ES256')
  privateKey = pair.privateKey
  otherKey = (await generateKeyPair('ES256')).privateKey
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' }

  server = createServer((req, res) => {
    if (req.url === '/auth/v1/.well-known/jwks.json') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ keys: [jwk] }))
    } else {
      res.statusCode = 404
      res.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

function token(opts: { key?: CryptoKey; issuer?: string; audience?: string; expiresIn?: string } = {}) {
  return new SignJWT({ email: 'ada@aliwa.org', role: 'authenticated' })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setSubject('user-1')
    .setIssuer(opts.issuer ?? `${baseUrl}/auth/v1`)
    .setAudience(opts.audience ?? 'authenticated')
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '1h')
    .sign(opts.key ?? privateKey)
}

describe('createTokenVerifier', () => {
  it('accepts a token signed by the project key', async () => {
    const verify = createTokenVerifier(baseUrl)
    expect(await verify(await token())).toEqual({ userId: 'user-1', email: 'ada@aliwa.org' })
  })

  it('rejects a token signed by another key', async () => {
    expect(await createTokenVerifier(baseUrl)(await token({ key: otherKey }))).toBeNull()
  })

  it('rejects another issuer', async () => {
    const verify = createTokenVerifier(baseUrl)
    expect(await verify(await token({ issuer: 'https://other.supabase.co/auth/v1' }))).toBeNull()
  })

  it('rejects the wrong audience', async () => {
    expect(await createTokenVerifier(baseUrl)(await token({ audience: 'anon' }))).toBeNull()
  })

  it('rejects an expired token', async () => {
    expect(await createTokenVerifier(baseUrl)(await token({ expiresIn: '-1m' }))).toBeNull()
  })

  it('rejects garbage', async () => {
    expect(await createTokenVerifier(baseUrl)('not-a-jwt')).toBeNull()
  })
})

describe('loadEnv', () => {
  it('parses a valid environment', () => {
    const env = loadEnv({
      SUPABASE_URL: 'http://127.0.0.1:54321',
      SUPABASE_SECRET_KEY: 'secret',
      DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/postgres',
      CORS_ORIGINS: 'http://localhost:5173/, https://app.synqop.com',
    })
    expect(env.PORT).toBe(5000)
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173', 'https://app.synqop.com'])
  })

  it('fails fast with a readable message', () => {
    expect(() => loadEnv({})).toThrow(/SUPABASE_URL/)
  })

  it('requires an email provider in production', () => {
    expect(() =>
      loadEnv({
        NODE_ENV: 'production',
        SUPABASE_URL: 'https://x.supabase.co',
        SUPABASE_SECRET_KEY: 's',
        DATABASE_URL: 'postgres://u:p@h:5432/db',
      }),
    ).toThrow(/RESEND_API_KEY/)
  })
})
