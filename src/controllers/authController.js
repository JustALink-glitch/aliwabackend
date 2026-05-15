const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const supabase = require('../config/supabase')

const generateToken = (user) => {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  )
}

const register = async (req, res) => {
  try {
    const { firstName, lastName, email, password, organizationName } = req.body
    if (!firstName || !lastName || !email || !password || !organizationName) {
      return res.status(400).json({ message: 'All fields are required' })
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
      message: 'Account created successfully', token,
      user: { id: user.id, firstName: user.first_name, lastName: user.last_name, email: user.email, role: user.role },
      organization: org
    })
  } catch (error) {
    console.error('Register error:', error)
    res.status(500).json({ message: 'Registration failed', error: error.message })
  }
}

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
      return res.status(403).json({ message: 'Your account has been deactivated' })
    }
    const token = generateToken(user)
    res.json({
      message: 'Login successful', token,
      user: {
        id: user.id, firstName: user.first_name, lastName: user.last_name,
        email: user.email, role: user.role,
        isFirstLogin: user.is_first_login, status: user.status
      }
    })
  } catch (error) {
    console.error('Login error:', error)
    res.status(500).json({ message: 'Login failed', error: error.message })
  }
}

const setPassword = async (req, res) => {
  try {
    const { email, tempPassword, newPassword } = req.body
    if (!email || !tempPassword || !newPassword) {
      return res.status(400).json({ message: 'All fields are required' })
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
        password: hashedPassword, is_first_login: false,
        status: 'active', updated_at: new Date()
      }).eq('id', user.id)
    if (updateError) throw updateError
    const token = generateToken(user)
    res.json({
      message: 'Password set successfully', token,
      user: {
        id: user.id, firstName: user.first_name, lastName: user.last_name,
        email: user.email, role: user.role, isFirstLogin: false
      }
    })
  } catch (error) {
    console.error('Set password error:', error)
    res.status(500).json({ message: 'Failed to set password', error: error.message })
  }
}

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
        id: user.id, firstName: user.first_name, lastName: user.last_name,
        email: user.email, role: user.role, phone: user.phone,
        avatar: user.avatar, status: user.status, isFirstLogin: user.is_first_login
      }
    })
  } catch (error) {
    res.status(500).json({ message: 'Failed to get user', error: error.message })
  }
}

const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body
    const { data: user } = await supabase
      .from('users').select('id, email, first_name').eq('email', email).single()
    if (!user) {
      return res.json({ message: 'If this email exists, a reset code has been sent.' })
    }
    const otp = Math.floor(100000 + Math.random() * 900000).toString()
    await supabase.from('notifications').insert({
      user_id: user.id, title: 'password_reset_otp',
      message: otp, type: 'otp'
    })
    console.log(`OTP for ${email}: ${otp}`)
    res.json({ message: 'If this email exists, a reset code has been sent.' })
  } catch (error) {
    res.status(500).json({ message: 'Failed to process request', error: error.message })
  }
}

module.exports = { register, login, setPassword, getMe, forgotPassword }