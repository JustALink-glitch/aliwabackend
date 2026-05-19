const express = require('express')
const router = express.Router()
const { authenticateToken, authorizeRoles } = require('../middleware/auth')
const {
  getResources,
  createResource,
  deleteResource
} = require('../controllers/resourceController')

router.get('/', authenticateToken, getResources)
router.post('/', authenticateToken, authorizeRoles('admin', 'trainer'), createResource)
router.delete('/:id', authenticateToken, authorizeRoles('admin', 'trainer'), deleteResource)

module.exports = router
