const supabase = require('../config/supabase')

const EMPTY_UUID = '00000000-0000-0000-0000-000000000000'

const getTrainerCohortIds = async (trainerId) => {
  const ids = new Set()

  const { data: assignments, error: assignmentError } = await supabase
    .from('cohort_trainers')
    .select('cohort_id')
    .eq('trainer_id', trainerId)

  if (!assignmentError) {
    ;(assignments || []).forEach(row => row.cohort_id && ids.add(row.cohort_id))
  }

  const { data: fallbackCohorts } = await supabase
    .from('cohorts')
    .select('id')
    .eq('trainer_id', trainerId)

  ;(fallbackCohorts || []).forEach(row => row.id && ids.add(row.id))

  return [...ids]
}

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

    if (req.user.role === 'trainer') {
      const cohortIds = await getTrainerCohortIds(req.user.id)
      const { data: directCourses, error: directError } = await supabase
        .from('courses')
        .select('id')
        .eq('trainer_id', req.user.id)
      if (directError) throw directError

      const directCourseIds = (directCourses || []).map(course => course.id)

      if (cohortIds.length > 0 && directCourseIds.length > 0) {
        query = query.or(`cohort_id.in.(${cohortIds.join(',')}),id.in.(${directCourseIds.join(',')})`)
      } else if (cohortIds.length > 0) {
        query = query.in('cohort_id', cohortIds)
      } else if (directCourseIds.length > 0) {
        query = query.in('id', directCourseIds)
      } else {
        query = query.eq('id', EMPTY_UUID)
      }
    } else if (req.user.role === 'student') {
      const { data: enrollments, error: enrollError } = await supabase
        .from('enrollments')
        .select('course_id')
        .eq('student_id', req.user.id)
      if (enrollError) throw enrollError

      const courseIds = [...new Set((enrollments || []).map(e => e.course_id).filter(Boolean))]
      query = query.in('id', courseIds.length > 0 ? courseIds : [EMPTY_UUID])
    }

    const { data, error } = await query
    if (error) throw error

    res.json({ success: true, courses: data || [], count: data?.length || 0 })
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get courses', error: error.message })
  }
}

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

    if (req.user.role === 'trainer') {
      const cohortIds = await getTrainerCohortIds(req.user.id)
      if (data.trainer_id !== req.user.id && !cohortIds.includes(data.cohort_id)) {
        return res.status(403).json({ success: false, message: 'Forbidden' })
      }
    }

    res.json({ success: true, course: data })
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get course', error: error.message })
  }
}

const createCourse = async (req, res) => {
  try {
    const { name, description, duration, category, cohort_id, trainer_id } = req.body

    if (!name) {
      return res.status(400).json({ message: 'Course name is required' })
    }
    if (!cohort_id) {
      return res.status(400).json({ message: 'Course must be assigned to a cohort' })
    }

    const { data: cohort, error: cohortError } = await supabase
      .from('cohorts')
      .select('id')
      .eq('id', cohort_id)
      .single()
    if (cohortError || !cohort) {
      return res.status(404).json({ message: 'Cohort not found' })
    }

    const { data, error } = await supabase
      .from('courses')
      .insert({
        name: name.trim(),
        description: description ? description.trim() : null,
        duration: duration || null,
        category: category || null,
        cohort_id,
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
    if (cohort_id !== undefined) {
      if (!cohort_id) {
        return res.status(400).json({ success: false, message: 'Course must be assigned to a cohort' })
      }
      const { data: cohort, error: cohortError } = await supabase
        .from('cohorts')
        .select('id')
        .eq('id', cohort_id)
        .single()
      if (cohortError || !cohort) {
        return res.status(404).json({ success: false, message: 'Cohort not found' })
      }
      updateData.cohort_id = cohort_id
    }
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

const assignTrainerToCourse = async (req, res) => {
  try {
    const { id } = req.params
    const { trainerId } = req.body

    if (!trainerId) {
      return res.status(400).json({ message: 'Trainer ID is required' })
    }

    const { data: trainer, error: trainerError } = await supabase
      .from('users')
      .select('id, first_name, last_name, role, status')
      .eq('id', trainerId)
      .single()
    if (trainerError || !trainer) {
      return res.status(404).json({ message: 'Trainer not found' })
    }
    if (trainer.role !== 'trainer') {
      return res.status(400).json({ message: 'Selected user is not a trainer' })
    }
    if (trainer.status === 'inactive') {
      return res.status(400).json({ message: 'Cannot assign an inactive trainer' })
    }

    const { data: course, error } = await supabase
      .from('courses')
      .update({ trainer_id: trainerId, updated_at: new Date() })
      .eq('id', id)
      .select()
      .single()

    if (error?.code === 'PGRST116' || !course) {
      return res.status(404).json({ success: false, message: 'Course not found' })
    }
    if (error) throw error

    if (course.cohort_id) {
      await supabase
        .from('cohort_trainers')
        .upsert({ cohort_id: course.cohort_id, trainer_id: trainerId }, { onConflict: 'cohort_id,trainer_id' })
    }

    res.json({
      success: true,
      message: `${trainer.first_name} ${trainer.last_name} assigned to ${course.name}`,
      course
    })
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to assign trainer to course', error: error.message })
  }
}

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

module.exports = { getCourses, getCourse, createCourse, updateCourse, deleteCourse, assignTrainerToCourse }
