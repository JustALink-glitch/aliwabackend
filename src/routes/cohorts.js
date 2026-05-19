const express = require('express')
const router = express.Router()
const { authenticateToken, authorizeRoles } = require('../middleware/auth')
const {
  createCohort, getCohorts, getCohort, updateCohort, deleteCohort,
  assignTrainer, enrollStudent
} = require('../controllers/cohortController')

router.post('/', authenticateToken, authorizeRoles('admin'), createCohort)
router.get('/', authenticateToken, getCohorts)
router.get('/:id', authenticateToken, getCohort)
router.put('/:id', authenticateToken, authorizeRoles('admin'), updateCohort)
router.delete('/:id', authenticateToken, authorizeRoles('admin'), deleteCohort)

// Cohort membership
router.post('/:id/assign-trainer', authenticateToken, authorizeRoles('admin'), assignTrainer)
router.post('/:id/enroll-student', authenticateToken, authorizeRoles('admin'), enrollStudent)

module.exports = router