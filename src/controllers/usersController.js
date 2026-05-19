const bcrypt = require('bcryptjs')
const supabase = require('../config/supabase')
const { sendTrainerInvitation, sendStudentOnboarding } = require('../utils/email')

// Generate random temp password
const generateTempPassword = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789@#'
  let password = ''
  for (let i = 0; i < 12; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return password
}

// ─────────────────────────────────────────────
// GET ALL USERS
// ─────────────────────────────────────────────
const getUsers = async (req, res) => {
  try {
    const { role, status, cohort_id } = req.query
    let query = supabase
      .from('users')
      .select('id, first_name, last_name, email, role, phone, status, is_first_login, created_at')
      .order('created_at', { ascending: false })

    if (role) query = query.eq('role', role)
    if (status) query = query.eq('status', status)

    if (cohort_id) {
      if (role === 'student') {
        const { data: enrollments, error: err } = await supabase
          .from('enrollments')
          .select('student_id')
          .eq('cohort_id', cohort_id)
        if (err) throw err
        const studentIds = (enrollments || []).map(e => e.student_id)
        query = query.in('id', studentIds.length > 0 ? studentIds : ['00000000-0000-0000-0000-000000000000'])
      } else if (role === 'trainer') {
        const { data: cohortTrainers, error: err } = await supabase
          .from('cohort_trainers')
          .select('trainer_id')
          .eq('cohort_id', cohort_id)
        if (err) throw err
        const trainerIds = (cohortTrainers || []).map(e => e.trainer_id)
        
        // Also check if cohort table has a trainer_id column as fallback
        try {
          const { data: cohort, error: cErr } = await supabase
            .from('cohorts')
            .select('trainer_id')
            .eq('id', cohort_id)
            .single()
          if (!cErr && cohort && cohort.trainer_id) {
            trainerIds.push(cohort.trainer_id)
          }
        } catch (e) {
          // Ignore fallback errors
        }
        
        query = query.in('id', trainerIds.length > 0 ? trainerIds : ['00000000-0000-0000-0000-000000000000'])
      }
    }

    const { data, error } = await query
    if (error) throw error

    res.json({ success: true, users: data })
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get users', error: error.message })
  }
}

// ─────────────────────────────────────────────
// GET SINGLE USER
// ─────────────────────────────────────────────
const getUser = async (req, res) => {
  try {
    const { id } = req.params
    const { data, error } = await supabase
      .from('users')
      .select('id, first_name, last_name, email, role, phone, avatar, status, is_first_login, created_at')
      .eq('id', id)
      .single()

    if (error || !data) {
      return res.status(404).json({ message: 'User not found' })
    }

    res.json({ user: data })
  } catch (error) {
    res.status(500).json({ message: 'Failed to get user', error: error.message })
  }
}

// ─────────────────────────────────────────────
// INVITE TRAINER
// ─────────────────────────────────────────────
const inviteTrainer = async (req, res) => {
  try {
    const { firstName, lastName, email, phone, courseId, cohortId } = req.body

    if (!firstName || !lastName || !email) {
      return res.status(400).json({ message: 'First name, last name and email are required' })
    }

    // Check if email exists
    const { data: existing } = await supabase
      .from('users').select('id').eq('email', email).single()

    if (existing) {
      return res.status(400).json({ message: 'Email already registered' })
    }

    const tempPassword = generateTempPassword()
    const hashedPassword = await bcrypt.hash(tempPassword, 12)

    const { data: trainer, error } = await supabase
      .from('users')
      .insert({
        first_name: firstName,
        last_name: lastName,
        email,
        phone: phone || null,
        password: hashedPassword,
        role: 'trainer',
        status: 'pending',
        is_first_login: true
      })
      .select()
      .single()

    if (error) throw error

    // Send invitation email (non-blocking — don't fail if email fails)
    sendTrainerInvitation({ to: email, firstName, tempPassword }).catch(err => {
      console.error('Failed to send trainer invitation email:', err.message)
    })

    res.status(201).json({
      message: 'Trainer invited successfully. An invitation email has been sent.',
      trainer: {
        id: trainer.id,
        firstName: trainer.first_name,
        lastName: trainer.last_name,
        email: trainer.email,
        role: trainer.role,
        status: trainer.status,
        isFirstLogin: trainer.is_first_login
      }
      // tempPassword intentionally NOT returned in response
    })
  } catch (error) {
    console.error('Invite trainer error:', error)
    res.status(500).json({ message: 'Failed to invite trainer', error: error.message })
  }
}

