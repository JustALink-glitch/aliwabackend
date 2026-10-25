import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { buildDataExport, EXPORT_PARTS, includesLabel } from '../lib/data-export.js'
import { audit } from '../lib/db.js'
import { AppError, notFound } from '../lib/errors.js'
import { renderEmail } from '../lib/mailer.js'
import { shortName } from '../lib/names.js'
import { parseBody, uuid } from '../lib/validation.js'
import { createZip } from '../lib/zip.js'
import { requireAuth, requireRole, type AuthVariables } from '../middleware/auth.js'

const EXPORT_DAYS = 7
const DELETION_DAYS = 30

const RequestExport = z.object({
  parts: z
    .array(z.enum(EXPORT_PARTS))
    .min(1, 'Choose at least one thing to export.')
    .transform((p) => EXPORT_PARTS.filter((x) => p.includes(x))),
})

const ScheduleDeletion = z.object({
  /** "I've exported the data we need to keep". */
  exported: z.literal(true, { error: 'Confirm you’ve exported what you need.' }),
  confirmName: z.string().trim(),
})

interface ExportRow {
  id: string
  status: 'queued' | 'running' | 'ready' | 'failed' | 'expired'
  parts: string[]
  created_at: Date
  completed_at: Date | null
  expires_at: Date | null
  size_bytes: string | null
  file_name: string | null
  by_first: string | null
  by_last: string | null
}

