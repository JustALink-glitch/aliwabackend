import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Sql } from './db.js'

/**
 * Zoom (F1.07): one Zoom account per organisation, connected with OAuth by an Owner or Admin.
 * The API talks to Zoom only through ZoomApi, so tests use a stand-in.
 */

export interface ZoomTokens {
  accessToken: string
  refreshToken: string
  expiresIn: number
  scopes: string[]
}

export interface MeetingInput {
  topic: string
  startTime: Date
  durationMinutes: number
  timeZone: string
  /** Personal join links: Zoom registers each participant (F1.07 "A personal join link for each participant"). */
  registration: boolean
}

export interface ZoomParticipant {
  name: string
  email: string | null
  joinTime: Date
  leaveTime: Date
  durationSeconds: number
}

export class ZoomError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
  /** Zoom no longer accepts our tokens: the connection needs to be made again. */
  get revoked() {
    return this.code === 'invalid_grant' || this.code === 'invalid_token' || this.status === 401
  }
}

export interface ZoomApi {
  authorizeUrl(state: string): string
  exchangeCode(code: string): Promise<ZoomTokens>
  refresh(refreshToken: string): Promise<ZoomTokens>
  revoke(token: string): Promise<void>
  me(accessToken: string): Promise<{ email: string; accountId: string }>
  createMeeting(accessToken: string, input: MeetingInput): Promise<{ id: string; joinUrl: string }>
  updateMeeting(accessToken: string, meetingId: string, input: MeetingInput): Promise<void>
  deleteMeeting(accessToken: string, meetingId: string): Promise<void>
  addRegistrant(accessToken: string, meetingId: string, person: { email: string; firstName: string; lastName: string }): Promise<{ registrantId: string; joinUrl: string }>
  /** Everyone who joined, one row per join. Null while Zoom is still preparing the report. */
  participants(accessToken: string, meetingId: string): Promise<ZoomParticipant[] | null>
}

/** Talks to zoom.us. */
export function createZoomApi(options: { clientId: string; clientSecret: string; redirectUrl: string; oauthBase?: string; apiBase?: string }): ZoomApi {
  // Overridable for local end-to-end checks against a stand-in; zoom.us otherwise.
  const oauth = (options.oauthBase ?? 'https://zoom.us').replace(/\/$/, '')
  const apiBase = (options.apiBase ?? 'https://api.zoom.us/v2').replace(/\/$/, '')
  const basic = Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64')

  async function token(params: Record<string, string>): Promise<ZoomTokens> {
    const response = await fetch(`${oauth}/oauth/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    })
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
    if (!response.ok) throw new ZoomError(response.status, String(body.error ?? 'oauth_failed'), String(body.reason ?? body.error_description ?? 'Zoom refused the request.'))
    return {
      accessToken: String(body.access_token),
      refreshToken: String(body.refresh_token),
      expiresIn: Number(body.expires_in ?? 3600),
      scopes: String(body.scope ?? '')
        .split(/[\s,]+/)
        .filter(Boolean),
    }
  }

  async function api<T>(accessToken: string, method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
    if (response.status === 204) return undefined as T
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>
    if (!response.ok) {
      const code = response.status === 401 ? 'invalid_token' : String(json.code ?? response.status)
      throw new ZoomError(response.status, code, String(json.message ?? `Zoom returned ${response.status}.`))
    }
    return json as T
  }

  const meetingBody = (input: MeetingInput) => ({
    topic: input.topic.slice(0, 200),
    type: 2,
    start_time: input.startTime.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    duration: input.durationMinutes,
    timezone: input.timeZone,
    settings: {
      approval_type: input.registration ? 0 : 2,
      registration_type: 1,
      join_before_host: true,
      waiting_room: false,
      registrants_email_notification: false,
      registrants_confirmation_email: false,
    },
  })

  return {
    authorizeUrl: (state) =>
      `${oauth}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: options.clientId, redirect_uri: options.redirectUrl, state })}`,
    exchangeCode: (code) => token({ grant_type: 'authorization_code', code, redirect_uri: options.redirectUrl }),
    refresh: (refreshToken) => token({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    async revoke(t) {
      await fetch(`${oauth}/oauth/revoke`, {
        method: 'POST',
        headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: t }),
      }).catch(() => undefined)
    },
    async me(t) {
      const user = await api<{ email: string; account_id: string }>(t, 'GET', '/users/me')
      return { email: user.email, accountId: user.account_id }
    },
    async createMeeting(t, input) {
      const m = await api<{ id: number | string; join_url: string }>(t, 'POST', '/users/me/meetings', meetingBody(input))
      return { id: String(m.id), joinUrl: m.join_url }
    },
    async updateMeeting(t, id, input) {
      await api(t, 'PATCH', `/meetings/${encodeURIComponent(id)}`, meetingBody(input))
    },
    async deleteMeeting(t, id) {
      try {
        await api(t, 'DELETE', `/meetings/${encodeURIComponent(id)}?schedule_for_reminder=false`)
      } catch (error) {
        // Already gone is fine.
        if (!(error instanceof ZoomError && (error.status === 404 || error.code === '3001'))) throw error
      }
    },
    async addRegistrant(t, id, person) {
      const r = await api<{ registrant_id: string; join_url: string }>(t, 'POST', `/meetings/${encodeURIComponent(id)}/registrants`, {
        email: person.email,
        first_name: person.firstName.slice(0, 64),
        last_name: person.lastName.slice(0, 64),
        auto_approve: true,
      })
      return { registrantId: r.registrant_id, joinUrl: r.join_url }
    },
    async participants(t, id) {
      const out: ZoomParticipant[] = []
      let next = ''
      do {
        let page: { participants?: { name: string; user_email?: string; join_time: string; leave_time: string; duration: number }[]; next_page_token?: string }
        try {
          page = await api(t, 'GET', `/report/meetings/${encodeURIComponent(id)}/participants?page_size=300${next ? `&next_page_token=${encodeURIComponent(next)}` : ''}`)
        } catch (error) {
          // The report appears a few minutes after the meeting ends.
          if (error instanceof ZoomError && (error.status === 404 || error.code === '3001' || error.code === '12702')) return null
          throw error
        }
        for (const p of page.participants ?? []) {
          out.push({ name: p.name, email: p.user_email || null, joinTime: new Date(p.join_time), leaveTime: new Date(p.leave_time), durationSeconds: Number(p.duration) || 0 })
        }
        next = page.next_page_token ?? ''
      } while (next)
      return out
    },
  }
}

/** Encrypts tokens at rest. The key comes from the Zoom client secret, so rotating it means reconnecting. */
export function tokenBox(secret: string) {
  const key = Buffer.from(hkdfSync('sha256', secret, 'synqop', 'zoom-tokens', 32))
  const stateKey = Buffer.from(hkdfSync('sha256', secret, 'synqop', 'zoom-state', 32))
  return {
    seal(plain: string) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`
    },
    open(sealed: string) {
      const [v, iv, tag, data] = sealed.split('.')
      if (v !== 'v1' || !iv || !tag || !data) throw new Error('Unreadable token')
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
      decipher.setAuthTag(Buffer.from(tag, 'base64url'))
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8')
    },
    /** The OAuth state: who started connecting, valid 10 minutes, tamper-proof. */
    signState(payload: { organisationId: string; memberId: string }, now = Date.now()) {
      const body = Buffer.from(JSON.stringify({ ...payload, exp: now + 10 * 60_000, n: randomBytes(8).toString('hex') })).toString('base64url')
      return `${body}.${createHmac('sha256', stateKey).update(body).digest('base64url')}`
    },
    readState(state: string, now = Date.now()): { organisationId: string; memberId: string } | null {
      const [body, sig] = state.split('.')
      if (!body || !sig) return null
      const expected = createHmac('sha256', stateKey).update(body).digest('base64url')
      if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
      const data = JSON.parse(Buffer.from(body, 'base64url').toString()) as { organisationId: string; memberId: string; exp: number }
      return data.exp > now ? { organisationId: data.organisationId, memberId: data.memberId } : null
    },
  }
}

