const axios = require('axios')
const { storeOAuthTokens, generateSDKSignature, refreshAccessToken, getStoredTokens } = require('../utils/zoomTokens')
const supabase = require('../config/supabase')

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

  const zoomAuthUrl = `https://zoom.us/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent('meeting:write:meeting meeting:write:meeting:admin')}&prompt=login&state=${userId}`
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

    try {
      await supabase.from('notifications').insert({
        user_id: userId,
        title: 'Zoom Connected',
        message: 'Your Zoom account has been successfully connected for auto-scheduling classes.',
        type: 'zoom_connected'
      })
    } catch (notifErr) {
      console.error('Failed to create Zoom connected notification:', notifErr.message)
    }

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
    const sdkKey = process.env.ZOOM_SDK_KEY || process.env.ZOOM_OAUTH_CLIENT_ID
    return res.json({ signature, sdkKey })
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

/**
 * Returns whether the logged in user has authorized Zoom.
 *
 * GET /api/zoom/status
 */
const checkZoomStatus = async (req, res) => {
  const requesterId = req.user?.id
  const requestedUserId = req.query.userId
  const userId = req.user?.role === 'admin' && requestedUserId ? requestedUserId : requesterId

  if (!userId) {
    return res.status(400).json({ error: 'User ID is required to check Zoom status.' })
  }

  try {
    const tokens = await getStoredTokens(userId)
    return res.json({ connected: !!tokens })
  } catch (error) {
    console.error('❌ Failed to check Zoom connection status:', error.message)
    return res.status(500).json({ error: 'Failed to check Zoom status.' })
  }
}

/**
 * Disconnects the Zoom integration by deleting tokens.
 *
 * POST /api/zoom/disconnect
 */
const disconnectZoom = async (req, res) => {
  const userId = req.user?.id

  if (!userId) {
    return res.status(400).json({ error: 'User ID is required to disconnect Zoom.' })
  }

  try {
    const { error } = await supabase
      .from('zoom_oauth_tokens')
      .delete()
      .eq('user_id', userId)

    if (error) throw error

    try {
      await supabase.from('notifications').insert({
        user_id: userId,
        title: 'Zoom Disconnected',
        message: 'Your Zoom account has been disconnected. Live sessions will now require manual links.',
        type: 'zoom_disconnected'
      })
    } catch (notifErr) {
      console.error('Failed to create Zoom disconnected notification:', notifErr.message)
    }

    console.log(`✅ Zoom disconnected successfully for user ${userId}.`)
    return res.json({ success: true, message: 'Zoom disconnected successfully.' })
  } catch (error) {
    console.error('❌ Failed to disconnect Zoom:', error.message)
    return res.status(500).json({ error: 'Failed to disconnect Zoom account.' })
  }
}

module.exports = {
  initiateOAuth,
  handleOAuthCallback,
  getSignature,
  getOBFToken,
  checkZoomStatus,
  disconnectZoom
}