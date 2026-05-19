const express = require('express')
const router = express.Router()
const { authenticateToken, authorizeRoles } = require('../middleware/auth')
const {
  getAssignments,
  getAssignment,
  createAssignment,
  updateAssignment,
  deleteAssignment
} = require('../controllers/assignmentController')

router.get('/', authenticateToken, getAssignments)
router.get('/:id', authenticateToken, getAssignment)
router.post('/', authenticateToken, authorizeRoles('admin', 'trainer'), createAssignment)
router.put('/:id', authenticateToken, authorizeRoles('admin', 'trainer'), updateAssignment)
router.delete('/:id', authenticateToken, authorizeRoles('admin', 'trainer'), deleteAssignment)

module.exports = router
