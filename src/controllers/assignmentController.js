const supabase = require('../config/supabase')

// GET ALL ASSIGNMENTS
const getAssignments = async (req, res) => {
  try {
    const { courseId, trainerId } = req.query
    let query = supabase.from('assignments').select('*, course:courses(name)')

    if (courseId) {
      query = query.eq('course_id', courseId)
    }

    if (trainerId) {
      query = query.eq('trainer_id', trainerId)
    }

    // Role-based constraints
    if (req.user.role === 'student') {
      const { data: enrollments } = await supabase
        .from('enrollments')
        .select('course_id')
        .eq('student_id', req.user.id)

      if (!enrollments || enrollments.length === 0) {
        return res.json({ assignments: [] })
      }

      const courseIds = enrollments.map(e => e.course_id)
      query = query.in('course_id', courseIds)
    } else if (req.user.role === 'trainer') {
      // Trainers can filter by default, or see all. Usually see their own.
      // If no trainerId filter, we could optionally filter by their trainer_id
      // but let's allow them to see all assignments in courses they teach or general.
    }

    const { data: assignments, error } = await query.order('created_at', { ascending: false })
    if (error) throw error

    res.json({ success: true, assignments: assignments || [] })
  } catch (error) {
    console.error('getAssignments error:', error)
    res.status(500).json({ message: 'Failed to fetch assignments', error: error.message })
  }
}

// GET SINGLE ASSIGNMENT
const getAssignment = async (req, res) => {
  try {
    const { id } = req.params
    const { data: assignment, error } = await supabase
      .from('assignments')
      .select('*, course:courses(name), trainer:users(id, first_name, last_name)')
      .eq('id', id)
      .single()

    if (error || !assignment) {
      return res.status(404).json({ message: 'Assignment not found' })
    }

    res.json({ assignment })
  } catch (error) {
    console.error('getAssignment error:', error)
    res.status(500).json({ message: 'Failed to fetch assignment', error: error.message })
  }
}

// CREATE ASSIGNMENT (Admin or Trainer)
const createAssignment = async (req, res) => {
  try {
    const { course_id, title, description, due_date, total_points } = req.body
    
    if (!course_id || !title) {
      return res.status(400).json({ message: 'course_id and title are required' })
    }

    const trainerId = req.user.role === 'trainer' ? req.user.id : req.body.trainer_id || null

    const { data: assignment, error } = await supabase
      .from('assignments')
      .insert({
        course_id,
        trainer_id: trainerId,
        title,
        description: description || '',
        due_date: due_date || null,
        total_points: total_points !== undefined ? Number(total_points) : 100,
        status: 'active'
      })
      .select()
      .single()

    if (error) throw error

    res.status(201).json({
      success: true,
      message: 'Assignment created successfully',
      assignment
    })
  } catch (error) {
    console.error('createAssignment error:', error)
    res.status(500).json({ message: 'Failed to create assignment', error: error.message })
  }
}

// UPDATE ASSIGNMENT (Admin or Trainer)
const updateAssignment = async (req, res) => {
  try {
    const { id } = req.params
    const { title, description, due_date, total_points, status } = req.body

    // If trainer, verify they own the assignment
    if (req.user.role === 'trainer') {
      const { data: existing } = await supabase
        .from('assignments')
        .select('trainer_id')
        .eq('id', id)
        .single()
      
      if (!existing || existing.trainer_id !== req.user.id) {
        return res.status(403).json({ message: 'You are not authorized to update this assignment' })
      }
    }

    const { data: assignment, error } = await supabase
      .from('assignments')
      .update({
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(due_date !== undefined && { due_date: due_date || null }),
        ...(total_points !== undefined && { total_points: Number(total_points) }),
        ...(status !== undefined && { status }),
      })
      .eq('id', id)
      .select()
      .single()

    if (error) throw error

    res.json({
      message: 'Assignment updated successfully',
      assignment
    })
  } catch (error) {
    console.error('updateAssignment error:', error)
    res.status(500).json({ message: 'Failed to update assignment', error: error.message })
  }
}

// DELETE ASSIGNMENT (Admin or Trainer)
const deleteAssignment = async (req, res) => {
  try {
    const { id } = req.params

    if (req.user.role === 'trainer') {
      const { data: existing } = await supabase
        .from('assignments')
        .select('trainer_id')
        .eq('id', id)
        .single()
      
      if (!existing || existing.trainer_id !== req.user.id) {
        return res.status(403).json({ message: 'You are not authorized to delete this assignment' })
      }
    }

    const { error } = await supabase
      .from('assignments')
      .delete()
      .eq('id', id)

    if (error) throw error

    res.json({ message: 'Assignment deleted successfully' })
  } catch (error) {
    console.error('deleteAssignment error:', error)
    res.status(500).json({ message: 'Failed to delete assignment', error: error.message })
  }
}

module.exports = {
  getAssignments,
  getAssignment,
  createAssignment,
  updateAssignment,
  deleteAssignment
}
