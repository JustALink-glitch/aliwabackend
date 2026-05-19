const supabase = require('../config/supabase')

// GET ALL SESSIONS
const getSessions = async (req, res) => {
  try {
    const { courseId, trainerId } = req.query
    let query = supabase
      .from('sessions')
      .select('*, course:courses(name), trainer:users(id, first_name, last_name)')

    if (courseId) {
      query = query.eq('course_id', courseId)
    }

    if (trainerId) {
      query = query.eq('trainer_id', trainerId)
    }

    // Role-based filtering
    if (req.user.role === 'student') {
      const { data: enrollments } = await supabase
        .from('enrollments')
        .select('course_id')
        .eq('student_id', req.user.id)

      if (!enrollments || enrollments.length === 0) {
        return res.json({ sessions: [] })
      }

      const courseIds = enrollments.map(e => e.course_id)
      query = query.in('course_id', courseIds)
    } else if (req.user.role === 'trainer') {
      // Allow filtering by default. If trainer asks, show theirs.
    }

    const { data: sessions, error } = await query.order('scheduled_at', { ascending: true })
    if (error) throw error

    res.json({ sessions })
  } catch (error) {
    console.error('getSessions error:', error)
    res.status(500).json({ message: 'Failed to fetch sessions', error: error.message })
  }
}

// GET SINGLE SESSION
const getSession = async (req, res) => {
  try {
    const { id } = req.params
    const { data: session, error } = await supabase
      .from('sessions')
      .select('*, course:courses(name), trainer:users(id, first_name, last_name)')
      .eq('id', id)
      .single()

    if (error || !session) {
      return res.status(404).json({ message: 'Session not found' })
    }

    res.json({ session })
  } catch (error) {
    console.error('getSession error:', error)
    res.status(500).json({ message: 'Failed to fetch session', error: error.message })
  }
}

// CREATE SESSION (Admin or Trainer)
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

    const trainerId = req.user.role === 'trainer' ? req.user.id : req.body.trainer_id || null

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

    res.status(201).json({
      message: 'Session scheduled successfully',
      session
    })
  } catch (error) {
    console.error('createSession error:', error)
    res.status(500).json({ message: 'Failed to schedule session', error: error.message })
  }
}

// UPDATE SESSION (Admin or Trainer)
const updateSession = async (req, res) => {
  try {
    const { id } = req.params
    const {
      title, description, scheduled_at, duration,
      zoom_link, zoom_meeting_id, status, recording_url,
      is_recurring, recurrence_frequency, recurrence_end_date
    } = req.body

    // If trainer, verify they scheduled/own this session
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

    res.json({
      message: 'Session updated successfully',
      session
    })
  } catch (error) {
    console.error('updateSession error:', error)
    res.status(500).json({ message: 'Failed to update session', error: error.message })
  }
}

// DELETE SESSION (Admin or Trainer)
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

    res.json({ message: 'Session deleted successfully' })
  } catch (error) {
    console.error('deleteSession error:', error)
    res.status(500).json({ message: 'Failed to delete session', error: error.message })
  }
}

module.exports = {
  getSessions,
  getSession,
  createSession,
  updateSession,
  deleteSession
}
