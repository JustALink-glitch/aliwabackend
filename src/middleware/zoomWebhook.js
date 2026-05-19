const crypto = require('crypto')

/**
 * Zoom Webhook Signature Verification Middleware
 *
 * Verifies that the incoming request is genuinely from Zoom using the
 * HMAC-SHA256 signature calculated from the body, timestamp, and webhook token.
 */
const verifyZoomWebhook = (req, res, next) => {
  const signature = req.headers['x-zm-signature']
  const timestamp = req.headers['x-zm-request-timestamp']

  if (!signature || !timestamp) {
    return res.status(401).json({ message: 'Unauthorized - Missing Zoom headers' })
  }

  // Prevent replay attacks (check if timestamp is older than 5 minutes)
  const nowInSeconds = Math.floor(Date.now() / 1000)
  const requestTime = parseInt(timestamp, 10)
  if (isNaN(requestTime) || Math.abs(nowInSeconds - requestTime) > 300) {
    return res.status(401).json({ message: 'Unauthorized - Stale request or bad timestamp' })
  }

  const webhookSecret = process.env.ZOOM_WEBHOOK_SECRET
  if (!webhookSecret) {
    console.error('❌ ZOOM_WEBHOOK_SECRET is not configured in .env')
    return res.status(500).json({ message: 'Internal Server Error - Webhook secret not configured' })
  }

  // Construct message
  const message = `v0:${timestamp}:${JSON.stringify(req.body)}`

  // Hash message with webhook secret
  const hmac = crypto.createHmac('sha256', webhookSecret)
  hmac.update(message)
  const hash = `v0=${hmac.digest('hex')}`

  // Safe constant-time comparison
  try {
    const signatureBuffer = Buffer.from(signature)
    const hashBuffer = Buffer.from(hash)
    if (signatureBuffer.length !== hashBuffer.length || !crypto.timingSafeEqual(signatureBuffer, hashBuffer)) {
      return res.status(401).json({ message: 'Unauthorized - Invalid signature match' })
    }
  } catch (err) {
    return res.status(401).json({ message: 'Unauthorized - Signature verification failed' })
  }

  next()
}

module.exports = verifyZoomWebhook