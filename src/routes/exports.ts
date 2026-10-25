import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { audit } from '../lib/db.js'
import { AppError, notFound } from '../lib/errors.js'
import { buildReport, kindLabel, periodLabel, renderCsv, renderPdf, REPORT_KINDS, type ReportKind, type ReportParams } from '../lib/exports.js'
import { isoDate, parseBody, uuid } from '../lib/validation.js'
import { requireAuth, requireRole, type AuthVariables } from '../middleware/auth.js'

const COHORT_KINDS: ReportKind[] = ['cohort_summary', 'attendance', 'assignments']

const Generate = z
  .object({
    kind: z.enum(REPORT_KINDS),
    programmeId: uuid,
    cohortId: uuid.nullish().transform((v) => v ?? null),
    from: isoDate.nullish().transform((v) => v ?? null),
    to: isoDate.nullish().transform((v) => v ?? null),
    format: z.enum(['pdf', 'csv']),
  })
  .refine((v) => !COHORT_KINDS.includes(v.kind) || v.cohortId, { path: ['cohortId'], message: 'Choose a cohort.' })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { path: ['to'], message: 'Choose a date on or after the start.' })

interface Row {
  id: string
  kind: ReportKind
  parameters: ReportParams
  status: 'queued' | 'running' | 'ready' | 'failed' | 'expired'
  format: 'pdf' | 'csv'
  title: string | null
  subtitle: string | null
  error: string | null
  created_at: Date
  completed_at: Date | null
  by_id: string | null
  by_first: string | null
  by_last: string | null
}

