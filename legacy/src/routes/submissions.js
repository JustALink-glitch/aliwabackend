const express = require('express')
const router = express.Router()
const { authenticateToken, authorizeRoles } = require('../middleware/auth')
const {
  getSubmissions,
  getSubmission,
  createSubmission,
  gradeSubmission
} = require('../controllers/submissionController')

router.get('/', authenticateToken, getSubmissions)
router.get('/:id', authenticateToken, getSubmission)
router.post('/', authenticateToken, authorizeRoles('student'), createSubmission)
router.patch('/:id/grade', authenticateToken, authorizeRoles('admin', 'trainer'), gradeSubmission)

module.exports = router