export type TokenBox = ReturnType<typeof tokenBox>

export interface ZoomDeps {
  sql: Sql
  zoom: ZoomApi
  box: TokenBox
}

/**
 * Runs `fn` with a valid access token for the organisation, refreshing it when it's about to expire
 * (Zoom rotates the refresh token every time). Marks the connection broken if Zoom rejects it.
 * Returns null when the organisation hasn't connected Zoom or the connection is broken.
 */
export async function withZoom<T>(deps: ZoomDeps, organisationId: string, fn: (accessToken: string) => Promise<T>, now = new Date()): Promise<T | null> {
  const [conn] = await deps.sql<{ refresh_token_enc: string | null; access_token_enc: string | null; access_token_expires_at: Date | null; broken_at: Date | null }[]>`
    select refresh_token_enc, access_token_enc, access_token_expires_at, broken_at from public.zoom_connections where organisation_id = ${organisationId}
  `
  if (!conn || conn.broken_at || !conn.refresh_token_enc) return null
  try {
    let access = conn.access_token_enc && conn.access_token_expires_at && conn.access_token_expires_at.getTime() - now.getTime() > 120_000 ? deps.box.open(conn.access_token_enc) : null
    if (!access) {
      // One refresh at a time: Zoom replaces the refresh token, so a second refresh with the old one would fail.
      access = await deps.sql.begin(async (tx) => {
        const [locked] = await tx<{ refresh_token_enc: string; access_token_enc: string | null; access_token_expires_at: Date | null }[]>`
          select refresh_token_enc, access_token_enc, access_token_expires_at from public.zoom_connections where organisation_id = ${organisationId} for update
        `
        if (locked!.access_token_enc && locked!.access_token_expires_at && locked!.access_token_expires_at.getTime() - now.getTime() > 120_000) return deps.box.open(locked!.access_token_enc)
        const fresh = await deps.zoom.refresh(deps.box.open(locked!.refresh_token_enc))
        await tx`
          update public.zoom_connections set access_token_enc = ${deps.box.seal(fresh.accessToken)}, refresh_token_enc = ${deps.box.seal(fresh.refreshToken)},
            access_token_expires_at = ${new Date(now.getTime() + fresh.expiresIn * 1000)}
          where organisation_id = ${organisationId}
        `
        return fresh.accessToken
      })
    }
    return await fn(access)
  } catch (error) {
    if (error instanceof ZoomError && error.revoked) {
      await deps.sql`
        update public.zoom_connections set broken_at = ${now}, broken_reason = ${'Zoom stopped accepting Synqop’s access. Connect Zoom again in Settings › Attendance & Zoom.'}
        where organisation_id = ${organisationId}
      `
      return null
    }
    throw error
  }
}
