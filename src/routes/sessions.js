const express = require('express')
const router = express.Router()
const { authenticateToken, authorizeRoles } = require('../middleware/auth')
const {
  getSessions,
  getSession,
  createSession,
  updateSession,
  deleteSession
} = require('../controllers/sessionController')

router.get('/', authenticateToken, getSessions)
router.get('/:id', authenticateToken, getSession)
router.post('/', authenticateToken, authorizeRoles('admin', 'trainer'), createSession)
router.put('/:id', authenticateToken, authorizeRoles('admin', 'trainer'), updateSession)
router.delete('/:id', authenticateToken, authorizeRoles('admin', 'trainer'), deleteSession)

module.exports = router
