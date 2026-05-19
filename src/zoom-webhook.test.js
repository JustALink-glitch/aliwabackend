const request = require('supertest')
const app = require('./index')
const crypto = require('crypto')

describe('Zoom Webhook Signature Verification and Handlers', () => {
  let originalSecret

  beforeAll(() => {
    // Mock the Webhook Secret for tests
    originalSecret = process.env.ZOOM_WEBHOOK_SECRET
    process.env.ZOOM_WEBHOOK_SECRET = 'test_webhook_secret'
  })

  afterAll(() => {
    process.env.ZOOM_WEBHOOK_SECRET = originalSecret
  })

  test('POST /api/zoom-webhook - Should fail with 401 if Zoom headers are missing', async () => {
    const response = await request(app)
      .post('/api/zoom-webhook')
      .send({ event: 'endpoint.url_validation', payload: {} })

    expect(response.status).toBe(401)
    expect(response.body.message).toContain('Missing Zoom headers')
  })

  test('POST /api/zoom-webhook - Should fail with 401 if timestamp is stale (replay protection)', async () => {
    const staleTimestamp = Math.floor(Date.now() / 1000) - 600 // 10 minutes ago
    const response = await request(app)
      .post('/api/zoom-webhook')
      .set('x-zm-request-timestamp', staleTimestamp.toString())
      .set('x-zm-signature', 'v0=anyhash')
      .send({ event: 'test' })

    expect(response.status).toBe(401)
    expect(response.body.message).toContain('Stale request')
  })

  test('POST /api/zoom-webhook - Should fail with 401 if signature is invalid', async () => {
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const response = await request(app)
      .post('/api/zoom-webhook')
      .set('x-zm-request-timestamp', timestamp)
      .set('x-zm-signature', 'v0=incorrectsignaturehash')
      .send({ event: 'test' })

    expect(response.status).toBe(401)
    expect(response.body.message).toContain('Invalid signature match')
  })

  test('POST /api/zoom-webhook - Should successfully challenge URL validation and respond with encrypted token', async () => {
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const plainToken = 'test_zoom_plain_token_12345'
    const body = {
      event: 'endpoint.url_validation',
      payload: {
        plainToken: plainToken
      }
    }

    // Construct valid message signature: v0:timestamp:JSON.stringify(body)
    const message = `v0:${timestamp}:${JSON.stringify(body)}`
    const hmac = crypto.createHmac('sha256', 'test_webhook_secret')
    hmac.update(message)
    const validSignature = `v0=${hmac.digest('hex')}`

    const response = await request(app)
      .post('/api/zoom-webhook')
      .set('x-zm-request-timestamp', timestamp)
      .set('x-zm-signature', validSignature)
      .send(body)

    expect(response.status).toBe(200)

    // Verify plain token and expected encrypted token responses
    const expectedHmac = crypto.createHmac('sha256', 'test_webhook_secret')
    expectedHmac.update(plainToken)
    const expectedEncryptedToken = expectedHmac.digest('hex')

    expect(response.body.plainToken).toBe(plainToken)
    expect(response.body.encryptedToken).toBe(expectedEncryptedToken)
  })
})