const supabase = require('../config/supabase')

// GET ALL SUBMISSIONS
const getSubmissions = async (req, res) => {
  try {
    const { assignmentId, studentId, status } = req.query
    let query = supabase
      .from('submissions')
      .select('*, assignment:assignments(id, title, total_points, course_id, course:courses(name)), student:users(id, first_name, last_name, email)')

    if (assignmentId) {
      query = query.eq('assignment_id', assignmentId)
    }

    if (status) {
      query = query.eq('status', status)
    }

    // Role-based filtering
    if (req.user.role === 'student') {
      query = query.eq('student_id', req.user.id)
    } else if (req.user.role === 'trainer') {
      // If we want trainers to see only submissions for their assignments
      if (studentId) {
        query = query.eq('student_id', studentId)
      }
      
      // Let's filter by assignments created by this trainer
      const { data: assignments } = await supabase
        .from('assignments')
        .select('id')
        .eq('trainer_id', req.user.id)

      if (assignments && assignments.length > 0) {
        const assignmentIds = assignments.map(a => a.id)
        if (assignmentId) {
          // If already filtering by specific assignment, make sure it's theirs
          if (!assignmentIds.includes(assignmentId)) {
            return res.status(403).json({ message: 'You are not authorized to view submissions for this assignment' })
          }
        } else {
          query = query.in('assignment_id', assignmentIds)
        }
      } else {
        // Trainer has no assignments yet, return empty
        return res.json({ submissions: [] })
      }
    } else {
      // Admins can filter by student
      if (studentId) {
        query = query.eq('student_id', studentId)
      }
    }

    const { data: submissions, error } = await query.order('submitted_at', { ascending: false })
    if (error) throw error

    res.json({ submissions })
  } catch (error) {
    console.error('getSubmissions error:', error)
    res.status(500).json({ message: 'Failed to fetch submissions', error: error.message })
  }
}

// GET SINGLE SUBMISSION
const getSubmission = async (req, res) => {
  try {
    const { id } = req.params
    const { data: submission, error } = await supabase
      .from('submissions')
      .select('*, assignment:assignments(id, title, total_points, course_id, course:courses(name)), student:users(id, first_name, last_name, email)')
      .eq('id', id)
      .single()

    if (error || !submission) {
      return res.status(404).json({ message: 'Submission not found' })
    }

    // Auth check
    if (req.user.role === 'student' && submission.student_id !== req.user.id) {
      return res.status(403).json({ message: 'Unauthorized' })
    }

    res.json({ submission })
  } catch (error) {
    console.error('getSubmission error:', error)
    res.status(500).json({ message: 'Failed to fetch submission', error: error.message })
  }
}

// CREATE SUBMISSION (Student only)
const createSubmission = async (req, res) => {
  try {
    const { assignment_id, file_url, note } = req.body

    if (req.user.role !== 'student') {
      return res.status(403).json({ message: 'Only students can submit assignments' })
    }

    if (!assignment_id || !file_url) {
      return res.status(400).json({ message: 'assignment_id and file_url are required' })
    }

    // Check if student already submitted for this assignment
    const { data: existing } = await supabase
      .from('submissions')
      .select('id')
      .eq('assignment_id', assignment_id)
      .eq('student_id', req.user.id)
      .single()

    let result
    if (existing) {
      // Overwrite/Update existing submission
      const { data, error } = await supabase
        .from('submissions')
        .update({
          file_url,
          note: note || '',
          status: 'pending',
          submitted_at: new Date(),
          grade: null,
          feedback: null,
          graded_at: null
        })
        .eq('id', existing.id)
        .select()
        .single()
      if (error) throw error
      result = data
    } else {
      // Insert new submission
      const { data, error } = await supabase
        .from('submissions')
        .insert({
          assignment_id,
          student_id: req.user.id,
          file_url,
          note: note || '',
          status: 'pending'
        })
        .select()
        .single()
      if (error) throw error
      result = data
    }

    res.status(201).json({
      message: 'Assignment submitted successfully',
      submission: result
    })
  } catch (error) {
    console.error('createSubmission error:', error)
    res.status(500).json({ message: 'Failed to submit assignment', error: error.message })
  }
}

// GRADE SUBMISSION (Trainer or Admin only)
const gradeSubmission = async (req, res) => {
  try {
    const { id } = req.params
    const { grade, feedback } = req.body

    if (grade === undefined) {
      return res.status(400).json({ message: 'Grade is required' })
    }

    // Verify trainer owns the assignment connected to this submission
    if (req.user.role === 'trainer') {
      const { data: submission } = await supabase
        .from('submissions')
        .select('assignment_id')
        .eq('id', id)
        .single()

      if (!submission) {
        return res.status(404).json({ message: 'Submission not found' })
      }

      const { data: assignment } = await supabase
        .from('assignments')
        .select('trainer_id')
        .eq('id', submission.assignment_id)
        .single()

      if (!assignment || assignment.trainer_id !== req.user.id) {
        return res.status(403).json({ message: 'You are not authorized to grade this submission' })
      }
    }

    const { data: graded, error } = await supabase
      .from('submissions')
      .update({
        grade: Number(grade),
        feedback: feedback || '',
        status: 'graded',
        graded_at: new Date()
      })
      .eq('id', id)
      .select()
      .single()

    if (error) throw error

    res.json({
      message: 'Submission graded successfully',
      submission: graded
    })
  } catch (error) {
    console.error('gradeSubmission error:', error)
    res.status(500).json({ message: 'Failed to grade submission', error: error.message })
  }
}

module.exports = {
  getSubmissions,
  getSubmission,
  createSubmission,
  gradeSubmission
}
