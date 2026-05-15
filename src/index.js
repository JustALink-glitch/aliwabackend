const express = require('express')
const cors = require('cors')
const dotenv = require('dotenv')

// Load environment variables
dotenv.config()

const app = express()
const PORT = process.env.PORT || 5000

// Middleware
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true
}))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Health check route
app.get('/', (req, res) => {
  res.json({
    message: '🚀 Training Ops API is running!',
    version: '1.0.0',
    status: 'healthy'
  })
})

// Routes
app.use('/api/auth', require('./routes/auth'))
app.use('/api/users', require('./routes/users'))
app.use('/api/cohorts', require('./routes/cohorts'))
// app.use('/api/users', require('./routes/users'))
// app.use('/api/cohorts', require('./routes/cohorts'))
// app.use('/api/courses', require('./routes/courses'))
// app.use('/api/attendance', require('./routes/attendance'))

// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: 'Route not found' })
})

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(500).json({ message: 'Something went wrong!', error: err.message })
})

// Start server
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`)
})