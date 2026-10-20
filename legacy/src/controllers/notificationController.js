const supabase = require('../config/supabase')

const getNotifications = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', req.user.id)
      .neq('type', 'otp')
      .order('created_at', { ascending: false })

    if (error) {
      throw error
    }

    res.json({ success: true, notifications: data || [] })
  } catch (error) {
    console.error('Failed to fetch notifications:', error)
    res.status(500).json({ success: false, message: 'Failed to fetch notifications', error: error.message })
  }
}

const markAllRead = async (req, res) => {
  try {
    const { error } = await supabase
      .from('notifications')
      .update({ read: true })
      .eq('user_id', req.user.id)
      .eq('read', false)

    if (error) throw error
    res.json({ success: true })
  } catch (error) {
    console.error('Failed to mark notifications read:', error)
    res.status(500).json({ success: false, message: 'Failed to mark notifications as read', error: error.message })
  }
}

const markOneRead = async (req, res) => {
  try {
    const { id } = req.params
    const { error } = await supabase
      .from('notifications')
      .update({ read: true })
      .eq('id', id)
      .eq('user_id', req.user.id)

    if (error) throw error
    res.json({ success: true })
  } catch (error) {
    console.error('Failed to mark notification read:', error)
    res.status(500).json({ success: false, message: 'Failed to mark notification as read', error: error.message })
  }
}

module.exports = { getNotifications, markAllRead, markOneRead }
