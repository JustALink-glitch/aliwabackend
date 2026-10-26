import { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import { audit } from '../lib/db.js'
import { AppError } from '../lib/errors.js'
import { requireAuth, requireRole, type AuthVariables } from '../middleware/auth.js'

const notSetUp = () => new AppError(409, 'zoom_not_configured', 'Zoom isn’t set up on this server yet. Add the Zoom app keys to the API’s settings first.')

/** /v1/zoom — F1.07 connect and disconnect the organisation's Zoom account (OAuth). */
export function zoomRoutes(deps: AppDeps) {
  const settingsUrl = (result: string) => `${deps.appUrl.replace(/\/$/, '')}/admin/settings/attendance?zoom=${result}`
  const now = () => (deps.now ? deps.now() : new Date())

  return (
    new Hono<{ Variables: AuthVariables }>()
      // Zoom sends the browser back here after the admin approves. The signed state says who started it.
      .get('/callback', async (c) => {
        if (!deps.zoom || !deps.zoomBox) return c.redirect(settingsUrl('not_configured'))
        const state = deps.zoomBox.readState(c.req.query('state') ?? '', now().getTime())
        const code = c.req.query('code')
        if (!state || !code) return c.redirect(settingsUrl(c.req.query('error') === 'access_denied' ? 'cancelled' : 'error'))
        try {
          const tokens = await deps.zoom.exchangeCode(code)
          const me = await deps.zoom.me(tokens.accessToken)
          const box = deps.zoomBox
          await deps.sql.begin(async (tx) => {
            const [member] = await tx`
              select 1 from public.organisation_members where id = ${state.memberId} and organisation_id = ${state.organisationId} and role in ('owner', 'admin') and status = 'active'
            `
            if (!member) throw new Error('Not allowed')
            await tx`
              insert into public.zoom_connections (organisation_id, zoom_account_id, zoom_user_email, refresh_token_enc, access_token_enc, access_token_expires_at, scopes, connected_by, connected_at)
              values (${state.organisationId}, ${me.accountId}, ${me.email}, ${box.seal(tokens.refreshToken)}, ${box.seal(tokens.accessToken)},
                      ${new Date(now().getTime() + tokens.expiresIn * 1000)}, ${tokens.scopes}, ${state.memberId}, ${now()})
              on conflict (organisation_id) do update set
                zoom_account_id = excluded.zoom_account_id, zoom_user_email = excluded.zoom_user_email, refresh_token_enc = excluded.refresh_token_enc,
                access_token_enc = excluded.access_token_enc, access_token_expires_at = excluded.access_token_expires_at, scopes = excluded.scopes,
                connected_by = excluded.connected_by, connected_at = excluded.connected_at, broken_at = null, broken_reason = null
            `
            await audit(tx, {
              organisationId: state.organisationId,
              actorMemberId: state.memberId,
              action: 'zoom.connected',
              entityType: 'organisation',
              entityId: state.organisationId,
              data: { email: me.email },
              requestId: c.var.requestId,
            })
          })
          return c.redirect(settingsUrl('connected'))
        } catch (error) {
          console.error('Zoom connect failed', error)
          return c.redirect(settingsUrl('error'))
        }
      })

      .use(requireAuth(deps), requireRole('owner', 'admin'))

      // Where to send the browser to approve Synqop in Zoom.
      .post('/connect', async (c) => {
        if (!deps.zoom || !deps.zoomBox) throw notSetUp()
        const { organisationId, memberId } = c.var.auth
        return c.json({ url: deps.zoom.authorizeUrl(deps.zoomBox.signState({ organisationId, memberId }, now().getTime())) })
      })

      // Meetings already created stay in Zoom; new online sessions use pasted links until Zoom is connected again.
      .delete('/connection', async (c) => {
        const { organisationId, memberId } = c.var.auth
        const [conn] = await deps.sql<{ refresh_token_enc: string | null }[]>`
          delete from public.zoom_connections where organisation_id = ${organisationId} returning refresh_token_enc
        `
        if (conn?.refresh_token_enc && deps.zoom && deps.zoomBox) {
          try {
            await deps.zoom.revoke(deps.zoomBox.open(conn.refresh_token_enc))
          } catch {
            // Best effort: Zoom forgets the app when the token expires anyway.
          }
        }
        await audit(deps.sql, { organisationId, actorMemberId: memberId, action: 'zoom.disconnected', entityType: 'organisation', entityId: organisationId, requestId: c.var.requestId })
        return c.body(null, 204)
      })
  )
}
