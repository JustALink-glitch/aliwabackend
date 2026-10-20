const express = require('express')
const router = express.Router()
const { authenticate } = require('../middleware/auth')
const { getNotifications, markAllRead, markOneRead } = require('../controllers/notificationController')

router.use(authenticate)
router.get('/', getNotifications)
router.patch('/mark-all-read', markAllRead)
router.patch('/:id/mark-read', markOneRead)

module.exports = router
