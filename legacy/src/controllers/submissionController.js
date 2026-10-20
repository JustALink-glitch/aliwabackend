const supabase = require('../config/supabase')

const getTrainerCourseIds = async (trainerId) => {
  const { data: courses, error } = await supabase
    .from('courses')
    .select('id')
    .eq('trainer_id', trainerId)

  if (error) throw error
  return [...new Set((courses || []).map(course => course.id).filter(Boolean))]
}

const getTrainerAssignmentIds = async (trainerId) => {
  const courseIds = await getTrainerCourseIds(trainerId)
  let query = supabase.from('assignments').select('id')

  if (courseIds.length > 0) {
    query = query.or(`trainer_id.eq.${trainerId},course_id.in.(${courseIds.join(',')})`)
  } else {
    query = query.eq('trainer_id', trainerId)
  }

  const { data, error } = await query
  if (error) throw error
  return [...new Set((data || []).map(a => a.id).filter(Boolean))]
}

const canTrainerAccessSubmission = async (trainerId, submissionId) => {
  const { data: submission, error } = await supabase
    .from('submissions')
    .select('assignment_id')
    .eq('id', submissionId)
    .single()

  if (error || !submission) return false

  const { data: assignment, error: assignmentError } = await supabase
    .from('assignments')
    .select('trainer_id, course_id')
    .eq('id', submission.assignment_id)
    .single()

  if (assignmentError || !assignment) return false
  if (assignment.trainer_id === trainerId) return true
  if (!assignment.course_id) return false

  const { data: course, error: courseError } = await supabase
    .from('courses')
    .select('trainer_id')
    .eq('id', assignment.course_id)
    .single()

  if (courseError || !course) return false
  return course.trainer_id === trainerId
}

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
      if (studentId) {
        query = query.eq('student_id', studentId)
      }

      const assignmentIds = await getTrainerAssignmentIds(req.user.id)
      if (assignmentIds.length === 0) {
        return res.json({ submissions: [] })
      }

      if (assignmentId) {
        if (!assignmentIds.includes(assignmentId)) {
          return res.status(403).json({ message: 'You are not authorized to view submissions for this assignment' })
        }
      } else {
        query = query.in('assignment_id', assignmentIds)
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

    if (req.user.role === 'student' && submission.student_id !== req.user.id) {
      return res.status(403).json({ message: 'Unauthorized' })
    }

    if (req.user.role === 'trainer') {
      const hasAccess = await canTrainerAccessSubmission(req.user.id, id)
      if (!hasAccess) {
        return res.status(403).json({ message: 'You are not authorized to view this submission' })
      }
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
    const now = new Date().toISOString()
    if (existing) {
      // Overwrite/Update existing submission
      const { data, error } = await supabase
        .from('submissions')
        .update({
          file_url,
          note: note || '',
          status: 'pending',
          submitted_at: now,
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
          status: 'pending',
          submitted_at: now
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

      if (req.user.role === 'trainer') {
      const hasAccess = await canTrainerAccessSubmission(req.user.id, id)
      if (!hasAccess) {
        return res.status(403).json({ message: 'You are not authorized to grade this submission' })
      }
    }

    const { data: graded, error } = await supabase
      .from('submissions')
      .update({
        grade: Number(grade),
        feedback: feedback || '',
        status: 'graded',
        graded_at: new Date().toISOString()
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