/** /v1/privacy — F1.10 Data & privacy and F1.11 Delete organisation. Owners act; admins can look. */
export function privacyRoutes(deps: AppDeps) {
  const now = () => (deps.now ? deps.now() : new Date())
  const appUrl = deps.appUrl.replace(/\/$/, '')
  const settingsLink = `${appUrl}/admin/settings/privacy`

  const ownerOnly = (role: string) => {
    if (role !== 'owner') throw new AppError(403, 'owner_only', 'Only the owner can do this.')
  }

  async function view(organisationId: string) {
    // Links last 7 days; then the file is dropped.
    await deps.sql`
      update public.data_exports set status = 'expired', content = null
      where organisation_id = ${organisationId} and status = 'ready' and expires_at <= ${now()}
    `
    const [exports, [org]] = await Promise.all([
      deps.sql<ExportRow[]>`
        select e.id, e.status, e.parts, e.created_at, e.completed_at, e.expires_at, e.size_bytes::text, e.file_name, m.first_name as by_first, m.last_name as by_last
        from public.data_exports e left join public.organisation_members m on m.id = e.requested_by
        where e.organisation_id = ${organisationId} order by e.created_at desc limit 20
      `,
      deps.sql<{ name: string; time_zone: string; status: string; scheduled_for: Date | null; requested_at: Date | null; by_first: string | null; by_last: string | null }[]>`
        select o.name, o.time_zone, o.status, o.deletion_scheduled_for as scheduled_for, o.deletion_requested_at as requested_at, m.first_name as by_first, m.last_name as by_last
        from public.organisations o left join public.organisation_members m on m.id = o.deletion_requested_by where o.id = ${organisationId}
      `,
    ])
    return {
      organisation: org!.name,
      timeZone: org!.time_zone,
      exports: exports.map((e) => ({
        id: e.id,
        status: e.status,
        parts: e.parts,
        includes: includesLabel(e.parts),
        requestedAt: e.created_at,
        requestedBy: shortName(e.by_first, e.by_last),
        completedAt: e.completed_at,
        expiresAt: e.expires_at,
        sizeBytes: e.size_bytes === null ? null : Number(e.size_bytes),
        fileName: e.file_name,
      })),
      deletion:
        org!.status === 'pending_deletion'
          ? { scheduledFor: org!.scheduled_for, requestedAt: org!.requested_at, requestedBy: shortName(org!.by_first, org!.by_last) }
          : null,
    }
  }

  /** Builds the ZIP after the request returns, then emails the person who asked (X2.07). */
  async function runExport(id: string, organisationId: string) {
    try {
      await deps.sql`update public.data_exports set status = 'running' where id = ${id}`
      const [job] = await deps.sql<{ parts: string[]; email: string | null; first_name: string | null }[]>`
        select e.parts, m.email, m.first_name from public.data_exports e left join public.organisation_members m on m.id = e.requested_by where e.id = ${id}
      `
      const { organisationName, files } = await buildDataExport(deps.sql, deps.storage, organisationId, job!.parts)
      const zip = createZip(files, now())
      const day = now().toISOString().slice(0, 10)
      const fileName = `${organisationName.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'Synqop'} data export ${day}.zip`
      const expires = new Date(now().getTime() + EXPORT_DAYS * 86_400_000)
      await deps.sql`
        update public.data_exports set status = 'ready', content = ${zip}, file_name = ${fileName}, size_bytes = ${zip.length},
          completed_at = ${now()}, expires_at = ${expires}, error = null
        where id = ${id}
      `
      if (job!.email) {
        const { text, html } = renderEmail({
          title: 'Your data export is ready',
          intro: `Hi ${job!.first_name ?? 'there'}, the export of ${organisationName}’s data you asked for is ready to download.`,
          buttonLabel: 'Download export',
          buttonUrl: settingsLink,
          note: `The download works for ${EXPORT_DAYS} days. You’ll need to sign in as the owner.`,
        })
        await deps.mailer.send({ to: job!.email, subject: `${organisationName} data export is ready`, text, html }).catch((e) => console.error('Export email failed', e))
      }
    } catch (error) {
      console.error('Data export failed', error)
      await deps.sql`update public.data_exports set status = 'failed', error = ${(error as Error).message.slice(0, 500)}, completed_at = ${now()} where id = ${id}`.catch(
        () => undefined,
      )
    }
  }

  /** X2.08 to owners and admins, X2.09 to everyone else. Best effort: a failed email doesn't undo the schedule. */
  async function tellEveryone(organisationId: string, organisationName: string, when: string) {
    const people = await deps.sql<{ email: string; first_name: string; role: string }[]>`
      select email, first_name, role from public.organisation_members where organisation_id = ${organisationId} and status = 'active'
    `
    await Promise.all(
      people.map(async (p) => {
        const staff = p.role === 'owner' || p.role === 'admin'
        const { text, html } = renderEmail(
          staff
            ? {
                title: `${organisationName} is scheduled for deletion`,
                intro: `Hi ${p.first_name}, ${organisationName}’s Synqop workspace will be permanently deleted on ${when}. Until then it’s read-only. An owner can export data or cancel the deletion.`,
                buttonLabel: 'Open Data & privacy',
                buttonUrl: settingsLink,
              }
            : {
                title: `${organisationName} is closing its Synqop workspace`,
                intro: `Hi ${p.first_name}, ${organisationName} is closing its workspace on ${when}. Until then you can still sign in to read and download your own records, such as grades and certificates.`,
                buttonLabel: 'Sign in',
                buttonUrl: `${appUrl}/sign-in`,
              },
        )
        await deps.mailer
          .send({ to: p.email, subject: staff ? `${organisationName} is scheduled for deletion` : `${organisationName} is closing its workspace on ${when}`, text, html })
          .catch((e) => console.error('Deletion email failed', e))
      }),
    )
  }

  return (
    new Hono<{ Variables: AuthVariables }>()
      .use(requireAuth(deps), requireRole('owner', 'admin'))

      .get('/', async (c) => c.json({ ...(await view(c.var.auth.organisationId)), canManage: c.var.auth.role === 'owner' }))

      // F1.10 Request export → F1.10l Preparing.
      .post('/exports', async (c) => {
        const { organisationId, memberId, role } = c.var.auth
        ownerOnly(role)
        const body = await parseBody(c, RequestExport)
        const [running] = await deps.sql`select 1 from public.data_exports where organisation_id = ${organisationId} and status in ('queued', 'running')`
        if (running) throw new AppError(409, 'export_in_progress', 'An export is already being prepared.')
        const [row] = await deps.sql<{ id: string }[]>`
          insert into public.data_exports (organisation_id, requested_by, parts) values (${organisationId}, ${memberId}, ${body.parts}) returning id
        `
        await audit(deps.sql, { organisationId, actorMemberId: memberId, action: 'data.exported', entityType: 'organisation', entityId: organisationId, data: { parts: body.parts }, requestId: c.var.requestId })
        const job = runExport(row!.id, organisationId)
        if (deps.awaitJobs) await job
        return c.json({ export: { id: row!.id } }, 202)
      })

      .get('/exports/:id/file', async (c) => {
        const { organisationId, memberId, role } = c.var.auth
        ownerOnly(role)
        const id = c.req.param('id')
        if (!uuid.safeParse(id).success) throw notFound('Export not found.')
        const [e] = await deps.sql<{ status: string; content: Buffer | null; file_name: string | null; expires_at: Date | null }[]>`
          select status, content, file_name, expires_at from public.data_exports where id = ${id} and organisation_id = ${organisationId}
        `
        if (!e) throw notFound('Export not found.')
        if (e.status !== 'ready' || !e.content || !e.expires_at || e.expires_at <= now())
          throw new AppError(409, 'not_ready', e.status === 'ready' || e.status === 'expired' ? 'This export has expired. Request a new one.' : 'This export isn’t ready yet.')
        await audit(deps.sql, { organisationId, actorMemberId: memberId, action: 'data.export_downloaded', entityType: 'organisation', entityId: organisationId, data: { exportId: id }, requestId: c.var.requestId })
        const name = e.file_name ?? 'export.zip'
        return new Response(new Uint8Array(e.content), {
          headers: {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '-').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
            'Cache-Control': 'private, no-store',
          },
        })
      })

      // F1.11 Delete organisation: read-only now, deleted after 30 days.
      .post('/deletion', async (c) => {
        const { organisationId, memberId, role } = c.var.auth
        ownerOnly(role)
        const body = await parseBody(c, ScheduleDeletion)
        const [org] = await deps.sql<{ name: string; status: string; time_zone: string }[]>`select name, status, time_zone from public.organisations where id = ${organisationId}`
        if (org!.status === 'pending_deletion') throw new AppError(409, 'already_scheduled', 'Deletion is already scheduled.')
        if (body.confirmName !== org!.name)
          throw new AppError(400, 'bad_request', 'Some fields need attention.', [{ field: 'confirmName', message: `Type ${org!.name} exactly as shown.` }])
        const at = now()
        const when = new Date(at.getTime() + DELETION_DAYS * 86_400_000)
        await deps.sql.begin(async (tx) => {
          await tx`
            update public.organisations set status = 'pending_deletion', deletion_scheduled_for = ${when}, deletion_requested_at = ${at}, deletion_requested_by = ${memberId}
            where id = ${organisationId}
          `
          await audit(tx, { organisationId, actorMemberId: memberId, action: 'organisation.deletion_scheduled', entityType: 'organisation', entityId: organisationId, data: { scheduledFor: when.toISOString() }, requestId: c.var.requestId })
        })
        const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: org!.time_zone }).format(when)
        const emails = tellEveryone(organisationId, org!.name, day)
        if (deps.awaitJobs) await emails
        return c.json(await view(organisationId))
      })

      .delete('/deletion', async (c) => {
        const { organisationId, memberId, role } = c.var.auth
        ownerOnly(role)
        const [org] = await deps.sql<{ status: string }[]>`select status from public.organisations where id = ${organisationId}`
        if (org!.status !== 'pending_deletion') throw new AppError(409, 'not_scheduled', 'Deletion isn’t scheduled.')
        await deps.sql.begin(async (tx) => {
          await tx`
            update public.organisations set status = 'active', deletion_scheduled_for = null, deletion_requested_at = null, deletion_requested_by = null
            where id = ${organisationId}
          `
          await audit(tx, { organisationId, actorMemberId: memberId, action: 'organisation.deletion_cancelled', entityType: 'organisation', entityId: organisationId, requestId: c.var.requestId })
        })
        return c.json(await view(organisationId))
      })
  )
}
