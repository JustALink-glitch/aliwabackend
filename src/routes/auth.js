const express = require('express')
const router = express.Router()
const {
  register,
  login,
  setPassword,
  getMe,
  forgotPassword
} = require('../controllers/authController')
const { authenticate } = require('../middleware/auth')

// Public routes
router.post('/register', register)
router.post('/login', login)
router.post('/set-password', setPassword)
router.post('/forgot-password', forgotPassword)

// Protected routes
router.get('/me', authenticate, getMe)

module.exports = router