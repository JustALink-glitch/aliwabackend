// src/routes/cohorts.js
const express = require('express');
const router = express.Router();

// Import with the names you want to use
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const { createCohort, getCohorts, getCohort, updateCohort, deleteCohort } = require('../controllers/cohortController');

// Use authenticateToken and authorizeRoles
router.post('/', authenticateToken, authorizeRoles('admin'), createCohort);
router.get('/', authenticateToken, getCohorts);
router.get('/:id', authenticateToken, getCohort);
router.put('/:id', authenticateToken, authorizeRoles('admin'), updateCohort);
router.delete('/:id', authenticateToken, authorizeRoles('admin'), deleteCohort);

module.exports = router;