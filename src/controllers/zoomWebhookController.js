const crypto = require('crypto')
const supabase = require('../config/supabase')
const { computeAttendanceForMeeting } = require('../jobs/computeAttendance')

/**
 * Handle incoming Zoom Webhook Events
 */
const handleWebhook = async (req, res) => {
  const { event, payload } = req.body

  console.log(`📥 Received Zoom Webhook event: ${event}`)

  try {
    // 1. Zoom URL Validation Challenge (endpoint.url_validation)
    if (event === 'endpoint.url_validation') {
      const plainToken = payload.plainToken
      const webhookSecret = process.env.ZOOM_WEBHOOK_SECRET

      if (!webhookSecret) {
        console.error('❌ ZOOM_WEBHOOK_SECRET is missing for URL validation')
        return res.status(500).json({ error: 'Missing ZOOM_WEBHOOK_SECRET' })
      }

      const hmac = crypto.createHmac('sha256', webhookSecret)
      hmac.update(plainToken)
      const encryptedToken = hmac.digest('hex')

      console.log('✅ Responding to Zoom URL validation challenge')
      return res.status(200).json({
        plainToken,
        encryptedToken
      })
    }

    const { object } = payload
    if (!object) {
      return res.status(400).json({ message: 'Invalid payload structure - missing object' })
    }

    const meetingId = object.id?.toString()
    const meetingUuid = object.uuid

    if (!meetingId) {
      return res.status(400).json({ message: 'Missing meeting ID in webhook payload' })
    }

    // 2. Participant Joined Event
    if (event === 'meeting.participant_joined') {
      const { participant } = object
      if (!participant) return res.status(400).json({ message: 'Missing participant details' })

      const email = participant.email?.toLowerCase().trim()
      const displayName = participant.user_name
      const joinTime = participant.join_time ? new Date(participant.join_time).toISOString() : new Date().toISOString()

      if (!email) {
        console.log(`⚠️ Participant joined without email: ${displayName}. Skipping database logging.`)
        return res.status(200).json({ message: 'Skipped - no email' })
      }

      console.log(`👤 Participant joined: ${displayName} (${email})`)

      // Attempt to resolve User ID in application database
      const { data: user } = await supabase
        .from('users')
        .select('id')
        .eq('email', email)
        .maybeSingle()

      const userId = user?.id || null

      // Insert new join session segment
      const { error } = await supabase
        .from('attendance_sessions')
        .insert({
          zoom_meeting_id: meetingId,
          zoom_meeting_uuid: meetingUuid,
          user_id: userId,
          email: email,
          display_name: displayName,
          join_time: joinTime,
          leave_time: null,
          duration_seconds: 0
        })

      if (error) {
        console.error('❌ Error recording join session:', error.message)
        return res.status(500).json({ error: error.message })
      }

      return res.status(200).json({ success: true, action: 'recorded_join' })
    }

    // 3. Participant Left Event
    if (event === 'meeting.participant_left') {
      const { participant } = object
      if (!participant) return res.status(400).json({ message: 'Missing participant details' })

      const email = participant.email?.toLowerCase().trim()
      const leaveTime = participant.leave_time ? new Date(participant.leave_time).toISOString() : new Date().toISOString()

      if (!email) {
        console.log(`⚠️ Participant left without email: ${participant.user_name}. Skipping.`)
        return res.status(200).json({ message: 'Skipped - no email' })
      }

      console.log(`👤 Participant left: ${participant.user_name} (${email})`)

      // Find the most recent active session for this participant in this meeting that doesn't have a leave time
      const { data: activeSessions, error: selectError } = await supabase
        .from('attendance_sessions')
        .select('*')
        .eq('zoom_meeting_id', meetingId)
        .eq('email', email)
        .is('leave_time', null)
        .order('join_time', { ascending: false })

      if (selectError) {
        console.error('❌ Error finding active participant session:', selectError.message)
        return res.status(500).json({ error: selectError.message })
      }

      if (activeSessions && activeSessions.length > 0) {
        const sessionToUpdate = activeSessions[0]
        const joinDate = new Date(sessionToUpdate.join_time)
        const leaveDate = new Date(leaveTime)
        const durationSeconds = Math.max(0, Math.floor((leaveDate.getTime() - joinDate.getTime()) / 1000))

        const { error: updateError } = await supabase
          .from('attendance_sessions')
          .update({
            leave_time: leaveTime,
            duration_seconds: durationSeconds
          })
          .eq('id', sessionToUpdate.id)

        if (updateError) {
          console.error('❌ Error updating participant leave session:', updateError.message)
          return res.status(500).json({ error: updateError.message })
        }

        console.log(`✅ Session updated successfully. Duration: ${durationSeconds}s`)
      } else {
        // Fallback: If no open join session is found, we create a zero-duration or placeholder record
        console.log(`⚠️ No active join record found for ${email}. Recording standalone left event.`)
        const { data: user } = await supabase
          .from('users')
          .select('id')
          .eq('email', email)
          .maybeSingle()

        const { error: insertError } = await supabase
          .from('attendance_sessions')
          .insert({
            zoom_meeting_id: meetingId,
            zoom_meeting_uuid: meetingUuid,
            user_id: user?.id || null,
            email: email,
            display_name: participant.user_name,
            join_time: leaveTime, // fallback
            leave_time: leaveTime,
            duration_seconds: 0
          })

        if (insertError) {
          console.error('❌ Error recording standalone leave segment:', insertError.message)
        }
      }

      return res.status(200).json({ success: true, action: 'recorded_leave' })
    }

    // 4. Meeting Ended Event
    if (event === 'meeting.ended') {
      console.log(`🏁 Meeting ${meetingId} ended. Triggering automatic attendance calculations...`)

      // Resolve open session segments that didn't get a participant_left webhook (e.g. abrupt disconnect)
      const endTime = new Date().toISOString()
      const { data: openSessions } = await supabase
        .from('attendance_sessions')
        .select('*')
        .eq('zoom_meeting_id', meetingId)
        .is('leave_time', null)

      if (openSessions && openSessions.length > 0) {
        for (const session of openSessions) {
          const durationSeconds = Math.max(0, Math.floor((new Date(endTime).getTime() - new Date(session.join_time).getTime()) / 1000))
          await supabase
            .from('attendance_sessions')
            .update({
              leave_time: endTime,
              duration_seconds: durationSeconds
            })
            .eq('id', session.id)
        }
        console.log(`🧹 Fixed ${openSessions.length} open/unclosed attendance sessions.`)
      }

      // Defer/run computation in background
      // In production, you might offload this to a queue, but here we invoke it asynchronously and respond to Zoom
      computeAttendanceForMeeting(meetingId)
        .then(result => {
          console.log(`📊 Completed automatic attendance computation for meeting ${meetingId}:`, result)
        })
        .catch(err => {
          console.error(`❌ Error in background attendance computation for ${meetingId}:`, err.message)
        })

      return res.status(200).json({ success: true, message: 'Processing meeting attendance' })
    }

    // Default response for unhandled events
    return res.status(200).json({ message: `Received unhandled Zoom event: ${event}` })

  } catch (error) {
    console.error('❌ Server error handling Zoom webhook:', error)
    return res.status(500).json({ message: 'Internal Server Error', error: error.message })
  }
}

module.exports = {
  handleWebhook
}