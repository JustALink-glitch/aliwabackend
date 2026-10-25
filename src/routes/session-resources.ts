import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { notify } from '../lib/notifications.js'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import type { AuthContext } from '../lib/auth.js'
import { audit, type Sql } from '../lib/db.js'
import { AppError, forbidden, notFound } from '../lib/errors.js'
import { can, staffScope } from '../lib/staff.js'
import { MAX_FILE_BYTES, safeFileName } from '../lib/storage.js'
import { parseBody, uuid } from '../lib/validation.js'
import type { AuthVariables } from '../middleware/auth.js'

const Upload = z.object({
  name: z.string().trim().min(1).max(200),
  size: z.number().int().min(1, 'This file is empty.').max(MAX_FILE_BYTES, 'Files can be up to 25 MB.'),
  type: z.string().max(200).nullish(),
})

const Resource = z
  .object({
    kind: z.enum(['file', 'link']),
    name: z.string().trim().min(1, 'Enter a title.').max(200),
    url: z
      .string()
      .trim()
      .max(1000)
      .nullish()
      .transform((v) => v || null),
    path: z.string().max(500).nullish(),
    /** Show on this session only, or on every session of the course. */
    scope: z.enum(['session', 'course']).default('session'),
    visible: z.boolean().default(true),
  })
  .refine((v) => v.kind !== 'link' || (v.url && /^https?:\/\/\S+$/.test(v.url)), { path: ['url'], message: 'Paste the full link, starting with https://' })
  .refine((v) => v.kind !== 'file' || Boolean(v.path), { path: ['path'], message: 'Choose a file.' })

const fieldError = (field: string, message: string) => new AppError(400, 'bad_request', 'Some fields need attention.', [{ field, message }])

export interface ResourceRow {
  id: string
  kind: 'file' | 'link'
  name: string
  url: string | null
  size_bytes: string | null
  mime_type: string | null
  session_id: string | null
  visible_to_participants: boolean
  added_by: string | null
  by_first: string | null
  by_last: string | null
  created_at: Date
}

/** Resources shown on a session: its own, plus the course-wide ones. */
export function sessionResources(sql: Sql, sessionId: string, cohortCourseId: string) {
  return sql<ResourceRow[]>`
    select r.id, r.kind, r.name, r.url, r.size_bytes, r.mime_type, r.session_id, r.visible_to_participants, r.added_by,
           m.first_name as by_first, m.last_name as by_last, r.created_at
    from public.resources r left join public.organisation_members m on m.id = r.added_by
    where r.cohort_course_id = ${cohortCourseId} and (r.session_id = ${sessionId} or r.session_id is null)
    order by r.created_at desc
  `
}

export const toResource = (r: ResourceRow, me: string) => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  url: r.url,
  size: r.size_bytes === null ? null : Number(r.size_bytes),
  type: r.mime_type,
  wholeCourse: r.session_id === null,
  visible: r.visible_to_participants,
  addedBy: r.added_by === me ? 'you' : r.by_first ? `${r.by_first} ${r.by_last ?? ''}`.trim() : null,
  addedAt: r.created_at,
})

/** /v1/sessions/:id/resources — T8.01 Add a resource (and C1.03 for admins). */
export function sessionResourceRoutes(deps: AppDeps) {
  const prefix = (organisationId: string) => `${organisationId}/resources/`

  async function findSession(auth: AuthContext, id: string, write: boolean) {
    if (!uuid.safeParse(id).success) throw notFound('Session not found.')
    const [row] = await deps.sql<{ id: string; cohort_course_id: string }[]>`
      select id, cohort_course_id from public.sessions where id = ${id} and organisation_id = ${auth.organisationId}
    `
    if (!row) throw notFound('Session not found.')
    const allowed = can(await staffScope(deps.sql, auth), row.cohort_course_id)
    if (!allowed.see) throw notFound('Session not found.')
    if (write && !allowed.resources) throw forbidden('Your organisation doesn’t let assistant trainers add resources.')
    return row
  }

  return (
    new Hono<{ Variables: AuthVariables }>()
      .post('/:id/resources/uploads', async (c) => {
        const body = await parseBody(c, Upload)
        await findSession(c.var.auth, c.req.param('id'), true)
        const path = `${prefix(c.var.auth.organisationId)}${randomUUID()}/${safeFileName(body.name)}`
        return c.json({ upload: await deps.storage.createUpload(path) })
      })

      .post('/:id/resources', async (c) => {
        const body = await parseBody(c, Resource)
        const auth = c.var.auth
        const session = await findSession(auth, c.req.param('id'), true)
        let size: number | null = null
        let type: string | null = null
        if (body.kind === 'file') {
          if (!body.path!.startsWith(prefix(auth.organisationId)) || body.path!.includes('..')) throw fieldError('path', 'Choose the file again.')
          const stat = await deps.storage.stat(body.path!)
          if (!stat) throw fieldError('path', 'The file didn’t finish uploading. Choose it again.')
          if (stat.size > MAX_FILE_BYTES) throw fieldError('path', 'Files can be up to 25 MB.')
          size = stat.size
          type = stat.type
        }
        const id = await deps.sql.begin(async (tx) => {
          const [row] = await tx<{ id: string }[]>`
            insert into public.resources (organisation_id, cohort_course_id, session_id, kind, name, url, storage_path, size_bytes, mime_type, visible_to_participants, added_by)
            values (${auth.organisationId}, ${session.cohort_course_id}, ${body.scope === 'session' ? session.id : null}, ${body.kind}, ${body.name},
                    ${body.kind === 'link' ? body.url : null}, ${body.kind === 'file' ? body.path! : null}, ${size}, ${type}, ${body.visible}, ${auth.memberId})
            returning id
          `
          await audit(tx, { organisationId: auth.organisationId, actorMemberId: auth.memberId, action: 'resource.added', entityType: 'session', entityId: session.id, data: { kind: body.kind, scope: body.scope }, requestId: c.var.requestId })
          if (body.visible) {
            const [where] = await tx<{ course: string; people: string[] }[]>`
              select co.name as course, coalesce(array_agg(e.member_id) filter (where e.member_id is not null), '{}') as people
              from public.cohort_courses x join public.courses co on co.id = x.course_id
              left join public.enrolments e on e.cohort_id = x.cohort_id and e.status = 'active'
              where x.id = ${session.cohort_course_id} group by co.name
            `
            await notify(tx, {
              organisationId: auth.organisationId,
              to: { memberIds: where!.people },
              event: 'new_resource',
              title: `New resource: ${body.name}`,
              body: where!.course,
              link: body.scope === 'session' ? `/participant/sessions/${session.id}` : `/participant/courses/${session.cohort_course_id}`,
            })
          }
          return row!.id
        })
        return c.json({ resource: { id } }, 201)
      })

      .get('/:id/resources/:resourceId', async (c) => {
        const session = await findSession(c.var.auth, c.req.param('id'), false)
        const resourceId = c.req.param('resourceId')
        if (!uuid.safeParse(resourceId).success) throw notFound('Resource not found.')
        const [r] = await deps.sql<{ name: string; storage_path: string | null; url: string | null }[]>`
          select name, storage_path, url from public.resources where id = ${resourceId} and cohort_course_id = ${session.cohort_course_id}
        `
        if (!r) throw notFound('Resource not found.')
        return c.json({ url: r.storage_path ? await deps.storage.downloadUrl(r.storage_path, r.name) : r.url })
      })
  )
}
