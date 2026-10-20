import type { Context } from 'hono'
import { z } from 'zod'
import { badRequest } from './errors.js'

/** Parses the JSON body against a schema or throws a 400 with field-level details. */
export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  const raw: unknown = await c.req.json().catch(() => {
    throw badRequest('Send a JSON body.')
  })
  const result = schema.safeParse(raw)
  if (!result.success) {
    throw badRequest(
      'Some fields need attention.',
      result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
    )
  }
  return result.data
}

export const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Enter a valid email address.').max(254))

export const personName = z.string().trim().min(1, 'Required.').max(80)

/** Proposal (§12): minimum 10 characters. Bcrypt ignores bytes after 72. */
export const password = z
  .string()
  .min(10, 'Use at least 10 characters.')
  .max(72, 'Use at most 72 characters.')

export const timeZone = z
  .string()
  .refine((value) => Intl.supportedValuesOf('timeZone').includes(value) || value === 'UTC', 'Unknown time zone.')

export const uuid = z.uuid()
