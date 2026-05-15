const express = require('express')
const router = express.Router()
const {
  getUsers, getUser, inviteTrainer,
  onboardStudent, bulkOnboardStudents,
  updateUser, revokeAccess, deleteUser
} = require('../controllers/usersController')
const { authenticate, authorize } = require('../middleware/auth')

// All routes require authentication
router.use(authenticate)

// Admin only routes
router.get('/', authorize('admin'), getUsers)
router.get('/:id', authorize('admin', 'trainer'), getUser)
router.post('/invite-trainer', authorize('admin'), inviteTrainer)
router.post('/onboard-student', authorize('admin'), onboardStudent)
router.post('/bulk-onboard', authorize('admin'), bulkOnboardStudents)
router.put('/:id', authorize('admin'), updateUser)
router.patch('/:id/revoke', authorize('admin'), revokeAccess)
router.delete('/:id', authorize('admin'), deleteUser)

module.exports = router