/**
 * Calendar maths for scheduling (C1.02). Works on plain dates ("2026-10-21") so time zones
 * never shift a day; times are attached in the database using the organisation's time zone.
 */

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7

const RRULE_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const

/** Most sessions one schedule may create. */
export const MAX_SESSIONS_PER_SCHEDULE = 200

export function weekdayOf(date: string): Weekday {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay() // 0 = Sunday
  return (day === 0 ? 7 : day) as Weekday
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export interface Repeat {
  weekdays: Weekday[]
  /** Stop after this many sessions… */
  count?: number | undefined
  /** …or on this date (inclusive). */
  until?: string | undefined
}

/**
 * Dates for a schedule. Without a repeat, just the start date. With a weekly repeat, every chosen
 * weekday from the start date (the start date itself counts only if it is one of them).
 */
export function occurrences(startDate: string, repeat: Repeat | null, hardStop?: string): string[] {
  if (!repeat) return [startDate]
  const days = new Set(repeat.weekdays)
  const out: string[] = []
  let date = startDate
  // A year and a bit is the longest a weekly schedule can sensibly run.
  for (let i = 0; i < 400 && out.length < MAX_SESSIONS_PER_SCHEDULE; i++, date = addDays(date, 1)) {
    if (repeat.until && date > repeat.until) break
    if (hardStop && date > hardStop) break
    if (days.has(weekdayOf(date))) out.push(date)
    if (repeat.count && out.length >= repeat.count) break
  }
  return out
}

export function toRrule(repeat: Repeat): string {
  const byday = [...repeat.weekdays].sort().map((d) => RRULE_DAYS[d - 1]).join(',')
  const end = repeat.count ? `;COUNT=${repeat.count}` : repeat.until ? `;UNTIL=${repeat.until.replace(/-/g, '')}` : ''
  return `FREQ=WEEKLY;BYDAY=${byday}${end}`
}

/** Weekdays from an RRULE, for "repeats Mon and Wed". */
export function weekdaysFromRrule(rrule: string): Weekday[] {
  const byday = /BYDAY=([A-Z,]+)/.exec(rrule)?.[1]
  if (!byday) return []
  return byday
    .split(',')
    .map((code) => (RRULE_DAYS.indexOf(code as (typeof RRULE_DAYS)[number]) + 1) as Weekday)
    .filter((d) => d >= 1)
}
