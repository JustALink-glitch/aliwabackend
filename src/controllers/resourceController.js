const supabase = require('../config/supabase')

// GET ALL RESOURCES
const getResources = async (req, res) => {
  try {
    const { courseId } = req.query
    let query = supabase
      .from('resources')
      .select('*, course:courses(name), uploader:users(id, first_name, last_name)')

    if (courseId) {
      query = query.eq('course_id', courseId)
    }

    // Role-based constraints
    if (req.user.role === 'student') {
      const { data: enrollments } = await supabase
        .from('enrollments')
        .select('course_id')
        .eq('student_id', req.user.id)

      if (!enrollments || enrollments.length === 0) {
        return res.json({ resources: [] })
      }

      const courseIds = enrollments.map(e => e.course_id)
      query = query.in('course_id', courseIds)
    }

    const { data: resources, error } = await query.order('created_at', { ascending: false })
    if (error) throw error

    res.json({ resources })
  } catch (error) {
    console.error('getResources error:', error)
    res.status(500).json({ message: 'Failed to fetch resources', error: error.message })
  }
}

// CREATE RESOURCE (Admin or Trainer)
const createResource = async (req, res) => {
  try {
    const { course_id, name, type, url, size } = req.body

    if (!course_id || !name || !url) {
      return res.status(400).json({ message: 'course_id, name and url are required' })
    }

    const { data: resource, error } = await supabase
      .from('resources')
      .insert({
        course_id,
        uploaded_by: req.user.id,
        name,
        type: type || 'link',
        url,
        size: size || 'N/A'
      })
      .select()
      .single()

    if (error) throw error

    res.status(201).json({
      message: 'Resource uploaded successfully',
      resource
    })
  } catch (error) {
    console.error('createResource error:', error)
    res.status(500).json({ message: 'Failed to upload resource', error: error.message })
  }
}

// DELETE RESOURCE (Admin or Trainer)
const deleteResource = async (req, res) => {
  try {
    const { id } = req.params

    if (req.user.role === 'trainer') {
      const { data: existing } = await supabase
        .from('resources')
        .select('uploaded_by')
        .eq('id', id)
        .single()
      
      if (!existing || existing.uploaded_by !== req.user.id) {
        return res.status(403).json({ message: 'You are not authorized to delete this resource' })
      }
    }

    const { error } = await supabase
      .from('resources')
      .delete()
      .eq('id', id)

    if (error) throw error

    res.json({ message: 'Resource deleted successfully' })
  } catch (error) {
    console.error('deleteResource error:', error)
    res.status(500).json({ message: 'Failed to delete resource', error: error.message })
  }
}

module.exports = {
  getResources,
  createResource,
  deleteResource
}
