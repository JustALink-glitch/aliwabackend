const express = require('express')
const cors = require('cors')
const dotenv = require('dotenv')

dotenv.config()

const app = express()
const PORT = process.env.PORT || 5000

const clientUrl = process.env.CLIENT_URL || ''
const allowedOrigins = clientUrl
  .split(',')
  .map(url => url.trim().replace(/\/$/, ''))
  .filter(Boolean)

const defaultAllowedOrigins = [
  'https://aliwavirtualplatform.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000'
]

defaultAllowedOrigins.forEach(origin => {
  if (!allowedOrigins.includes(origin)) allowedOrigins.push(origin)
})

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true)

    const normalizedOrigin = origin.replace(/\/$/, '')
    const isAllowed =
      allowedOrigins.includes(normalizedOrigin) ||
      /^https:\/\/aliwavirtualplatform-[a-z0-9-]+\.vercel\.app$/i.test(normalizedOrigin)

    if (isAllowed) return callback(null, true)
    return callback(new Error(`CORS blocked origin: ${origin}`))
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning'],
  optionsSuccessStatus: 204
}

// CORS must run before logging/routes so preflight requests always receive headers.
app.use(cors(corsOptions))
app.options(/.*/, cors(corsOptions))

app.use((req, res, next) => {
  console.log(`[Incoming] ${req.method} ${req.path} | Origin: ${req.get('origin') || 'None'}`)
  next()
})

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

app.get('/', (req, res) => {
  res.json({
    message: '🚀 Training Ops API is running!',
    version: '1.0.0',
    status: 'healthy',
    allowedOrigins,
    routes: ['/api/auth', '/api/users', '/api/cohorts', '/api/courses']
  })
})

app.all('/api/ping', (req, res) => {
  res.status(200).send('pong')
})

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

app.use((req, res) => {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.path}` })
})

app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(500).json({ message: 'Something went wrong!', error: err.message })
})

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`)
    console.log(`Allowed CORS origins: ${allowedOrigins.join(', ')}`)
    console.log(`SMTP configured: ${!!process.env.SMTP_HOST}`)
  })
}

module.exports = app
