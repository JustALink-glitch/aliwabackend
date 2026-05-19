const supabase = require('../config/supabase')

// ─────────────────────────────────────────────
// CREATE COHORT
// ─────────────────────────────────────────────
const createCohort = async (req, res) => {
  try {
    const { name, description, startDate, endDate } = req.body

    if (!name || !startDate || !endDate) {
      return res.status(400).json({ message: 'Name, start date and end date are required' })
    }

    if (isNaN(new Date(startDate)) || isNaN(new Date(endDate))) {
      return res.status(400).json({ message: 'Invalid date format.' })
    }

    if (new Date(startDate) > new Date(endDate)) {
      return res.status(400).json({ message: 'Start date must be before end date' })
    }

    const { data, error } = await supabase
      .from('cohorts')
      .insert({
        name: name.trim(),
        description: description ? description.trim() : null,
        start_date: startDate,
        end_date: endDate,
        status: 'upcoming'
      })
      .select()
      .single()

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ message: 'A cohort with this name already exists' })
      }
      throw error
    }

    res.status(201).json({ success: true, message: 'Cohort created successfully', cohort: data })
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to create cohort', error: error.message })
  }
}

// ─────────────────────────────────────────────
// GET ALL COHORTS
// ─────────────────────────────────────────────
const getCohorts = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cohorts')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) throw error

    res.json({ success: true, cohorts: data || [], count: data?.length || 0 })
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get cohorts', error: error.message })
  }
}

// ─────────────────────────────────────────────
// GET SINGLE COHORT
// ─────────────────────────────────────────────
const getCohort = async (req, res) => {
  try {
    const { id } = req.params

    const { data, error } = await supabase
      .from('cohorts')
      .select('*')
      .eq('id', id)
      .single()

    if (error?.code === 'PGRST116' || !data) {
      return res.status(404).json({ success: false, message: 'Cohort not found' })
    }
    if (error) throw error

    res.json({ success: true, cohort: data })
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get cohort', error: error.message })
  }
}

// ─────────────────────────────────────────────
// UPDATE COHORT
// ─────────────────────────────────────────────
const updateCohort = async (req, res) => {
  try {
    const { id } = req.params
    const { name, description, startDate, endDate, status } = req.body

    if (startDate && endDate && new Date(startDate) > new Date(endDate)) {
      return res.status(400).json({ success: false, message: 'Start date must be before end date' })
    }

    const updateData = {}
    if (name !== undefined) updateData.name = name.trim()
    if (description !== undefined) updateData.description = description.trim() || null
    if (startDate !== undefined) updateData.start_date = startDate
    if (endDate !== undefined) updateData.end_date = endDate
    if (status !== undefined) updateData.status = status
    updateData.updated_at = new Date()

    const { data, error } = await supabase
      .from('cohorts')
      .update(updateData)
      .eq('id', id)
      .select()
      .single()

    if (error?.code === 'PGRST116' || !data) {
      return res.status(404).json({ success: false, message: 'Cohort not found' })
    }
    if (error) throw error

    res.json({ success: true, message: 'Cohort updated successfully', cohort: data })
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update cohort', error: error.message })
  }
}

// ─────────────────────────────────────────────
// DELETE COHORT
// ─────────────────────────────────────────────
const deleteCohort = async (req, res) => {
  try {
    const { id } = req.params

    const { data: existingCohort, error: fetchError } = await supabase
      .from('cohorts')
      .select('id, name')
      .eq('id', id)
      .single()

    if (fetchError || !existingCohort) {
      return res.status(404).json({ success: false, message: 'Cohort not found' })
    }

    const { error } = await supabase.from('cohorts').delete().eq('id', id)
    if (error) throw error

    res.json({ success: true, message: 'Cohort deleted successfully', deletedCohort: existingCohort })
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to delete cohort', error: error.message })
  }
}

