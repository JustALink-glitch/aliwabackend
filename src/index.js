const express = require('express')
const cors = require('cors')
const dotenv = require('dotenv')

dotenv.config()

const app = express()
const PORT = process.env.PORT || 5000

const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173'
const allowedOrigins = clientUrl.split(',').map(url => url.trim())

// Middleware
app.use(cors({
  origin: allowedOrigins,
  credentials: true
}))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Health check route
app.get('/', (req, res) => {
  res.json({
    message: '🚀 Training Ops API is running!',
    version: '1.0.0',
    status: 'healthy',
    routes: ['/api/auth', '/api/users', '/api/cohorts', '/api/courses']
  })
})

// Lightweight ping route for latency checks
app.all('/api/ping', (req, res) => {
  res.status(200).send('pong')
})

// Routes
app.use('/api/auth', require('./routes/auth'))
app.use('/api/users', require('./routes/users'))
app.use('/api/cohorts', require('./routes/cohorts'))
app.use('/api/courses', require('./routes/courses'))
app.use('/api/assignments', require('./routes/assignments'))
app.use('/api/submissions', require('./routes/submissions'))
app.use('/api/sessions', require('./routes/sessions'))
app.use('/api/attendance', require('./routes/attendance'))
app.use('/api/resources', require('./routes/resources'))
app.use('/api/zoom-webhook', require('./routes/zoom-webhook'))
app.use('/api/zoom', require('./routes/zoom'))

// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.path}` })
})

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(500).json({ message: 'Something went wrong!', error: err.message })
})

// Start server
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`)
    console.log(`📧 SMTP configured: ${!!process.env.SMTP_HOST}`)
  })
}

module.exports = app