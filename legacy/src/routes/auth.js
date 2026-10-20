const express = require('express')
const router = express.Router()
const { z } = require('zod')
const validate = require('../middleware/validate')

const {
  register, login, setPassword, getMe, forgotPassword, verifyOtp, resetPassword
} = require('../controllers/authController')
const { authenticate } = require('../middleware/auth')

const loginSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email format'),
    password: z.string().min(6, 'Password must be at least 6 characters'),
  })
})

// Public routes
router.post('/register', register)
router.post('/login', validate(loginSchema), login)
router.post('/set-password', setPassword)
router.post('/forgot-password', forgotPassword)
router.post('/verify-otp', verifyOtp)
router.post('/reset-password', resetPassword)

// Protected routes
router.get('/me', authenticate, getMe)

module.exports = router