// ─────────────────────────────────────────────
// ONBOARD STUDENT
// ─────────────────────────────────────────────
const onboardStudent = async (req, res) => {
  try {
    const { firstName, lastName, email, phone, courseId, cohortId } = req.body

    if (!firstName || !lastName || !email || !courseId || !cohortId) {
      return res.status(400).json({ message: 'All fields are required' })
    }

    const { data: existing } = await supabase
      .from('users').select('id').eq('email', email).single()

    if (existing) {
      return res.status(400).json({ message: 'Email already registered' })
    }

    const tempPassword = generateTempPassword()
    const hashedPassword = await bcrypt.hash(tempPassword, 12)

    const { data: student, error: studentError } = await supabase
      .from('users')
      .insert({
        first_name: firstName,
        last_name: lastName,
        email,
        phone: phone || null,
        password: hashedPassword,
        role: 'student',
        status: 'pending',
        is_first_login: true
      })
      .select()
      .single()

    if (studentError) throw studentError

    // Enroll student in course + cohort
    const { error: enrollError } = await supabase
      .from('enrollments')
      .insert({
        student_id: student.id,
        course_id: courseId,
        cohort_id: cohortId,
        status: 'active'
      })

    if (enrollError) throw enrollError

    // Fetch course name for email
    let courseName = 'your course'
    const { data: courseData } = await supabase
      .from('courses').select('name').eq('id', courseId).single()
    if (courseData) courseName = courseData.name

    // Send onboarding email (non-blocking)
    sendStudentOnboarding({ to: email, firstName, tempPassword, courseName }).catch(err => {
      console.error('Failed to send student onboarding email:', err.message)
    })

    res.status(201).json({
      message: 'Student onboarded successfully. An invitation email has been sent.',
      student: {
        id: student.id,
        firstName: student.first_name,
        lastName: student.last_name,
        email: student.email,
        role: student.role,
        status: student.status,
        isFirstLogin: student.is_first_login
      }
      // tempPassword intentionally NOT returned in response
    })
  } catch (error) {
    console.error('Onboard student error:', error)
    res.status(500).json({ message: 'Failed to onboard student', error: error.message })
  }
}

// ─────────────────────────────────────────────
// BULK ONBOARD STUDENTS
// ─────────────────────────────────────────────
const bulkOnboardStudents = async (req, res) => {
  try {
    const { students, courseId, cohortId } = req.body

    if (!students || !Array.isArray(students) || students.length === 0) {
      return res.status(400).json({ message: 'Students array is required' })
    }

    const results = []
    const errors = []

    // Fetch course name once
    let courseName = 'your course'
    if (courseId) {
      const { data: courseData } = await supabase
        .from('courses').select('name').eq('id', courseId).single()
      if (courseData) courseName = courseData.name
    }

    for (const student of students) {
      try {
        const { firstName, lastName, email, phone } = student

        if (!firstName || !lastName || !email) {
          errors.push({ email, message: 'Missing required fields' })
          continue
        }

        const { data: existing } = await supabase
          .from('users').select('id').eq('email', email).single()

        if (existing) {
          errors.push({ email, message: 'Email already registered' })
          continue
        }

        const tempPassword = generateTempPassword()
        const hashedPassword = await bcrypt.hash(tempPassword, 12)

        const { data: newStudent, error } = await supabase
          .from('users')
          .insert({
            first_name: firstName, last_name: lastName,
            email, phone: phone || null,
            password: hashedPassword, role: 'student',
            status: 'pending', is_first_login: true
          })
          .select().single()

        if (error) throw error

        if (courseId && cohortId) {
          await supabase.from('enrollments').insert({
            student_id: newStudent.id,
            course_id: courseId,
            cohort_id: cohortId,
            status: 'active'
          })
        }

        // Send onboarding email (non-blocking)
        sendStudentOnboarding({ to: email, firstName, tempPassword, courseName }).catch(err => {
          console.error(`Failed to send email to ${email}:`, err.message)
        })

        results.push({ email, status: 'success' })
        // tempPassword NOT included in response
      } catch (err) {
        errors.push({ email: student.email, message: err.message })
      }
    }

    res.status(201).json({
      message: `${results.length} students onboarded successfully`,
      results,
      errors
    })
  } catch (error) {
    res.status(500).json({ message: 'Bulk onboard failed', error: error.message })
  }
}

