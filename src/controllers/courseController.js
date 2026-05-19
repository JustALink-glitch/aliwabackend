const supabase = require('../config/supabase')

// ─────────────────────────────────────────────
// GET ALL COURSES
// ─────────────────────────────────────────────
const getCourses = async (req, res) => {
  try {
    const { status, cohort_id, trainer_id } = req.query
    let query = supabase
      .from('courses')
      .select('*')
      .order('created_at', { ascending: false })

    if (status) query = query.eq('status', status)
    if (cohort_id) query = query.eq('cohort_id', cohort_id)
    if (trainer_id) query = query.eq('trainer_id', trainer_id)

    const { data, error } = await query
    if (error) throw error

    res.json({ success: true, courses: data || [], count: data?.length || 0 })
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get courses', error: error.message })
  }
}

// ─────────────────────────────────────────────
// GET SINGLE COURSE
// ─────────────────────────────────────────────
const getCourse = async (req, res) => {
  try {
    const { id } = req.params

    const { data, error } = await supabase
      .from('courses')
      .select('*')
      .eq('id', id)
      .single()

    if (error?.code === 'PGRST116' || !data) {
      return res.status(404).json({ success: false, message: 'Course not found' })
    }
    if (error) throw error

    res.json({ success: true, course: data })
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get course', error: error.message })
  }
}

// ─────────────────────────────────────────────
// CREATE COURSE
// ─────────────────────────────────────────────
const createCourse = async (req, res) => {
  try {
    const { name, description, duration, category, cohort_id, trainer_id } = req.body

    if (!name) {
      return res.status(400).json({ message: 'Course name is required' })
    }

    const { data, error } = await supabase
      .from('courses')
      .insert({
        name: name.trim(),
        description: description ? description.trim() : null,
        duration: duration || null,
        category: category || null,
        cohort_id: cohort_id || null,
        trainer_id: trainer_id || null,
        status: 'active'
      })
      .select()
      .single()

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ message: 'A course with this name already exists' })
      }
      throw error
    }

    res.status(201).json({ success: true, message: 'Course created successfully', course: data })
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to create course', error: error.message })
  }
}

// ─────────────────────────────────────────────
// UPDATE COURSE
// ─────────────────────────────────────────────
const updateCourse = async (req, res) => {
  try {
    const { id } = req.params
    const { name, description, duration, status, category, cohort_id, trainer_id } = req.body

    const updateData = {}
    if (name !== undefined) updateData.name = name.trim()
    if (description !== undefined) updateData.description = description.trim() || null
    if (duration !== undefined) updateData.duration = duration
    if (status !== undefined) updateData.status = status
    if (category !== undefined) updateData.category = category
    if (cohort_id !== undefined) updateData.cohort_id = cohort_id
    if (trainer_id !== undefined) updateData.trainer_id = trainer_id
    updateData.updated_at = new Date()

    const { data, error } = await supabase
      .from('courses')
      .update(updateData)
      .eq('id', id)
      .select()
      .single()

    if (error?.code === 'PGRST116' || !data) {
      return res.status(404).json({ success: false, message: 'Course not found' })
    }
    if (error) throw error

    res.json({ success: true, message: 'Course updated successfully', course: data })
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update course', error: error.message })
  }
}

// ─────────────────────────────────────────────
// DELETE COURSE
// ─────────────────────────────────────────────
const deleteCourse = async (req, res) => {
  try {
    const { id } = req.params

    const { data: existing, error: fetchError } = await supabase
      .from('courses').select('id, name').eq('id', id).single()

    if (fetchError || !existing) {
      return res.status(404).json({ success: false, message: 'Course not found' })
    }

    const { error } = await supabase.from('courses').delete().eq('id', id)
    if (error) throw error

    res.json({ success: true, message: 'Course deleted successfully', deletedCourse: existing })
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to delete course', error: error.message })
  }
}

module.exports = { getCourses, getCourse, createCourse, updateCourse, deleteCourse }
