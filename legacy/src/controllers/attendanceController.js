const supabase = require('../config/supabase')

// GET ALL ATTENDANCE RECORDS
const getAttendance = async (req, res) => {
  try {
    const { sessionId, studentId } = req.query
    let query = supabase
      .from('attendance')
      .select('*, session:sessions(id, title, scheduled_at), student:users(id, first_name, last_name, email)')

    if (sessionId) {
      query = query.eq('session_id', sessionId)
    }

    if (studentId) {
      query = query.eq('student_id', studentId)
    }

    // Role-based constraints
    if (req.user.role === 'student') {
      query = query.eq('student_id', req.user.id)
    }

    const { data: records, error } = await query.order('created_at', { ascending: false })
    if (error) throw error

    res.json({ attendance: records })
  } catch (error) {
    console.error('getAttendance error:', error)
    res.status(500).json({ message: 'Failed to fetch attendance', error: error.message })
  }
}

// MARK ATTENDANCE (Admin or Trainer)
const markAttendance = async (req, res) => {
  try {
    const { session_id, student_id, status, joined_at, duration_minutes, auto_marked } = req.body

    if (!session_id || !student_id || !status) {
      return res.status(400).json({ message: 'session_id, student_id and status are required' })
    }

    // Check if record exists
    const { data: existing } = await supabase
      .from('attendance')
      .select('id')
      .eq('session_id', session_id)
      .eq('student_id', student_id)
      .single()

    let record
    if (existing) {
      const { data, error } = await supabase
        .from('attendance')
        .update({
          status,
          ...(joined_at !== undefined && { joined_at }),
          ...(duration_minutes !== undefined && { duration_minutes: Number(duration_minutes) }),
          ...(auto_marked !== undefined && { auto_marked: !!auto_marked })
        })
        .eq('id', existing.id)
        .select()
        .single()
      if (error) throw error
      record = data
    } else {
      const { data, error } = await supabase
        .from('attendance')
        .insert({
          session_id,
          student_id,
          status,
          joined_at: joined_at || null,
          duration_minutes: duration_minutes ? Number(duration_minutes) : 0,
          auto_marked: !!auto_marked
        })
        .select()
        .single()
      if (error) throw error
      record = data
    }

    res.json({
      message: 'Attendance marked successfully',
      attendance: record
    })
  } catch (error) {
    console.error('markAttendance error:', error)
    res.status(500).json({ message: 'Failed to mark attendance', error: error.message })
  }
}

module.exports = {
  getAttendance,
  markAttendance
}
