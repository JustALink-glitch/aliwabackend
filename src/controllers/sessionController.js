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

const getTrainerCourseIds = async (trainerId) => {
  const cohortIds = await getTrainerCohortIds(trainerId)
  let query = supabase.from('courses').select('id')

  if (cohortIds.length > 0) {
    query = query.or(`trainer_id.eq.${trainerId},cohort_id.in.(${cohortIds.join(',')})`)
  } else {
    query = query.eq('trainer_id', trainerId)
  }

  const { data, error } = await query
  if (error) throw error
  return [...new Set((data || []).map(course => course.id).filter(Boolean))]
}

const enrichSessions = async (sessions) => {
  const courseIds = [...new Set((sessions || []).map(session => session.course_id).filter(Boolean))]
  const trainerIds = [...new Set((sessions || []).map(session => session.trainer_id).filter(Boolean))]

  const [coursesRes, trainersRes] = await Promise.all([
    courseIds.length
      ? supabase.from('courses').select('id, name').in('id', courseIds)
      : Promise.resolve({ data: [], error: null }),
    trainerIds.length
      ? supabase.from('users').select('id, first_name, last_name').in('id', trainerIds)
      : Promise.resolve({ data: [], error: null })
  ])

  if (coursesRes.error) throw coursesRes.error
  if (trainersRes.error) throw trainersRes.error

  const coursesById = new Map((coursesRes.data || []).map(course => [course.id, course]))
  const trainersById = new Map((trainersRes.data || []).map(trainer => [trainer.id, trainer]))

  return (sessions || []).map(session => ({
    ...session,
    course: coursesById.get(session.course_id) || null,
    trainer: trainersById.get(session.trainer_id) || null
  }))
}

const getSessions = async (req, res) => {
  try {
    const { courseId, trainerId } = req.query
    let query = supabase.from('sessions').select('*')

    if (courseId) query = query.eq('course_id', courseId)
    if (trainerId) query = query.eq('trainer_id', trainerId)

    if (req.user.role === 'student') {
      const { data: enrollments, error } = await supabase
        .from('enrollments')
        .select('course_id')
        .eq('student_id', req.user.id)
      if (error) throw error

      const courseIds = [...new Set((enrollments || []).map(e => e.course_id).filter(Boolean))]
      query = query.in('course_id', courseIds.length > 0 ? courseIds : [EMPTY_UUID])
    } else if (req.user.role === 'trainer') {
      const courseIds = await getTrainerCourseIds(req.user.id)
      query = query.in('course_id', courseIds.length > 0 ? courseIds : [EMPTY_UUID])
    }

    const { data, error } = await query.order('scheduled_at', { ascending: true })
    if (error) throw error

    const sessions = await enrichSessions(data || [])
    res.json({ success: true, sessions })
  } catch (error) {
    console.error('getSessions error:', error)
    res.status(500).json({ success: false, message: 'Failed to fetch sessions', error: error.message })
  }
}

const getSession = async (req, res) => {
  try {
    const { id } = req.params
    const { data: session, error } = await supabase
      .from('sessions')
      .select('*')
      .eq('id', id)
      .single()

    if (error || !session) {
      return res.status(404).json({ message: 'Session not found' })
    }

    const [enriched] = await enrichSessions([session])
    res.json({ success: true, session: enriched })
  } catch (error) {
    console.error('getSession error:', error)
    res.status(500).json({ success: false, message: 'Failed to fetch session', error: error.message })
  }
}

