import type { Sql, Tx } from './db.js'
import { AppError } from './errors.js'

/** Checks a member belongs to the organisation, is not deactivated, and has one of the roles. */
export async function requireMemberWithRole(
  tx: Sql | Tx,
  organisationId: string,
  memberId: string,
  roles: string[],
  field: string,
  message: string,
): Promise<void> {
  const [row] = await tx<{ id: string }[]>`
    select id from public.organisation_members
    where id = ${memberId} and organisation_id = ${organisationId}
      and status <> 'deactivated' and role in ${tx(roles)}
  `
  if (!row) throw new AppError(400, 'bad_request', 'Some fields need attention.', [{ field, message }])
}
