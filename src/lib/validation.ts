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

/**
 * One "Full name" field (R1.01, T1.01), stored as first + last name.
 * The last word is the last name; everything before it is the first name.
 */
export const fullName = z
  .string()
  .trim()
  .transform((value) => value.replace(/\s+/g, ' '))
  .pipe(
    z
      .string()
      .min(1, 'Enter your full name.')
      .max(160)
      .refine((value) => value.includes(' '), 'Enter your first and last name.'),
  )
  .transform((value) => {
    const cut = value.lastIndexOf(' ')
    return { firstName: value.slice(0, cut).slice(0, 80), lastName: value.slice(cut + 1).slice(0, 80) }
  })

/** Proposal (§12): minimum 10 characters. Bcrypt ignores bytes after 72. */
export const password = z
  .string()
  .min(10, 'Use at least 10 characters.')
  .max(72, 'Use at most 72 characters.')

export const timeZone = z
  .string()
  .refine((value) => Intl.supportedValuesOf('timeZone').includes(value) || value === 'UTC', 'Unknown time zone.')

export const uuid = z.uuid()

/** A calendar date, "2026-10-05". Cohort dates are dates in the organisation's time zone. */
export const isoDate = z.iso.date('Enter a date.')

/** Optional free text: blank becomes null. */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value ? value : null))
