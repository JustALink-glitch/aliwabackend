const axios = require('axios')
const { storeOAuthTokens, generateSDKSignature, refreshAccessToken } = require('../utils/zoomTokens')

/**
 * Initiates Zoom OAuth flow by redirecting the user to Zoom
 *
 * GET /api/zoom/authorize?userId=XYZ
 */
const initiateOAuth = (req, res) => {
  const userId = req.query.userId || req.user?.id

  if (!userId) {
    return res.status(400).json({ error: 'User ID is required to initiate Zoom OAuth flow.' })
  }

  const clientId = process.env.ZOOM_OAUTH_CLIENT_ID || process.env.ZOOM_SDK_KEY
  const redirectUri = process.env.ZOOM_OAUTH_REDIRECT_URI

  if (!clientId || !redirectUri) {
    console.error('❌ Missing ZOOM_OAUTH_CLIENT_ID or ZOOM_OAUTH_REDIRECT_URI')
    return res.status(500).json({ error: 'OAuth credentials not configured.' })
  }

  const zoomAuthUrl = `https://zoom.us/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${userId}`
  console.log(`🔗 Redirecting user to Zoom OAuth: ${zoomAuthUrl}`)
  res.redirect(zoomAuthUrl)
}

/**
 * Handles callback from Zoom OAuth, exchanges authorization code for tokens, and stores them.
 *
 * GET /api/zoom/callback?code=CODE&state=USER_ID
 */
const handleOAuthCallback = async (req, res) => {
  const { code, state: userId } = req.query

  if (!code) {
    return res.status(400).json({ error: 'Missing authorization code from Zoom.' })
  }

  if (!userId) {
    return res.status(400).json({ error: 'Missing state (User ID) from Zoom OAuth callback.' })
  }

  console.log(`🔑 Exchanging authorization code for tokens. User: ${userId}`)

  const clientId = process.env.ZOOM_OAUTH_CLIENT_ID || process.env.ZOOM_SDK_KEY
  const clientSecret = process.env.ZOOM_OAUTH_CLIENT_SECRET || process.env.ZOOM_SDK_SECRET
  const redirectUri = process.env.ZOOM_OAUTH_REDIRECT_URI

  if (!clientId || !clientSecret || !redirectUri) {
    console.error('❌ Missing OAuth configuration in env variables.')
    return res.status(500).json({ error: 'OAuth credentials not configured.' })
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')

  try {
    const response = await axios({
      method: 'post',
      url: 'https://zoom.us/oauth/token',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      data: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: redirectUri
      })
    })

    const { access_token, refresh_token, expires_in } = response.data

    // Store the tokens mapped to this user/trainer ID
    await storeOAuthTokens(userId, {
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresIn: expires_in
    })

    console.log(`✅ Zoom OAuth flow completed successfully for user ${userId}.`)

    // Redirect to frontend dashboards
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173'
    return res.redirect(`${frontendUrl}/trainer/sessions?zoom_auth=success`)

  } catch (error) {
    console.error('❌ Zoom OAuth callback exchange failed:', error.response?.data || error.message)
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173'
    return res.redirect(`${frontendUrl}/trainer/sessions?zoom_auth=failed&error=${encodeURIComponent(error.message)}`)
  }
}

/**
 * Returns JWT signature for Zoom Meeting SDK client authorization.
 *
 * GET /api/zoom/signature?meetingNumber=12345&role=0
 */
const getSignature = (req, res) => {
  const { meetingNumber, role } = req.query

  if (!meetingNumber) {
    return res.status(400).json({ error: 'meetingNumber is required.' })
  }

  // Role: 0 = attendee (default), 1 = host/trainer
  const meetingRole = role !== undefined ? parseInt(role, 10) : 0

  try {
    const signature = generateSDKSignature(meetingNumber, meetingRole)
    console.log(`🔑 Generated SDK Signature for meeting ${meetingNumber}, role ${meetingRole}`)
    return res.json({ signature })
  } catch (error) {
    console.error('❌ Failed to generate Zoom SDK Signature:', error.message)
    return res.status(500).json({ error: 'Failed to generate Zoom Meeting SDK signature.' })
  }
}

/**
 * Returns a Zoom Access Token (ZAK) / OBF token for the teacher to satisfy Meeting SDK chaperone policies.
 *
 * GET /api/zoom/obf-token?teacherUserId=XYZ
 */
const getOBFToken = async (req, res) => {
  const { teacherUserId } = req.query

  if (!teacherUserId) {
    return res.status(400).json({ error: 'teacherUserId is required.' })
  }

  try {
    // 1. Refresh teacher's Zoom OAuth access token
    const accessToken = await refreshAccessToken(teacherUserId)

    // 2. Fetch ZAK token from Zoom API
    const response = await axios({
      method: 'get',
      url: 'https://api.zoom.us/v2/users/me/token?type=zak',
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    })

    const zakToken = response.data.token
    console.log(`🔑 Successfully fetched ZAK/OBF token for teacher ${teacherUserId}`)
    return res.json({ obfToken: zakToken })

  } catch (error) {
    console.error('❌ Failed to fetch ZAK/OBF token:', error.response?.data || error.message)
    return res.status(500).json({ error: 'Failed to fetch Zoom OBF/ZAK token.' })
  }
}

module.exports = {
  initiateOAuth,
  handleOAuthCallback,
  getSignature,
  getOBFToken
}