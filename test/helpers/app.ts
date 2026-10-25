import { createApp } from '../../src/app.js'
import { createMembershipLoader } from '../../src/lib/auth.js'
import type { AuthAdmin } from '../../src/lib/auth-admin.js'
import type { Sql } from '../../src/lib/db.js'
import type { EmailMessage, Mailer } from '../../src/lib/mailer.js'
import type { FileStorage } from '../../src/lib/storage.js'

/** Supabase Auth stand-in backed by the stub auth.users table. */
export function fakeAuthAdmin(sql: Sql) {
  const passwords = new Map<string, string>()
  const deleted: string[] = []
  const recoveryLinks: { email: string; redirectTo: string }[] = []
  const admin: AuthAdmin = {
    async findUserIdByEmail(email) {
      const [row] = await sql<{ id: string }[]>`select id from auth.users where lower(email) = ${email.toLowerCase()}`
      return row?.id ?? null
    },
    async createUser({ email, password }) {
      const [existing] = await sql`select 1 from auth.users where lower(email) = ${email.toLowerCase()}`
      if (existing) return { ok: false, reason: 'email_exists' }
      const [row] = await sql<{ id: string }[]>`insert into auth.users (email) values (${email}) returning id`
      passwords.set(row!.id, password)
      return { ok: true, userId: row!.id }
    },
    async setPassword(userId, password) {
      passwords.set(userId, password)
      return { ok: true }
    },
    async deleteUser(userId) {
      deleted.push(userId)
      await sql`delete from auth.users where id = ${userId}`
    },
    async generateRecoveryLink(email, redirectTo) {
      const [row] = await sql`select id from auth.users where lower(email) = ${email.toLowerCase()}`
      if (!row) return null
      recoveryLinks.push({ email, redirectTo })
      return `https://auth.example/verify?type=recovery&token=fake&redirect_to=${encodeURIComponent(redirectTo)}`
    },
  }
  return { admin, passwords, deleted, recoveryLinks }
}

export function fakeMailer() {
  const sent: EmailMessage[] = []
  const mailer: Mailer = {
    async send(message) {
      sent.push(message)
    },
  }
  /** The invitation token from the most recent email to `to`. */
  const lastToken = (to: string) => {
    const message = [...sent].reverse().find((m) => m.to === to)
    const match = message?.text.match(/\/invite\/([A-Za-z0-9_-]{43})/)
    if (!match) throw new Error(`No invitation email to ${to}`)
    return match[1]!
  }
  return { mailer, sent, lastToken }
}

/** In-memory storage. Tests "upload" with `put` after asking the API for an upload URL. */
export function fakeStorage() {
  const objects = new Map<string, { size: number; type: string | null }>()
  const removed: string[] = []
  const storage: FileStorage = {
    async createUpload(path) {
      return { path, token: `token-${path}`, signedUrl: `https://storage.example/upload/${path}?token=t` }
    },
    async stat(path) {
      return objects.get(path) ?? null
    },
    async downloadUrl(path, fileName) {
      return `https://storage.example/download/${path}?download=${encodeURIComponent(fileName)}`
    },
    async remove(paths) {
      for (const p of paths) {
        objects.delete(p)
        removed.push(p)
      }
    },
    async read(path) {
      const o = objects.get(path)
      return o ? new Uint8Array(o.size).fill(120) : null
    },
  }
  const put = (path: string, size = 1024, type: string | null = 'application/pdf') => objects.set(path, { size, type })
  return { storage, put, objects, removed }
}

/**
 * App wired to a real test database. Tokens are "user:<uuid>:<email>" so tests can act as anyone.
 */
export function testApp(sql: Sql, options: { now?: () => Date } = {}) {
  const auth = fakeAuthAdmin(sql)
  const mail = fakeMailer()
  const files = fakeStorage()
  const app = createApp({
    corsOrigins: ['http://localhost:5173'],
    appUrl: 'http://localhost:5173',
    awaitJobs: true,
    sql,
    verifyToken: async (token) => {
      const [kind, userId, email] = token.split(':')
      return kind === 'user' && userId ? { userId, email: email ?? null } : null
    },
    loadMembership: createMembershipLoader(sql),
    authAdmin: auth.admin,
    mailer: mail.mailer,
    storage: files.storage,
    log: false,
    ...(options.now && { now: options.now }),
  })
  return { app, auth, mail, files }
}

export const as = (userId: string, email: string) => `user:${userId}:${email}`

type Json = Record<string, unknown>

/** Small request helper: JSON in, { status, body } out. */
export function client(app: ReturnType<typeof createApp>) {
  return async (method: string, path: string, options: { token?: string; body?: unknown } = {}) => {
    const res = await app.request(path, {
      method,
      headers: {
        ...(options.body !== undefined && { 'Content-Type': 'application/json' }),
        ...(options.token && { Authorization: `Bearer ${options.token}` }),
      },
      ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
    })
    const text = await res.text()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (text ? JSON.parse(text) : {}) as any as Json & { error?: { code: string; message: string; details?: unknown } }
    return { status: res.status, body }
  }
}
