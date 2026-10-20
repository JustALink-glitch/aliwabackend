import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../src/lib/db.js'
import { createTestDatabase, TEST_DATABASE_URL } from './helpers/db.js'
import { as, client, testApp } from './helpers/app.js'

describe.skipIf(!TEST_DATABASE_URL)('onboarding: sign-up, invitations, joining', () => {
  let sql: Sql
  let drop: () => Promise<void>
  let clock = new Date('2026-10-19T09:00:00Z')
  let t: ReturnType<typeof testApp>
  let req: ReturnType<typeof client>

  // People
  const ada = { id: randomUUID(), email: 'ada@aliwa.org' } // ALIWA owner
  const kofi = { id: randomUUID(), email: 'kofi@other.org' } // owner of another org
  let ownerToken: string
  let otherOwnerToken: string

  beforeAll(async () => {
    ;({ sql, drop } = await createTestDatabase())
    t = testApp(sql, { now: () => clock })
    req = client(t.app)
    await sql`insert into auth.users (id, email) values (${ada.id}, ${ada.email}), (${kofi.id}, ${kofi.email})`
    ownerToken = as(ada.id, ada.email)
    otherOwnerToken = as(kofi.id, kofi.email)
  })

  afterAll(async () => {
    await drop?.()
  })

  describe('organisation sign-up (R1)', () => {
    it('requires a signed-in user', async () => {
      const res = await req('POST', '/v1/organisations', { body: { organisationName: 'X', fullName: 'A B' } })
      expect(res.status).toBe(401)
    })

    it('validates fields', async () => {
      const res = await req('POST', '/v1/organisations', {
        token: ownerToken,
        body: { organisationName: '', fullName: 'Ada', timeZone: 'Mars/Olympus' },
      })
      expect(res.status).toBe(400)
      const fields = (res.body.error!.details as { field: string }[]).map((d) => d.field)
      expect(fields).toEqual(expect.arrayContaining(['organisationName', 'fullName', 'timeZone']))
    })

    it('creates the organisation with the caller as owner', async () => {
      const res = await req('POST', '/v1/organisations', {
        token: ownerToken,
        body: { organisationName: 'ALIWA Foundation', fullName: '  Ada  Chioma   Obi ' },
      })
      expect(res.status).toBe(201)
      expect(res.body).toMatchObject({
        organisation: { name: 'ALIWA Foundation', timeZone: 'Africa/Lagos' },
        membership: { role: 'owner' },
      })

      const me = await req('GET', '/v1/me', { token: ownerToken })
      expect(me.status).toBe(200)
      expect(me.body).toMatchObject({ membership: { role: 'owner' }, organisation: { name: 'ALIWA Foundation' } })

      const [owner] = await sql`select first_name, last_name from organisation_members where email = ${ada.email}`
      expect(owner).toEqual({ first_name: 'Ada Chioma', last_name: 'Obi' })

      const [settings] = await sql`select zoom_present_min_pct from organisation_settings`
      expect(settings).toBeDefined()
      const [event] = await sql`select action from audit_events where action = 'organisation.created'`
      expect(event).toBeDefined()
    })

    it('allows one organisation per account', async () => {
      const res = await req('POST', '/v1/organisations', {
        token: ownerToken,
        body: { organisationName: 'Second', fullName: 'Ada Obi' },
      })
      expect(res.status).toBe(409)
      expect(res.body.error!.code).toBe('already_member')
    })

    it('lets a second, unrelated organisation sign up', async () => {
      const res = await req('POST', '/v1/organisations', {
        token: otherOwnerToken,
        body: { organisationName: 'Other Org', fullName: 'Kofi Annan', timeZone: 'Africa/Accra' },
      })
      expect(res.status).toBe(201)
    })
  })

  describe('inviting people (B1.02, B2.03)', () => {
    let trainerToken: string

    it('only owners and admins can invite', async () => {
      const res = await req('POST', '/v1/members', {
        body: { email: 'x@aliwa.org', firstName: 'X', lastName: 'Y', role: 'trainer' },
      })
      expect(res.status).toBe(401)
    })

    it('cannot invite an owner', async () => {
      const res = await req('POST', '/v1/members', {
        token: ownerToken,
        body: { email: 'boss@aliwa.org', firstName: 'B', lastName: 'C', role: 'owner' },
      })
      expect(res.status).toBe(400)
    })

    it('invites a trainer and emails a one-time link', async () => {
      const res = await req('POST', '/v1/members', {
        token: ownerToken,
        body: { email: '  Bisi@Aliwa.org ', firstName: 'Bisi', lastName: 'Tade', role: 'trainer' },
      })
      expect(res.status).toBe(201)
      expect(res.body).toMatchObject({
        emailSent: true,
        member: { email: 'bisi@aliwa.org', role: 'trainer', status: 'invited' },
      })
      const email = t.mail.sent.at(-1)!
      expect(email.to).toBe('bisi@aliwa.org')
      expect(email.subject).toContain('ALIWA Foundation')
      expect(email.text).toContain('expires in 72 hours')

      // Only a hash is stored
      const token = t.mail.lastToken('bisi@aliwa.org')
      const [stored] = await sql<{ token_hash: Buffer }[]>`
        select i.token_hash from invitations i
        join organisation_members m on m.id = i.member_id where m.email = 'bisi@aliwa.org'
      `
      expect(stored!.token_hash.equals(createHash('sha256').update(token).digest())).toBe(true)
      expect(stored!.token_hash.toString('utf8')).not.toContain(token)
    })

    it('shows the invitation to whoever holds the link', async () => {
      const res = await req('GET', `/v1/invitations/${t.mail.lastToken('bisi@aliwa.org')}`)
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({
        invitation: {
          state: 'valid',
          email: 'bisi@aliwa.org',
          firstName: 'Bisi',
          role: 'trainer',
          organisationName: 'ALIWA Foundation',
          invitedBy: 'Ada Chioma O.',
        },
      })
    })

    it('rejects unknown and malformed links', async () => {
      expect((await req('GET', '/v1/invitations/nope')).status).toBe(404)
      expect((await req('GET', `/v1/invitations/${'a'.repeat(43)}`)).status).toBe(404)
    })

    it('requires a 10-character password', async () => {
      const res = await req('POST', `/v1/invitations/${t.mail.lastToken('bisi@aliwa.org')}/accept`, {
        body: { password: 'short' },
      })
      expect(res.status).toBe(400)
    })

    it('joins the organisation on accept', async () => {
      const token = t.mail.lastToken('bisi@aliwa.org')
      const res = await req('POST', `/v1/invitations/${token}/accept`, {
        body: { password: 'a-long-password', fullName: 'Bisola Tade' },
      })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ email: 'bisi@aliwa.org' })

      const [member] = await sql<{ status: string; user_id: string; first_name: string }[]>`
        select status, user_id, first_name from organisation_members where email = 'bisi@aliwa.org'
      `
      expect(member!.status).toBe('active')
      expect(member!.first_name).toBe('Bisola')
      trainerToken = as(member!.user_id, 'bisi@aliwa.org')
      const me = await req('GET', '/v1/me', { token: trainerToken })
      expect(me.body).toMatchObject({ membership: { role: 'trainer' }, organisation: { name: 'ALIWA Foundation' } })
    })

    it('links work once', async () => {
      const token = t.mail.lastToken('bisi@aliwa.org')
      const accept = await req('POST', `/v1/invitations/${token}/accept`, { body: { password: 'another-password' } })
      expect(accept.status).toBe(410)
      expect(accept.body.error!.code).toBe('invitation_used')
    })

    it('trainers cannot invite or list members', async () => {
      const invite = await req('POST', '/v1/members', {
        token: trainerToken,
        body: { email: 'p@aliwa.org', firstName: 'P', lastName: 'Q', role: 'participant' },
      })
      expect(invite.status).toBe(403)
      expect((await req('GET', '/v1/members', { token: trainerToken })).status).toBe(403)
    })

    it('one email belongs to one organisation', async () => {
      const sameOrg = await req('POST', '/v1/members', {
        token: ownerToken,
        body: { email: 'bisi@aliwa.org', firstName: 'B', lastName: 'T', role: 'participant' },
      })
      expect(sameOrg.status).toBe(409)
      const otherOrg = await req('POST', '/v1/members', {
        token: otherOwnerToken,
        body: { email: 'bisi@aliwa.org', firstName: 'B', lastName: 'T', role: 'participant' },
      })
      expect(otherOrg.status).toBe(409)
      expect(otherOrg.body.error!.code).toBe('email_in_use')
    })
  })

  describe('resend, expiry and renewal', () => {
    let memberId: string

    it('resend cancels the old link', async () => {
      const invite = await req('POST', '/v1/members', {
        token: ownerToken,
        body: { email: 'tunde@aliwa.org', firstName: 'Tunde', lastName: 'B', role: 'participant' },
      })
      memberId = (invite.body.member as { id: string }).id
      const first = t.mail.lastToken('tunde@aliwa.org')

      const resend = await req('POST', `/v1/members/${memberId}/invitation`, { token: ownerToken })
      expect(resend.status).toBe(200)
      const second = t.mail.lastToken('tunde@aliwa.org')
      expect(second).not.toBe(first)

      expect((await req('GET', `/v1/invitations/${first}`)).body).toMatchObject({ invitation: { state: 'replaced' } })
      const accept = await req('POST', `/v1/invitations/${first}/accept`, { body: { password: 'a-long-password' } })
      expect(accept.body.error!.code).toBe('invitation_replaced')
      expect((await req('GET', `/v1/invitations/${second}`)).body).toMatchObject({ invitation: { state: 'valid' } })
    })

    it('another organisation cannot see or resend it', async () => {
      const resend = await req('POST', `/v1/members/${memberId}/invitation`, { token: otherOwnerToken })
      expect(resend.status).toBe(404)
      const list = await req('GET', '/v1/members', { token: otherOwnerToken })
      const emails = (list.body.members as { email: string }[]).map((m) => m.email)
      expect(emails).toEqual(['kofi@other.org'])
    })

    it('expires after 72 hours and can be renewed by the invitee', async () => {
      const token = t.mail.lastToken('tunde@aliwa.org')
      expect((await req('POST', `/v1/invitations/${token}/renew`)).status).toBe(409) // still valid

      clock = new Date(clock.getTime() + 73 * 3600 * 1000)
      const view = await req('GET', `/v1/invitations/${token}`)
      expect(view.status).toBe(200)
      expect(view.body).toMatchObject({ invitation: { state: 'expired', invitedBy: 'Ada Chioma O.' } })
      expect((await req('POST', `/v1/invitations/${token}/accept`, { body: { password: 'a-long-password' } })).status).toBe(410)

      const renew = await req('POST', `/v1/invitations/${token}/renew`)
      expect(renew.status).toBe(200)
      expect(renew.body).toMatchObject({ sent: true, email: 'tunde@aliwa.org' })
      const fresh = t.mail.lastToken('tunde@aliwa.org')
      expect(fresh).not.toBe(token)
      expect((await req('GET', `/v1/invitations/${fresh}`)).body).toMatchObject({ invitation: { state: 'valid' } })

      // "Resend email" from the sent screen still uses the old link: allowed, but not more than once a minute.
      expect((await req('POST', `/v1/invitations/${token}/renew`)).status).toBe(429)
      clock = new Date(clock.getTime() + 61 * 1000)
      expect((await req('POST', `/v1/invitations/${token}/renew`)).status).toBe(200)

      // The admin who invited them is told.
      const notes = await sql`
        select n.title from notifications n join organisation_members m on m.id = n.recipient_member_id
        where m.email = ${ada.email} and n.event = 'invitation_renewal_requested'
      `
      expect(notes).toHaveLength(2)
      expect(notes[0]!.title).toBe('Tunde B asked for a new invitation link')
    })

    it('lists members with invitation state', async () => {
      const list = await req('GET', '/v1/members?status=invited', { token: ownerToken })
      expect(list.status).toBe(200)
      expect(list.body.members).toEqual([
        expect.objectContaining({ email: 'tunde@aliwa.org', status: 'invited', invitationExpiresAt: expect.any(String) }),
      ])
    })

    it("can't resend to someone who already joined", async () => {
      const [bisi] = await sql<{ id: string }[]>`select id from organisation_members where email = 'bisi@aliwa.org'`
      const res = await req('POST', `/v1/members/${bisi!.id}/invitation`, { token: ownerToken })
      expect(res.status).toBe(409)
    })
  })

  describe('signing in without access', () => {
    it('tells a new account to set up its organisation', async () => {
      const userId = randomUUID()
      await sql`insert into auth.users (id, email) values (${userId}, 'new@founder.org')`
      const me = await req('GET', '/v1/me', { token: as(userId, 'new@founder.org') })
      expect(me.status).toBe(403)
      expect(me.body.error!.code).toBe('no_organisation')
    })

    it('tells a deactivated member their access has ended', async () => {
      const [bisi] = await sql<{ user_id: string }[]>`
        update organisation_members set status = 'deactivated', deactivated_at = now()
        where email = 'bisi@aliwa.org' returning user_id
      `
      const me = await req('GET', '/v1/me', { token: as(bisi!.user_id, 'bisi@aliwa.org') })
      expect(me.status).toBe(403)
      expect(me.body.error!.code).toBe('access_ended')
      await sql`update organisation_members set status = 'active', deactivated_at = null where email = 'bisi@aliwa.org'`
    })
  })

  describe('accepting when an auth account already exists', () => {
    it('links an existing, unattached account and sets its password', async () => {
      const userId = randomUUID()
      await sql`insert into auth.users (id, email) values (${userId}, 'zainab@aliwa.org')`
      await req('POST', '/v1/members', {
        token: ownerToken,
        body: { email: 'zainab@aliwa.org', firstName: 'Zainab', lastName: 'K', role: 'admin' },
      })
      const res = await req('POST', `/v1/invitations/${t.mail.lastToken('zainab@aliwa.org')}/accept`, {
        body: { password: 'zainab-password' },
      })
      expect(res.status).toBe(200)
      expect(t.auth.passwords.get(userId)).toBe('zainab-password')
      const [member] = await sql`select user_id from organisation_members where email = 'zainab@aliwa.org'`
      expect(member!.user_id).toBe(userId)
    })

    it('removes a newly created account if joining fails', async () => {
      await req('POST', '/v1/members', {
        token: ownerToken,
        body: { email: 'race@aliwa.org', firstName: 'R', lastName: 'C', role: 'participant' },
      })
      const token = t.mail.lastToken('race@aliwa.org')
      // Simulate the invitation being revoked between the check and the join.
      const realCreate = t.auth.admin.createUser
      t.auth.admin.createUser = async (input) => {
        const result = await realCreate(input)
        await sql`update invitations set revoked_at = now() where accepted_at is null and revoked_at is null`
        return result
      }
      const res = await req('POST', `/v1/invitations/${token}/accept`, { body: { password: 'a-long-password' } })
      t.auth.admin.createUser = realCreate
      expect(res.status).toBe(410)
      expect(res.body.error!.code).toBe('invitation_replaced')
      expect(t.auth.deleted).toHaveLength(1)
      const [user] = await sql`select 1 from auth.users where email = 'race@aliwa.org'`
      expect(user).toBeUndefined()
    })
  })
})
