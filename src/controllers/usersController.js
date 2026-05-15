const bcrypt = require('bcryptjs')
const supabase = require('../config/supabase')

// Generate random temp password
const generateTempPassword = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789@#'
  let password = ''
  for (let i = 0; i < 10; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return password
}

// GET ALL USERS
const getUsers = async (req, res) => {
  try {
    const { role, status } = req.query
    let query = supabase
      .from('users')
      .select('id, first_name, last_name, email, role, phone, status, is_first_login, created_at')
      .order('created_at', { ascending: false })

    if (role) query = query.eq('role', role)
    if (status) query = query.eq('status', status)

    const { data, error } = await query
    if (error) throw error

    res.json({ users: data })
  } catch (error) {
    res.status(500).json({ message: 'Failed to get users', error: error.message })
  }
}

// GET SINGLE USER
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

// INVITE TRAINER
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

    // Generate temp password
    const tempPassword = generateTempPassword()
    const hashedPassword = await bcrypt.hash(tempPassword, 12)

    // Create trainer
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

    // TODO: Send invitation email with temp password
    console.log(`
      ===== TRAINER INVITATION =====
      Name: ${firstName} ${lastName}
      Email: ${email}
      Temp Password: ${tempPassword}
      ==============================
    `)

    res.status(201).json({
      message: 'Trainer invited successfully',
      trainer: {
        id: trainer.id,
        firstName: trainer.first_name,
        lastName: trainer.last_name,
        email: trainer.email,
        role: trainer.role,
        status: trainer.status
      },
      tempPassword // Remove this in production!
    })
  } catch (error) {
    console.error('Invite trainer error:', error)
    res.status(500).json({ message: 'Failed to invite trainer', error: error.message })
  }
}

// ONBOARD STUDENT
const onboardStudent = async (req, res) => {
  try {
    const { firstName, lastName, email, phone, courseId, cohortId } = req.body

    if (!firstName || !lastName || !email || !courseId || !cohortId) {
      return res.status(400).json({ message: 'All fields are required' })
    }

    // Check if email exists
    const { data: existing } = await supabase
      .from('users').select('id').eq('email', email).single()

    if (existing) {
      return res.status(400).json({ message: 'Email already registered' })
    }

    // Generate temp password
    const tempPassword = generateTempPassword()
    const hashedPassword = await bcrypt.hash(tempPassword, 12)

    // Create student
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

    // Enroll student in course
    const { error: enrollError } = await supabase
      .from('enrollments')
      .insert({
        student_id: student.id,
        course_id: courseId,
        cohort_id: cohortId,
        status: 'active'
      })

    if (enrollError) throw enrollError

    // TODO: Send invitation email
    console.log(`
      ===== STUDENT ONBOARDING =====
      Name: ${firstName} ${lastName}
      Email: ${email}
      Temp Password: ${tempPassword}
      ==============================
    `)

    res.status(201).json({
      message: 'Student onboarded successfully',
      student: {
        id: student.id,
        firstName: student.first_name,
        lastName: student.last_name,
        email: student.email,
        role: student.role,
        status: student.status
      },
      tempPassword // Remove in production!
    })
  } catch (error) {
    console.error('Onboard student error:', error)
    res.status(500).json({ message: 'Failed to onboard student', error: error.message })
  }
}

// BULK ONBOARD STUDENTS (CSV)
const bulkOnboardStudents = async (req, res) => {
  try {
    const { students, courseId, cohortId } = req.body

    if (!students || !Array.isArray(students) || students.length === 0) {
      return res.status(400).json({ message: 'Students array is required' })
    }

    const results = []
    const errors = []

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

        results.push({ email, status: 'success', tempPassword })
        console.log(`Student ${email} onboarded with temp password: ${tempPassword}`)
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

// UPDATE USER
const updateUser = async (req, res) => {
  try {
    const { id } = req.params
    const { firstName, lastName, phone, status } = req.body

    const { data, error } = await supabase
      .from('users')
      .update({
        ...(firstName && { first_name: firstName }),
        ...(lastName && { last_name: lastName }),
        ...(phone && { phone }),
        ...(status && { status }),
        updated_at: new Date()
      })
      .eq('id', id)
      .select()
      .single()

    if (error) throw error

    res.json({
      message: 'User updated successfully',
      user: data
    })
  } catch (error) {
    res.status(500).json({ message: 'Failed to update user', error: error.message })
  }
}

// REVOKE ACCESS (deactivate user)
const revokeAccess = async (req, res) => {
  try {
    const { id } = req.params

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

// DELETE USER
const deleteUser = async (req, res) => {
  try {
    const { id } = req.params

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