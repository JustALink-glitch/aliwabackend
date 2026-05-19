const express = require('express')
const router = express.Router()
const verifyZoomWebhook = require('../middleware/zoomWebhook')
const { handleWebhook } = require('../controllers/zoomWebhookController')

/**
 * POST /api/zoom-webhook
 *
 * Zoom Event Subscriptions handler endpoint.
 * Secures requests using custom verifyZoomWebhook middleware.
 */
router.post('/', verifyZoomWebhook, handleWebhook)

module.exports = router