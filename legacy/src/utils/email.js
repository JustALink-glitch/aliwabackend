const nodemailer = require('nodemailer')

// Create transporter from env vars
const createTransporter = () => {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('⚠️  SMTP not configured. Emails will be logged to console only.')
    return null
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: parseInt(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  })
}

const FROM = process.env.SMTP_FROM || 'Training Ops <noreply@trainingops.com>'
const APP_URL = (process.env.CLIENT_URL || 'http://localhost:5173').split(',')[0].trim()

/**
 * Send trainer invitation email with temporary password
 */
const sendTrainerInvitation = async ({ to, firstName, tempPassword }) => {
  const subject = "You've been invited to Training Ops as a Trainer"
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #e5e7eb;overflow:hidden;">
      <div style="background:#2563EB;padding:24px 32px;">
        <h1 style="color:#fff;font-size:20px;margin:0;">Training Ops</h1>
      </div>
      <div style="padding:32px;">
        <h2 style="font-size:18px;color:#111;margin-bottom:8px;">Welcome, ${firstName}! 👋</h2>
        <p style="color:#6b7280;font-size:14px;line-height:1.6;">
          You've been invited to join <strong>Training Ops</strong> as a <strong>Trainer</strong>.
          Use the temporary credentials below to sign in and set your password.
        </p>
        <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:16px 20px;margin:24px 0;">
          <p style="margin:0 0 8px;font-size:13px;color:#374151;"><strong>Login URL:</strong> <a href="${APP_URL}/login" style="color:#2563EB;">${APP_URL}/login</a></p>
          <p style="margin:0 0 8px;font-size:13px;color:#374151;"><strong>Email:</strong> ${to}</p>
          <p style="margin:0;font-size:13px;color:#374151;"><strong>Temporary Password:</strong> <code style="background:#e5e7eb;padding:2px 6px;border-radius:4px;">${tempPassword}</code></p>
        </div>
        <p style="color:#6b7280;font-size:13px;">You'll be prompted to set a new password on your first login.</p>
        <a href="${APP_URL}/login" style="display:inline-block;background:#2563EB;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:bold;font-size:14px;margin-top:8px;">
          Sign In Now →
        </a>
        <p style="color:#9ca3af;font-size:12px;margin-top:24px;">If you didn't expect this, please ignore this email.</p>
      </div>
    </div>
  `
  const text = `
Welcome, ${firstName}! 👋
You've been invited to join Training Ops as a Trainer.
Login URL: ${APP_URL}/login
Email: ${to}
Temporary Password: ${tempPassword}
`
  return sendEmail({ to, subject, html, text })
}

/**
 * Send student onboarding email with temporary password
 */
const sendStudentOnboarding = async ({ to, firstName, tempPassword, courseName }) => {
  const subject = "Welcome to Training Ops - Your Account is Ready!"
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #e5e7eb;overflow:hidden;">
      <div style="background:#2563EB;padding:24px 32px;">
        <h1 style="color:#fff;font-size:20px;margin:0;">Training Ops</h1>
      </div>
      <div style="padding:32px;">
        <h2 style="font-size:18px;color:#111;margin-bottom:8px;">Welcome, ${firstName}! 🎓</h2>
        <p style="color:#6b7280;font-size:14px;line-height:1.6;">
          You've been enrolled in <strong>${courseName || 'your course'}</strong> on Training Ops.
          Use the credentials below to access your student dashboard.
        </p>
        <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:16px 20px;margin:24px 0;">
          <p style="margin:0 0 8px;font-size:13px;color:#374151;"><strong>Login URL:</strong> <a href="${APP_URL}/login" style="color:#2563EB;">${APP_URL}/login</a></p>
          <p style="margin:0 0 8px;font-size:13px;color:#374151;"><strong>Email:</strong> ${to}</p>
          <p style="margin:0;font-size:13px;color:#374151;"><strong>Temporary Password:</strong> <code style="background:#e5e7eb;padding:2px 6px;border-radius:4px;">${tempPassword}</code></p>
        </div>
        <p style="color:#6b7280;font-size:13px;">You'll be prompted to set a new password on your first login.</p>
        <a href="${APP_URL}/login" style="display:inline-block;background:#2563EB;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:bold;font-size:14px;margin-top:8px;">
          Access My Dashboard →
        </a>
        <p style="color:#9ca3af;font-size:12px;margin-top:24px;">If you didn't expect this, please contact your training coordinator.</p>
      </div>
    </div>
  `
  const text = `
Welcome, ${firstName}! 🎓
You've been enrolled in ${courseName || 'your course'}.
Login URL: ${APP_URL}/login
Email: ${to}
Temporary Password: ${tempPassword}
`
  return sendEmail({ to, subject, html, text })
}

/**
 * Send OTP for password reset
 */
const sendOtpEmail = async ({ to, firstName, otp }) => {
  const subject = 'Your Training Ops Password Reset Code'
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #e5e7eb;overflow:hidden;">
      <div style="background:#2563EB;padding:24px 32px;">
        <h1 style="color:#fff;font-size:20px;margin:0;">Training Ops</h1>
      </div>
      <div style="padding:32px;text-align:center;">
        <h2 style="font-size:18px;color:#111;margin-bottom:8px;">Password Reset Code</h2>
        <p style="color:#6b7280;font-size:14px;line-height:1.6;">Hi ${firstName}, use this code to reset your password. It expires in 15 minutes.</p>
        <div style="background:#f0f7ff;border:2px dashed #2563EB;border-radius:12px;padding:20px;margin:24px 0;display:inline-block;width:100%;box-sizing:border-box;">
          <p style="font-size:40px;font-weight:bold;letter-spacing:12px;color:#2563EB;margin:0;">${otp}</p>
        </div>
        <p style="color:#9ca3af;font-size:12px;">If you didn't request this, please ignore this email. Your password won't change.</p>
      </div>
    </div>
  `
  const text = `
Password Reset Code
Hi ${firstName}, use this code to reset your password. It expires in 15 minutes.
CODE: ${otp}
`
  return sendEmail({ to, subject, html, text })
}

/**
 * Core send function
 */
const sendEmail = async ({ to, subject, html, text }) => {
  const transporter = createTransporter()

  // Fallback: log to console if SMTP not configured
  if (!transporter) {
    console.log(`\n📧 ===== EMAIL (Console Fallback) =====`)
    console.log(`To: ${to}`)
    console.log(`Subject: ${subject}`)
    console.log(`\n${text.trim()}\n`)
    console.log(`=====================================\n`)
    return { success: true, mode: 'console' }
  }

  try {
    const info = await transporter.sendMail({ from: FROM, to, subject, html })
    console.log(`✅ Email sent to ${to}: ${info.messageId}`)
    return { success: true, messageId: info.messageId }
  } catch (error) {
    console.error(`❌ Failed to send email to ${to}:`, error.message)
    throw new Error(`Email delivery failed: ${error.message}`)
  }
}

module.exports = {
  sendTrainerInvitation,
  sendStudentOnboarding,
  sendOtpEmail,
}
