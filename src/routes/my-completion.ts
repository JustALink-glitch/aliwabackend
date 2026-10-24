import { Hono } from 'hono'
import type { AppDeps } from '../app.js'
import { completionFor } from '../lib/completion.js'
import { notFound } from '../lib/errors.js'
import type { AuthVariables } from '../middleware/auth.js'
import { certificateView, issueCertificates } from './completion.js'

/** /v1/my — P7.01 Progress and P7.02 Certificate. Mounted inside myRoutes, which checks the participant. */
export function myCompletionRoutes(deps: AppDeps) {
  return (
    new Hono<{ Variables: AuthVariables }>()
      .get('/progress', async (c) => {
        const auth = c.var.auth
        let { rule, enrolments } = await completionFor(deps.sql, auth.organisationId, { memberId: auth.memberId })
        // The current cohort: one still running first, else the one that ended most recently.
        let mine = enrolments.find((e) => !e.cohort.ended) ?? enrolments[0]
        if (mine && rule.autoIssue && mine.status === 'eligible') {
          await issueCertificates(deps, { organisationId: auth.organisationId, actorMemberId: null, enrolments: [mine], notify: true, requestId: c.var.requestId })
          ;({ rule, enrolments } = await completionFor(deps.sql, auth.organisationId, { enrolmentIds: [mine.enrolmentId] }))
          mine = enrolments[0]
        }
        const [org] = await deps.sql<{ name: string; time_zone: string }[]>`select name, time_zone from public.organisations where id = ${auth.organisationId}`
        if (!mine) return c.json({ organisation: org!.name, timeZone: org!.time_zone, progress: null })
        return c.json({
          organisation: org!.name,
          timeZone: org!.time_zone,
          progress: {
            cohort: mine.cohort,
            status: mine.status,
            requiresApproval: rule.requiresApproval && !rule.autoIssue,
            attendance: mine.attendance,
            submissions: mine.submissions,
            grade: mine.grade,
            review: mine.review,
            certificate: mine.certificate ? { id: mine.certificate.id, issuedAt: mine.certificate.issuedAt } : null,
          },
        })
      })

      .get('/certificate', async (c) => {
        const auth = c.var.auth
        const certificate = await certificateView(deps.sql, auth.organisationId, { memberId: auth.memberId })
        if (!certificate) throw notFound('You don’t have a certificate yet.')
        const [org] = await deps.sql<{ time_zone: string }[]>`select time_zone from public.organisations where id = ${auth.organisationId}`
        return c.json({ certificate, timeZone: org!.time_zone })
      })
  )
}
