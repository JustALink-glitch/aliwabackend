const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const supabase = require('../config/supabase')
const { sendOtpEmail } = require('../utils/email')

const generateToken = (user) => {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  )
}

// ─────────────────────────────────────────────
// REGISTER (Admin self-registration)
// ─────────────────────────────────────────────
const register = async (req, res) => {
  try {
    const { firstName, lastName, email, password, organizationName } = req.body
    if (!firstName || !lastName || !email || !password || !organizationName) {
      return res.status(400).json({ message: 'All fields are required' })
    }

    // Check password strength
    if (password.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters' })
    }

    const { data: existingUser } = await supabase
      .from('users').select('id').eq('email', email).single()
    if (existingUser) {
      return res.status(400).json({ message: 'Email already registered' })
    }

    const hashedPassword = await bcrypt.hash(password, 12)

    const { data: org, error: orgError } = await supabase
      .from('organizations').insert({ name: organizationName, email }).select().single()
    if (orgError) throw orgError

    const { data: user, error: userError } = await supabase
      .from('users').insert({
        first_name: firstName, last_name: lastName, email,
        password: hashedPassword, role: 'admin',
        status: 'active', is_first_login: false
      }).select().single()
    if (userError) throw userError

    const token = generateToken(user)
    res.status(201).json({
      message: 'Account created successfully',
      token,
      user: {
        id: user.id,
        firstName: user.first_name,
        lastName: user.last_name,
        email: user.email,
        role: user.role
      },
      organization: org
    })
  } catch (error) {
    console.error('Register error:', error)
    res.status(500).json({ message: 'Registration failed', error: error.message })
  }
}

// ─────────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────────
const login = async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' })
    }

    const { data: user, error } = await supabase
      .from('users').select('*').eq('email', email).single()
    if (error || !user) {
      return res.status(401).json({ message: 'Invalid email or password' })
    }

    const isMatch = await bcrypt.compare(password, user.password)
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid email or password' })
    }

    if (user.status === 'inactive') {
      return res.status(403).json({ message: 'Your account has been deactivated. Contact your administrator.' })
    }

    const token = generateToken(user)
    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        firstName: user.first_name,
        lastName: user.last_name,
        email: user.email,
        role: user.role,
        isFirstLogin: user.is_first_login,
        status: user.status
      }
    })
  } catch (error) {
    console.error('Login error:', error)
    res.status(500).json({ message: 'Login failed', error: error.message })
  }
}

// ─────────────────────────────────────────────
// SET PASSWORD (first login)
// ─────────────────────────────────────────────
const setPassword = async (req, res) => {
  try {
    const { email, tempPassword, newPassword } = req.body
    if (!email || !tempPassword || !newPassword) {
      return res.status(400).json({ message: 'All fields are required' })
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ message: 'New password must be at least 8 characters' })
    }

    const { data: user, error } = await supabase
      .from('users').select('*').eq('email', email).single()
    if (error || !user) {
      return res.status(404).json({ message: 'User not found' })
    }

    const isMatch = await bcrypt.compare(tempPassword, user.password)
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid temporary password' })
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12)
    const { error: updateError } = await supabase
      .from('users').update({
        password: hashedPassword,
        is_first_login: false,
        status: 'active',
        updated_at: new Date()
      }).eq('id', user.id)
    if (updateError) throw updateError

    // Generate new token with updated user data
    const updatedUser = { ...user, is_first_login: false, status: 'active' }
    const token = generateToken(updatedUser)

    res.json({
      message: 'Password set successfully',
      token,
      user: {
        id: user.id,
        firstName: user.first_name,
        lastName: user.last_name,
        email: user.email,
        role: user.role,
        isFirstLogin: false
      }
    })
  } catch (error) {
    console.error('Set password error:', error)
    res.status(500).json({ message: 'Failed to set password', error: error.message })
  }
}

// ─────────────────────────────────────────────
// GET ME (profile)
// ─────────────────────────────────────────────
const getMe = async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, first_name, last_name, email, role, phone, avatar, status, is_first_login, created_at')
      .eq('id', req.user.id).single()
    if (error || !user) {
      return res.status(404).json({ message: 'User not found' })
    }
    res.json({
      user: {
        id: user.id,
        firstName: user.first_name,
        lastName: user.last_name,
        email: user.email,
        role: user.role,
        phone: user.phone,
        avatar: user.avatar,
        status: user.status,
        isFirstLogin: user.is_first_login
      }
    })
  } catch (error) {
    res.status(500).json({ message: 'Failed to get user', error: error.message })
  }
}