const createSession = async (req, res) => {
  try {
    const {
      course_id, title, description, scheduled_at, duration,
      zoom_link, zoom_meeting_id, status, is_recurring,
      recurrence_frequency, recurrence_end_date
    } = req.body

    if (!course_id || !title || !scheduled_at) {
      return res.status(400).json({ message: 'course_id, title and scheduled_at are required' })
    }

    const { data: course, error: courseError } = await supabase
      .from('courses')
      .select('id, trainer_id, cohort_id')
      .eq('id', course_id)
      .single()
    if (courseError || !course) {
      return res.status(404).json({ message: 'Course not found' })
    }

    let trainerId = req.body.trainer_id || course.trainer_id || null
    if (req.user.role === 'trainer') {
      const courseIds = await getTrainerCourseIds(req.user.id)
      if (!courseIds.includes(course_id)) {
        return res.status(403).json({ message: 'You are not assigned to this course' })
      }
      trainerId = req.user.id
    }

    const { data: session, error } = await supabase
      .from('sessions')
      .insert({
        course_id,
        trainer_id: trainerId,
        title,
        description: description || '',
        scheduled_at,
        duration: duration || '1 hour',
        zoom_link: zoom_link || '',
        zoom_meeting_id: zoom_meeting_id || '',
        status: status || 'upcoming',
        is_recurring: !!is_recurring,
        recurrence_frequency: recurrence_frequency || null,
        recurrence_end_date: recurrence_end_date || null
      })
      .select()
      .single()

    if (error) throw error

    const [enriched] = await enrichSessions([session])
    res.status(201).json({
      success: true,
      message: 'Session scheduled successfully',
      session: enriched
    })
  } catch (error) {
    console.error('createSession error:', error)
    res.status(500).json({ success: false, message: 'Failed to schedule session', error: error.message })
  }
}

const updateSession = async (req, res) => {
  try {
    const { id } = req.params
    const {
      title, description, scheduled_at, duration,
      zoom_link, zoom_meeting_id, status, recording_url,
      is_recurring, recurrence_frequency, recurrence_end_date
    } = req.body

    if (req.user.role === 'trainer') {
      const { data: existing } = await supabase
        .from('sessions')
        .select('trainer_id')
        .eq('id', id)
        .single()

      if (!existing || existing.trainer_id !== req.user.id) {
        return res.status(403).json({ message: 'You are not authorized to update this session' })
      }
    }

    const { data: session, error } = await supabase
      .from('sessions')
      .update({
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(scheduled_at !== undefined && { scheduled_at }),
        ...(duration !== undefined && { duration }),
        ...(zoom_link !== undefined && { zoom_link }),
        ...(zoom_meeting_id !== undefined && { zoom_meeting_id }),
        ...(status !== undefined && { status }),
        ...(recording_url !== undefined && { recording_url }),
        ...(is_recurring !== undefined && { is_recurring: !!is_recurring }),
        ...(recurrence_frequency !== undefined && { recurrence_frequency: recurrence_frequency || null }),
        ...(recurrence_end_date !== undefined && { recurrence_end_date: recurrence_end_date || null })
      })
      .eq('id', id)
      .select()
      .single()

    if (error) throw error

    const [enriched] = await enrichSessions([session])
    res.json({
      success: true,
      message: 'Session updated successfully',
      session: enriched
    })
  } catch (error) {
    console.error('updateSession error:', error)
    res.status(500).json({ success: false, message: 'Failed to update session', error: error.message })
  }
}

const deleteSession = async (req, res) => {
  try {
    const { id } = req.params

    if (req.user.role === 'trainer') {
      const { data: existing } = await supabase
        .from('sessions')
        .select('trainer_id')
        .eq('id', id)
        .single()

      if (!existing || existing.trainer_id !== req.user.id) {
        return res.status(403).json({ message: 'You are not authorized to delete this session' })
      }
    }

    const { error } = await supabase
      .from('sessions')
      .delete()
      .eq('id', id)

    if (error) throw error

    res.json({ success: true, message: 'Session deleted successfully' })
  } catch (error) {
    console.error('deleteSession error:', error)
    res.status(500).json({ success: false, message: 'Failed to delete session', error: error.message })
  }
}

module.exports = {
  getSessions,
  getSession,
  createSession,
  updateSession,
  deleteSession
}
