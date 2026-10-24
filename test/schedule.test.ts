import { describe, expect, it } from 'vitest'
import { occurrences, toRrule, weekdayOf, weekdaysFromRrule } from '../src/lib/schedule.js'

describe('schedule maths', () => {
  it('knows weekdays', () => {
    expect(weekdayOf('2027-01-11')).toBe(1) // Monday
    expect(weekdayOf('2027-01-17')).toBe(7) // Sunday
  })

  it('makes one date without a repeat', () => {
    expect(occurrences('2027-01-11', null)).toEqual(['2027-01-11'])
  })

  it('repeats on chosen weekdays for a number of sessions (C1.02 sample)', () => {
    const dates = occurrences('2027-01-11', { weekdays: [1, 3], count: 10 })
    expect(dates).toEqual([
      '2027-01-11', '2027-01-13', '2027-01-18', '2027-01-20', '2027-01-25',
      '2027-01-27', '2027-02-01', '2027-02-03', '2027-02-08', '2027-02-10',
    ])
  })

  it('stops on an end date, and skips the start date if it is not a chosen day', () => {
    expect(occurrences('2027-01-12', { weekdays: [1], until: '2027-01-25' })).toEqual(['2027-01-18', '2027-01-25'])
  })

  it('never runs past a hard stop such as the cohort end', () => {
    expect(occurrences('2027-01-11', { weekdays: [1], count: 10 }, '2027-01-20')).toEqual(['2027-01-11', '2027-01-18'])
  })

  it('round-trips an RRULE', () => {
    const rule = toRrule({ weekdays: [3, 1], count: 10 })
    expect(rule).toBe('FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10')
    expect(weekdaysFromRrule(rule)).toEqual([1, 3])
    expect(toRrule({ weekdays: [6], until: '2027-03-01' })).toBe('FREQ=WEEKLY;BYDAY=SA;UNTIL=20270301')
  })
})
