const jwt = require('jsonwebtoken')
const axios = require('axios')
const supabase = require('../config/supabase')

/**
 * Generates signature for the Zoom Meeting SDK.
 *
 * @param {string|number} meetingNumber
 * @param {number} role 0 for attendee, 1 for host
 * @returns {string} JWT token signature
 */
const generateSDKSignature = (meetingNumber, role = 0) => {
  const iat = Math.round(new Date().getTime() / 1000) - 30
  const exp = iat + 60 * 60 * 2 // 2 hours

  const sdkKey = process.env.ZOOM_SDK_KEY
  const sdkSecret = process.env.ZOOM_SDK_SECRET

  if (!sdkKey || !sdkSecret) {
    throw new Error('Missing ZOOM_SDK_KEY or ZOOM_SDK_SECRET in environment variables')
  }

  const payload = {
    sdkKey: sdkKey,
    mn: meetingNumber.toString(),
    role: parseInt(role, 10),
    iat: iat,
    exp: exp,
    appKey: sdkKey,
    tokenExp: exp
  }

  return jwt.sign(payload, sdkSecret, {
    algorithm: 'HS256',
    header: { alg: 'HS256', typ: 'JWT' }
  })
}

/**
 * Fetch OAuth tokens from Database for a specific trainer/user.
 */
const getStoredTokens = async (userId) => {
  const { data, error } = await supabase
    .from('zoom_oauth_tokens')
    .select('*')
    .eq('user_id', userId)
    .single()

  if (error || !data) return null
  return data
}

/**
 * Stores Zoom OAuth tokens in Supabase.
 */
const storeOAuthTokens = async (userId, { accessToken, refreshToken, expiresIn }) => {
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()

  const { error } = await supabase
    .from('zoom_oauth_tokens')
    .upsert({
      user_id: userId,
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: expiresAt,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' })

  if (error) {
    console.error('❌ Error storing Zoom OAuth tokens in Supabase:', error.message)
    throw error
  }
}

/**
 * Refreshes the OAuth access token for a given user if expired or close to expiration.
 */
const refreshAccessToken = async (userId) => {
  const tokens = await getStoredTokens(userId)
  if (!tokens) throw new Error('No Zoom OAuth tokens found for this trainer.')

  // Check if token expires in more than 5 minutes (300 seconds), if so return current
  const expiresAtTime = new Date(tokens.expires_at).getTime()
  if (expiresAtTime - Date.now() > 300 * 1000) {
    return tokens.access_token
  }

  console.log(`Refreshing Zoom OAuth access token for user: ${userId}...`)
  const clientId = process.env.ZOOM_OAUTH_CLIENT_ID || process.env.ZOOM_SDK_KEY
  const clientSecret = process.env.ZOOM_OAUTH_CLIENT_SECRET || process.env.ZOOM_SDK_SECRET

  if (!clientId || !clientSecret) {
    throw new Error('Missing Zoom OAuth Client ID or Client Secret configuration.')
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
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token
      })
    })

    const { access_token, refresh_token, expires_in } = response.data
    await storeOAuthTokens(userId, {
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresIn: expires_in
    })

    return access_token
  } catch (error) {
    console.error('❌ Failed to refresh Zoom OAuth token:', error.response?.data || error.message)
    throw new Error('Zoom authentication refresh failed. Please re-authorize Zoom.')
  }
}

module.exports = {
  generateSDKSignature,
  getStoredTokens,
  storeOAuthTokens,
  refreshAccessToken
}