// ─────────────────────────────────────────────
// ASSIGN TRAINER TO COHORT
// ─────────────────────────────────────────────
const assignTrainer = async (req, res) => {
  try {
    const { id: cohortId } = req.params
    const { trainerId } = req.body

    if (!trainerId) {
      return res.status(400).json({ message: 'Trainer ID is required' })
    }

    // Verify cohort exists
    const { data: cohort, error: cohortError } = await supabase
      .from('cohorts').select('id, name').eq('id', cohortId).single()
    if (cohortError || !cohort) {
      return res.status(404).json({ message: 'Cohort not found' })
    }

    // Verify trainer exists and is actually a trainer
    const { data: trainer, error: trainerError } = await supabase
      .from('users').select('id, first_name, last_name, role').eq('id', trainerId).single()
    if (trainerError || !trainer) {
      return res.status(404).json({ message: 'Trainer not found' })
    }
    if (trainer.role !== 'trainer') {
      return res.status(400).json({ message: 'User is not a trainer' })
    }

    // Upsert into cohort_trainers (create if not exists)
    const { error: assignError } = await supabase
      .from('cohort_trainers')
      .upsert({ cohort_id: cohortId, trainer_id: trainerId }, { onConflict: 'cohort_id,trainer_id' })

    if (assignError) {
      // If cohort_trainers table doesn't exist, fall back to updating cohort directly
      console.warn('cohort_trainers table may not exist, trying cohorts.trainer_id:', assignError.message)
      const { error: fallbackError } = await supabase
        .from('cohorts').update({ trainer_id: trainerId, updated_at: new Date() }).eq('id', cohortId)
      if (fallbackError) throw fallbackError
    }

    res.json({
      success: true,
      message: `${trainer.first_name} ${trainer.last_name} assigned to ${cohort.name}`,
      cohortId,
      trainerId
    })
  } catch (error) {
    res.status(500).json({ message: 'Failed to assign trainer', error: error.message })
  }
}

// ─────────────────────────────────────────────
// ENROLL STUDENT IN COHORT
// ─────────────────────────────────────────────
const enrollStudent = async (req, res) => {
  try {
    const { id: cohortId } = req.params
    const { studentId, courseId } = req.body

    if (!studentId) {
      return res.status(400).json({ message: 'Student ID is required' })
    }

    // Verify cohort exists
    const { data: cohort, error: cohortError } = await supabase
      .from('cohorts').select('id, name').eq('id', cohortId).single()
    if (cohortError || !cohort) {
      return res.status(404).json({ message: 'Cohort not found' })
    }

    // Verify student exists
    const { data: student, error: studentError } = await supabase
      .from('users').select('id, first_name, last_name, role').eq('id', studentId).single()
    if (studentError || !student) {
      return res.status(404).json({ message: 'Student not found' })
    }
    if (student.role !== 'student') {
      return res.status(400).json({ message: 'User is not a student' })
    }

    // Create or update enrollment
    const enrollmentData = {
      student_id: studentId,
      cohort_id: cohortId,
      status: 'active'
    }
    if (courseId) enrollmentData.course_id = courseId

    const { data: existing } = await supabase
      .from('enrollments')
      .select('id')
      .eq('student_id', studentId)
      .eq('cohort_id', cohortId)
      .single()

    let enrollError
    if (existing) {
      const { error } = await supabase
        .from('enrollments')
        .update(enrollmentData)
        .eq('id', existing.id)
      enrollError = error
    } else {
      const { error } = await supabase
        .from('enrollments')
        .insert(enrollmentData)
      enrollError = error
    }

    if (enrollError) throw enrollError

    res.json({
      success: true,
      message: `${student.first_name} ${student.last_name} enrolled in ${cohort.name}`,
      cohortId,
      studentId
    })
  } catch (error) {
    res.status(500).json({ message: 'Failed to enroll student', error: error.message })
  }
}

module.exports = {
  createCohort, getCohorts, getCohort, updateCohort, deleteCohort,
  assignTrainer, enrollStudent
}