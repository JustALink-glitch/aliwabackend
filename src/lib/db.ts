import postgres from 'postgres'

export type Sql = postgres.Sql
export type Tx = postgres.TransactionSql

/**
 * Direct Postgres connection (Supabase pooler). Used for all product data so multi-step
 * writes run in one transaction. Connects as a privileged role: every query must be scoped
 * to the caller's organisation.
 */
export function createSql(databaseUrl: string, options: { max?: number } = {}): Sql {
  return postgres(databaseUrl, {
    max: options.max ?? 10,
    idle_timeout: 20,
    connect_timeout: 10,
    // Required for Supabase's transaction pooler; harmless on a direct or session connection.
    prepare: false,
    // Return timestamps as Date and keep numerics as strings (no float rounding).
    transform: { undefined: null },
    onnotice: () => {},
  })
}

/** Postgres error codes we turn into user-facing errors. */
export const PG = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
} as const

export function isPg(error: unknown, code: string, constraint?: string): boolean {
  if (typeof error !== 'object' || error === null) return false
  const e = error as { code?: string; constraint_name?: string }
  return e.code === code && (constraint === undefined || e.constraint_name === constraint)
}

/** Appends to the audit log. Call inside the same transaction as the change. */
export async function audit(
  tx: Sql | Tx,
  entry: {
    organisationId: string
    actorMemberId: string | null
    action: string
    entityType: string
    entityId?: string | null
    data?: Record<string, unknown>
    requestId?: string | null
  },
): Promise<void> {
  await tx`
    insert into public.audit_events
      (organisation_id, actor_member_id, action, entity_type, entity_id, data, request_id)
    values
      (${entry.organisationId}, ${entry.actorMemberId}, ${entry.action}, ${entry.entityType},
       ${entry.entityId ?? null}, ${tx.json((entry.data ?? {}) as postgres.JSONValue)}, ${entry.requestId ?? null})
  `
}