// ─────────────────────────────────────────────
// FORGOT PASSWORD — generate & email OTP
// ─────────────────────────────────────────────
const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body
    if (!email) {
      return res.status(400).json({ message: 'Email is required' })
    }

    const { data: user } = await supabase
      .from('users').select('id, email, first_name').eq('email', email).single()

    // Always return same message to prevent email enumeration
    if (!user) {
      return res.json({ message: 'If this email exists, a reset code has been sent.' })
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString()
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000) // 15 minutes

    // Delete any old OTPs for this user
    await supabase
      .from('notifications')
      .delete()
      .eq('user_id', user.id)
      .eq('type', 'otp')

    // Store new OTP
    const { error: insertError } = await supabase.from('notifications').insert({
      user_id: user.id,
      title: 'password_reset_otp',
      message: otp,
      type: 'otp'
    })
    if (insertError) throw insertError

    // Send OTP via email
    await sendOtpEmail({ to: user.email, firstName: user.first_name, otp })

    res.json({ message: 'If this email exists, a reset code has been sent.' })
  } catch (error) {
    console.error('Forgot password error:', error)
    res.status(500).json({ message: 'Failed to process request', error: error.message })
  }
}

// ─────────────────────────────────────────────
// VERIFY OTP
// ─────────────────────────────────────────────
const verifyOtp = async (req, res) => {
  try {
    const { email, otp } = req.body
    if (!email || !otp) {
      return res.status(400).json({ message: 'Email and OTP are required' })
    }

    const { data: user } = await supabase
      .from('users').select('id, email').eq('email', email).single()
    if (!user) {
      return res.status(400).json({ message: 'Invalid or expired code' })
    }

    const { data: otpRecord } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', user.id)
      .eq('type', 'otp')
      .eq('message', otp)
      .single()

    if (!otpRecord) {
      return res.status(400).json({ message: 'Invalid reset code' })
    }

    // Check expiry using created_at (15 mins)
    const otpAgeMs = new Date() - new Date(otpRecord.created_at)
    if (otpAgeMs > 15 * 60 * 1000) {
      await supabase.from('notifications').delete().eq('id', otpRecord.id)
      return res.status(400).json({ message: 'Reset code has expired. Please request a new one.' })
    }

    res.json({ message: 'OTP verified successfully', valid: true })
  } catch (error) {
    console.error('Verify OTP error:', error)
    res.status(500).json({ message: 'Failed to verify code', error: error.message })
  }
}

// ─────────────────────────────────────────────
// RESET PASSWORD (after OTP verified)
// ─────────────────────────────────────────────
const resetPassword = async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body
    if (!email || !otp || !newPassword) {
      return res.status(400).json({ message: 'All fields are required' })
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters' })
    }

    const { data: user } = await supabase
      .from('users').select('id, email, first_name, role').eq('email', email).single()
    if (!user) {
      return res.status(400).json({ message: 'Invalid request' })
    }

    // Verify OTP again for security
    const { data: otpRecord } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', user.id)
      .eq('type', 'otp')
      .eq('message', otp)
      .single()

    if (!otpRecord) {
      return res.status(400).json({ message: 'Invalid or expired reset code' })
    }

    const otpAgeMs = new Date() - new Date(otpRecord.created_at)
    if (otpAgeMs > 15 * 60 * 1000) {
      return res.status(400).json({ message: 'Reset code has expired. Please request a new one.' })
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12)
    const { error: updateError } = await supabase
      .from('users')
      .update({ password: hashedPassword, updated_at: new Date() })
      .eq('id', user.id)
    if (updateError) throw updateError

    // Delete the used OTP
    await supabase.from('notifications').delete().eq('id', otpRecord.id)

    res.json({ message: 'Password reset successfully. You can now sign in.' })
  } catch (error) {
    console.error('Reset password error:', error)
    res.status(500).json({ message: 'Failed to reset password', error: error.message })
  }
}

module.exports = { register, login, setPassword, getMe, forgotPassword, verifyOtp, resetPassword }