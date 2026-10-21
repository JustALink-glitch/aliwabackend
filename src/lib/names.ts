/** "Abdulhameed O." — how people are named in meta lines and history (B2.02i, T1.01). */
export function shortName(first: string | null | undefined, last: string | null | undefined): string | null {
  if (!first) return null
  const initial = last?.trim().charAt(0)
  return initial ? `${first} ${initial}.` : first
}
