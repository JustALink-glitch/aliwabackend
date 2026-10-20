/**
 * Roles from the development reference §03.
 * Programme managers use the `admin` role. Assistant trainer permissions are an
 * organisation setting (F1.04) and are resolved per capability, not by role alone.
 */
export const ROLES = ['owner', 'admin', 'trainer', 'assistant_trainer', 'participant'] as const
export type Role = (typeof ROLES)[number]

export const STAFF_ROLES = ['owner', 'admin', 'trainer', 'assistant_trainer'] as const satisfies readonly Role[]
export const ADMIN_ROLES = ['owner', 'admin'] as const satisfies readonly Role[]
export const TRAINER_ROLES = ['trainer', 'assistant_trainer'] as const satisfies readonly Role[]

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}
