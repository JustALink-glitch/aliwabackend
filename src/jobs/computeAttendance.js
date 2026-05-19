const supabase = require('../config/supabase')

/**
 * Aggregates raw attendance sessions and computes final attendance summaries.
 * A student is marked 'present' if total joined duration is >= 40% of the scheduled session.
 *
 * @param {string} meetingId The Zoom meeting ID
 * @returns {Promise<Object>} Status of processing
 */
const computeAttendanceForMeeting = async (meetingId) => {
  console.log(`📊 Computing attendance for meeting ID: ${meetingId}`)

  // 1. Fetch the scheduled session details from database
  const { data: sessionData, error: sessionError } = await supabase
    .from('sessions')
    .select('duration, id')
    .eq('zoom_meeting_id', meetingId)
    .maybeSingle()

  let scheduledDurationSeconds = 60 * 60 // Default to 1 hour (3600s)
  if (sessionError) {
    console.warn(`⚠️ Error reading scheduled session: ${sessionError.message}. Using default 1-hour duration.`)
  } else if (sessionData && sessionData.duration) {
    const durationStr = String(sessionData.duration).toLowerCase()
    const numericMatch = durationStr.match(/([0-9.]+)/)
    if (numericMatch) {
      const val = parseFloat(numericMatch[1])
      if (durationStr.includes('minute') || durationStr.includes('min')) {
        scheduledDurationSeconds = val * 60 // minutes to seconds
      } else {
        scheduledDurationSeconds = val * 60 * 60 // hours to seconds
      }
    } else {
      const parsedInt = parseInt(sessionData.duration, 10)
      if (!isNaN(parsedInt)) {
        scheduledDurationSeconds = parsedInt * 60 // fallback: assume minutes
      }
    }
  }

  console.log(`📊 Scheduled duration for meeting ${meetingId}: ${scheduledDurationSeconds} seconds (${scheduledDurationSeconds / 60}m)`)

  // 2. Fetch all raw attendance segments for this meeting
  const { data: rawSessions, error: rawError } = await supabase
    .from('attendance_sessions')
    .select('*')
    .eq('zoom_meeting_id', meetingId)

  if (rawError) {
    console.error('❌ Error fetching raw sessions:', rawError.message)
    throw rawError
  }

  if (!rawSessions || rawSessions.length === 0) {
    console.log(`⚠️ No raw attendance sessions recorded for meeting ${meetingId}.`)
    return { success: true, processed: 0 }
  }

  // 3. Aggregate participant durations by email
  const studentMap = {}
  for (const seg of rawSessions) {
    const email = seg.email.toLowerCase().trim()
    if (!studentMap[email]) {
      studentMap[email] = {
        email: email,
        userId: seg.user_id,
        displayName: seg.display_name,
        totalDurationSeconds: 0
      }
    }
    studentMap[email].totalDurationSeconds += seg.duration_seconds || 0
    if (!studentMap[email].userId && seg.user_id) {
      studentMap[email].userId = seg.user_id
    }
  }

  // 4. Resolve user IDs and build summaries list
  const summariesToUpsert = []
  const emails = Object.keys(studentMap)

  for (const email of emails) {
    const student = studentMap[email]

    // Double-check and resolve user ID if not already set
    if (!student.userId) {
      const { data: user } = await supabase
        .from('users')
        .select('id')
        .eq('email', email)
        .maybeSingle()

      if (user) {
        student.userId = user.id
      }
    }

    // Attendance summary requires an registered user_id (foreign key in db)
    if (!student.userId) {
      console.log(`⚠️ Participant ${email} is not registered in the database. Skipping summary aggregation.`)
      continue
    }

    // Threshold logic: Attended duration >= 40% of scheduled duration
    const attendanceRatio = student.totalDurationSeconds / scheduledDurationSeconds
    const status = attendanceRatio >= 0.40 ? 'present' : 'absent'

    summariesToUpsert.push({
      zoom_meeting_id: meetingId,
      zoom_meeting_uuid: rawSessions[0].zoom_meeting_uuid || '',
      user_id: student.userId,
      email: student.email,
      total_duration_seconds: student.totalDurationSeconds,
      status: status,
      computed_at: new Date().toISOString()
    })
  }

  // 5. Delete existing summaries for this meeting, and insert new ones
  let upsertCount = 0
  for (const summary of summariesToUpsert) {
    try {
      // Clear old computed records for the user/meeting to prevent key collisions
      await supabase
        .from('meeting_attendance_summary')
        .delete()
        .eq('zoom_meeting_id', meetingId)
        .eq('user_id', summary.user_id)

      const { error: insertError } = await supabase
        .from('meeting_attendance_summary')
        .insert(summary)

      if (insertError) {
        console.error(`❌ Error writing attendance summary for ${summary.email}:`, insertError.message)
      } else {
        upsertCount++
      }
    } catch (err) {
      console.error(`❌ Unexpected error processing summary for ${summary.email}:`, err.message)
    }
  }

  console.log(`🏁 Finished. Computed and saved ${upsertCount} student summaries for meeting: ${meetingId}`)
  return { success: true, processed: upsertCount }
}

module.exports = {
  computeAttendanceForMeeting
}