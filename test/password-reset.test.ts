import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/lib/db.js'
import { createTestDatabase, TEST_DATABASE_URL } from './helpers/db.js'
import { as, client, testApp } from './helpers/app.js'

describe.skipIf(!TEST_DATABASE_URL)('password reset (S1)', () => {
  let sql: Sql
  let drop: () => Promise<void>
  let clock = new Date('2026-10-19T09:12:00Z')
  let t: ReturnType<typeof testApp>
  let req: ReturnType<typeof client>
  const owner = { id: randomUUID(), email: 'ngozi@aliwa.org' }

  beforeAll(async () => {
    ;({ sql, drop } = await createTestDatabase())
    t = testApp(sql, { now: () => clock })
    req = client(t.app)
    await sql`insert into auth.users (id, email) values (${owner.id}, ${owner.email})`
    await req('POST', '/v1/organisations', {
      token: as(owner.id, owner.email),
      body: { organisationName: 'ALIWA Foundation', fullName: 'Ngozi Eze' },
    })
  })

  afterAll(async () => {
    await drop?.()
  })

  it('rejects a malformed email', async () => {
    const res = await req('POST', '/v1/auth/password-reset', { body: { email: 'ngozi@aliwa' } })
    expect(res.status).toBe(400)
  })

  it('emails a reset link in the Synqop template', async () => {
    const res = await req('POST', '/v1/auth/password-reset', { body: { email: ' Ngozi@Aliwa.org ' } })
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ sent: true })

    const email = t.mail.sent.at(-1)!
    expect(email.to).toBe('ngozi@aliwa.org')
    expect(email.subject).toBe('Reset your Synqop password')
    expect(email.text).toContain('Hi Ngozi, someone asked to reset the password for ngozi@aliwa.org on Synqop.')
    // 09:12 UTC + 1 hour, shown in Lagos time (UTC+1)
    expect(email.text).toContain('expires in 1 hour, at 11:12')
    expect(email.text).toContain('Nobody at Synqop or ALIWA Foundation will ever ask for your password.')
    expect(email.html).toContain('Button not working?')

    const redirect = new URL(t.auth.recoveryLinks.at(-1)!.redirectTo)
    expect(redirect.pathname).toBe('/reset-password')
    expect(redirect.searchParams.get('email')).toBe('ngozi@aliwa.org')
    expect(redirect.searchParams.get('sent')).toBe(clock.toISOString())
  })

  it('sends at most one email a minute per address, without saying so', async () => {
    const before = t.mail.sent.length
    const again = await req('POST', '/v1/auth/password-reset', { body: { email: owner.email } })
    expect(again.status).toBe(202)
    expect(t.mail.sent.length).toBe(before)

    clock = new Date(clock.getTime() + 61 * 1000)
    await req('POST', '/v1/auth/password-reset', { body: { email: owner.email } })
    expect(t.mail.sent.length).toBe(before + 1)
  })

  it('answers the same for an email with no account, and sends nothing', async () => {
    const before = t.mail.sent.length
    const res = await req('POST', '/v1/auth/password-reset', { body: { email: 'nobody@nowhere.org' } })
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ sent: true })
    expect(t.mail.sent.length).toBe(before)
  })

  it('works for an account without an organisation yet (generic greeting)', async () => {
    await sql`insert into auth.users (email) values ('founder@new.org')`
    await req('POST', '/v1/auth/password-reset', { body: { email: 'founder@new.org' } })
    const email = t.mail.sent.at(-1)!
    expect(email.to).toBe('founder@new.org')
    expect(email.text).toContain('Someone asked to reset the password for founder@new.org')
    expect(email.text).toContain('Nobody at Synqop will ever ask for your password.')
  })
})
