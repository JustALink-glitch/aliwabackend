require('dotenv').config()
const axios = require('axios')
const crypto = require('crypto')

const webhookSecret = process.env.ZOOM_WEBHOOK_SECRET || 'test_webhook_secret'
const timestamp = Math.floor(Date.now() / 1000).toString()
const body = {
  event: 'endpoint.url_validation',
  payload: {
    plainToken: 'test_zoom_plain_token_12345'
  }
}

const message = `v0:${timestamp}:${JSON.stringify(body)}`
const hmac = crypto.createHmac('sha256', webhookSecret)
hmac.update(message)
const signature = `v0=${hmac.digest('hex')}`

axios.post('http://localhost:5000/api/zoom-webhook', body, {
  headers: {
    'x-zm-request-timestamp': timestamp,
    'x-zm-signature': signature,
    'Content-Type': 'application/json'
  },
  timeout: 10000
})
  .then(res => {
    console.log('✅ Webhook POST successful')
    console.log('Status:', res.status)
    console.log('Response body:', res.data)
  })
  .catch(err => {
    console.error('❌ Webhook POST failed')
    if (err.response) {
      console.error('Status:', err.response.status)
      console.error('Body:', err.response.data)
    } else {
      console.error(err.message)
    }
    process.exit(1)
  })
