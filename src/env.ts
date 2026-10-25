import { z } from 'zod'

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim().replace(/\/$/, ''))
        .filter(Boolean),
    ),
  /** Frontend base URL, used in email links. */
  APP_URL: z.url().default('http://localhost:5173'),
  SUPABASE_URL: z.url(),
  SUPABASE_SECRET_KEY: z.string().min(1, 'SUPABASE_SECRET_KEY is required'),
  /** Postgres connection string (Supabase → Connect → Session pooler). */
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'DATABASE_URL must be a postgres:// connection string'),
  /** Optional: without it, emails are printed to the console. */
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('Synqop <onboarding@resend.dev>'),
  /** Reminders, digests and the 30-day deletion run every minute inside the API. "off" if an outside cron calls /v1/internal/run-jobs instead. */
  SCHEDULER: z.enum(['on', 'off']).default('on'),
  /** Optional: lets an outside cron call POST /v1/internal/run-jobs with "Authorization: Bearer <CRON_SECRET>". */
  CRON_SECRET: z.string().min(24, 'CRON_SECRET must be at least 24 characters').optional(),
})

export type Env = z.infer<typeof EnvSchema>

/** Parses process.env once at startup and fails fast with a readable message. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source)
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${problems}`)
  }
  if (result.data.NODE_ENV === 'production' && !result.data.RESEND_API_KEY) {
    throw new Error('Invalid environment configuration:\n  - RESEND_API_KEY: required in production')
  }
  return result.data
}
