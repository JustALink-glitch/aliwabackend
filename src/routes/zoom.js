const express = require('express')
const router = express.Router()
const { initiateOAuth, handleOAuthCallback, getSignature, getOBFToken } = require('../controllers/zoomOAuthController')
const { authenticate } = require('../middleware/auth')

/**
 * GET /api/zoom/authorize
 * Redirects teacher to Zoom OAuth login page.
 */
router.get('/authorize', initiateOAuth)

/**
 * GET /api/zoom/callback
 * Target callback for Zoom OAuth server to trade code for tokens.
 */
router.get('/callback', handleOAuthCallback)

/**
 * GET /api/zoom/signature
 * Generates JWT signatures for joining Zoom Meeting SDK client.
 * Protected: requires valid application JWT.
 */
router.get('/signature', authenticate, getSignature)

/**
 * GET /api/zoom/obf-token
 * Generates Zoom Access Tokens (ZAK) for meeting chaperone checks.
 * Protected: requires valid application JWT.
 */
router.get('/obf-token', authenticate, getOBFToken)


module.exports = router