/** /v1/reports — E1 Reports: generate a PDF or CSV from data already captured (owners and admins). */
export function exportRoutes(deps: AppDeps) {
  /** Builds the file. Runs after the request returns; the list shows Generating… until it's done. */
  async function generate(id: string, organisationId: string) {
    try {
      await deps.sql`update public.generated_reports set status = 'running' where id = ${id}`
      const [job] = await deps.sql<{ parameters: ReportParams; format: 'pdf' | 'csv'; title: string }[]>`
        select parameters, format, title from public.generated_reports where id = ${id}
      `
      const doc = await buildReport(deps.sql, organisationId, job!.parameters)
      const [org] = await deps.sql<{ time_zone: string }[]>`select time_zone from public.organisations where id = ${organisationId}`
      const stamp = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: org!.time_zone }).format(new Date())
      const content = job!.format === 'csv' ? renderCsv(doc) : await renderPdf(doc, stamp)
      const fileName = `${doc.title.replace(/\s*[—–]\s*/g, ' - ').replace(/[^\p{L}\p{N} _-]+/gu, '').replace(/\s+/g, ' ').trim()}.${job!.format}`
      await deps.sql`
        update public.generated_reports set status = 'ready', content = ${content}, file_name = ${fileName}, completed_at = now(), error = null where id = ${id}
      `
    } catch (error) {
      console.error('Report failed', error)
      await deps.sql`update public.generated_reports set status = 'failed', error = ${(error as Error).message.slice(0, 500)}, completed_at = now() where id = ${id}`.catch(() => undefined)
    }
  }

  async function start(organisationId: string, memberId: string, params: ReportParams, format: 'pdf' | 'csv', requestId: string | undefined) {
    const [programme] = await deps.sql<{ name: string }[]>`select name from public.programmes where id = ${params.programmeId} and organisation_id = ${organisationId}`
    if (!programme) throw new AppError(400, 'bad_request', 'Some fields need attention.', [{ field: 'programmeId', message: 'Choose a programme.' }])
    let scopeName = programme.name
    if (params.cohortId) {
      const [cohort] = await deps.sql<{ name: string }[]>`select name from public.cohorts where id = ${params.cohortId} and programme_id = ${params.programmeId}`
      if (!cohort) throw new AppError(400, 'bad_request', 'Some fields need attention.', [{ field: 'cohortId', message: 'Choose a cohort in this programme.' }])
      scopeName = cohort.name
    }
    const [row] = await deps.sql<{ id: string }[]>`
      insert into public.generated_reports (organisation_id, requested_by, kind, parameters, format, title, subtitle)
      values (${organisationId}, ${memberId}, ${params.kind}, ${deps.sql.json(params as never)}, ${format}, ${`${kindLabel[params.kind]} — ${scopeName}`}, ${periodLabel(params.from, params.to)})
      returning id
    `
    await audit(deps.sql, { organisationId, actorMemberId: memberId, action: 'report.generated', entityType: 'report', entityId: row!.id, data: { kind: params.kind, format }, requestId })
    const job = generate(row!.id, organisationId)
    // Tests (and anything else that wants the result) can wait for it.
    if (deps.awaitJobs) await job
    return row!.id
  }

  return (
    new Hono<{ Variables: AuthVariables }>()
      .use(requireAuth(deps), requireRole('owner', 'admin'))

      // E1.01 Generated reports, newest first.
      .get('/', async (c) => {
        const { organisationId } = c.var.auth
        const [rows, [org]] = await Promise.all([
          deps.sql<Row[]>`
            select r.id, r.kind, r.parameters, r.status, r.format, r.title, r.subtitle, r.error, r.created_at, r.completed_at,
                   m.id as by_id, m.first_name as by_first, m.last_name as by_last
            from public.generated_reports r left join public.organisation_members m on m.id = r.requested_by
            where r.organisation_id = ${organisationId}
            order by r.created_at desc
            limit 200
          `,
          deps.sql<{ time_zone: string }[]>`select time_zone from public.organisations where id = ${organisationId}`,
        ])
        return c.json({
          timeZone: org!.time_zone,
          reports: rows.map((r) => ({
            id: r.id,
            kind: r.kind,
            title: r.title ?? kindLabel[r.kind],
            subtitle: r.subtitle,
            format: r.format,
            status: r.status,
            parameters: r.parameters,
            by: r.by_id ? { id: r.by_id, name: `${r.by_first} ${(r.by_last ?? '').charAt(0)}.`.trim() } : null,
            createdAt: r.created_at,
            completedAt: r.completed_at,
          })),
        })
      })

      // E1.02 Generate report.
      .post('/', async (c) => {
        const body = await parseBody(c, Generate)
        const { organisationId, memberId } = c.var.auth
        const id = await start(organisationId, memberId, { kind: body.kind, programmeId: body.programmeId, cohortId: body.cohortId, from: body.from, to: body.to }, body.format, c.var.requestId)
        return c.json({ report: { id } }, 202)
      })

      // E1.05 Try again with the same choices.
      .post('/:id/retry', async (c) => {
        const { organisationId, memberId } = c.var.auth
        const id = c.req.param('id')
        if (!uuid.safeParse(id).success) throw notFound('Report not found.')
        const [old] = await deps.sql<{ parameters: ReportParams; format: 'pdf' | 'csv' }[]>`
          select parameters, format from public.generated_reports where id = ${id} and organisation_id = ${organisationId}
        `
        if (!old) throw notFound('Report not found.')
        await deps.sql`delete from public.generated_reports where id = ${id} and status = 'failed'`
        const next = await start(organisationId, memberId, old.parameters, old.format, c.var.requestId)
        return c.json({ report: { id: next } }, 202)
      })

      // E1.04 Download.
      .get('/:id/file', async (c) => {
        const { organisationId, memberId } = c.var.auth
        const id = c.req.param('id')
        if (!uuid.safeParse(id).success) throw notFound('Report not found.')
        const [r] = await deps.sql<{ status: string; content: Buffer | null; file_name: string | null; format: 'pdf' | 'csv' }[]>`
          select status, content, file_name, format from public.generated_reports where id = ${id} and organisation_id = ${organisationId}
        `
        if (!r) throw notFound('Report not found.')
        if (r.status !== 'ready' || !r.content) throw new AppError(409, 'not_ready', 'This report isn’t ready yet.')
        await audit(deps.sql, { organisationId, actorMemberId: memberId, action: 'report.downloaded', entityType: 'report', entityId: id, requestId: c.var.requestId })
        const name = r.file_name ?? `report.${r.format}`
        return new Response(new Uint8Array(r.content), {
          headers: {
            'Content-Type': r.format === 'pdf' ? 'application/pdf' : 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '-').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
            'Cache-Control': 'private, no-store',
          },
        })
      })
  )
}