// ─────────────────────────────────────────────
// UPDATE USER
// ─────────────────────────────────────────────
const updateUser = async (req, res) => {
  try {
    const { id } = req.params
    const { firstName, lastName, phone, status, first_name, last_name, phone_number } = req.body

    // If not admin, check if user is updating their own profile
    if (req.user.role !== 'admin' && req.user.id !== id) {
      return res.status(403).json({ message: 'Forbidden: You can only update your own profile' })
    }

    // Non-admin cannot update status
    if (req.user.role !== 'admin' && status !== undefined) {
      return res.status(403).json({ message: 'Forbidden: Only administrators can update account status' })
    }

    // Map keys to DB columns
    const updateData = {
      updated_at: new Date()
    }

    const fName = firstName !== undefined ? firstName : first_name
    if (fName !== undefined) updateData.first_name = fName

    const lName = lastName !== undefined ? lastName : last_name
    if (lName !== undefined) updateData.last_name = lName

    const ph = phone !== undefined ? phone : phone_number
    if (ph !== undefined) updateData.phone = ph

    if (req.user.role === 'admin' && status !== undefined) {
      updateData.status = status
    }

    const { data, error } = await supabase
      .from('users')
      .update(updateData)
      .eq('id', id)
      .select()
      .single()

    if (error) throw error

    res.json({
      message: 'User updated successfully',
      user: {
        id: data.id,
        firstName: data.first_name,
        lastName: data.last_name,
        email: data.email,
        role: data.role,
        phone: data.phone,
        status: data.status
      }
    })
  } catch (error) {
    res.status(500).json({ message: 'Failed to update user', error: error.message })
  }
}

// ─────────────────────────────────────────────
// REVOKE ACCESS
// ─────────────────────────────────────────────
const revokeAccess = async (req, res) => {
  try {
    const { id } = req.params

    // Prevent revoking own account
    if (req.user.id === id) {
      return res.status(400).json({ message: 'You cannot revoke your own access' })
    }

    const { error } = await supabase
      .from('users')
      .update({ status: 'inactive', updated_at: new Date() })
      .eq('id', id)

    if (error) throw error

    res.json({ message: 'User access revoked successfully' })
  } catch (error) {
    res.status(500).json({ message: 'Failed to revoke access', error: error.message })
  }
}

// ─────────────────────────────────────────────
// DELETE USER
// ─────────────────────────────────────────────
const deleteUser = async (req, res) => {
  try {
    const { id } = req.params

    // Prevent deleting own account
    if (req.user.id === id) {
      return res.status(400).json({ message: 'You cannot delete your own account' })
    }

    const { error } = await supabase
      .from('users')
      .delete()
      .eq('id', id)

    if (error) throw error

    res.json({ message: 'User deleted successfully' })
  } catch (error) {
    res.status(500).json({ message: 'Failed to delete user', error: error.message })
  }
}

module.exports = {
  getUsers, getUser, inviteTrainer,
  onboardStudent, bulkOnboardStudents,
  updateUser, revokeAccess, deleteUser
}