const express = require('express')
const router = express.Router()
const { authenticate, authorize } = require('../middleware/auth')
const {
  getCourses, getCourse, createCourse, updateCourse, deleteCourse
} = require('../controllers/courseController')

// All routes require authentication
router.use(authenticate)

router.get('/', getCourses)
router.get('/:id', getCourse)
router.post('/', authorize('admin'), createCourse)
router.put('/:id', authorize('admin'), updateCourse)
router.delete('/:id', authorize('admin'), deleteCourse)

module.exports = router
