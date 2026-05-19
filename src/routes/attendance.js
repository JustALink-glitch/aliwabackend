const express = require('express')
const router = express.Router()
const { authenticateToken, authorizeRoles } = require('../middleware/auth')
const {
  getAttendance,
  markAttendance
} = require('../controllers/attendanceController')

router.get('/', authenticateToken, getAttendance)
router.post('/mark', authenticateToken, authorizeRoles('admin', 'trainer'), markAttendance)

module.exports = router
