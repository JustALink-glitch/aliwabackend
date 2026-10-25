export interface EmailMessage {
  to: string
  subject: string
  text: string
  html: string
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>
}

/** Development: print the email (including links) to the console instead of sending it. */
export function createConsoleMailer(): Mailer {
  return {
    async send(message) {
      console.info(`\n── email to ${message.to} ──\nSubject: ${message.subject}\n\n${message.text}\n──\n`)
    },
  }
}

/** Production: send through Resend (https://resend.com). */
export function createResendMailer(options: { apiKey: string; from: string }): Mailer {
  return {
    async send(message) {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: options.from, ...message }),
      })
      if (!response.ok) {
        throw new Error(`Resend rejected the email (${response.status}): ${await response.text()}`)
      }
    },
  }
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)

/**
 * The shared transactional template (§07): title, intro, one primary button, note.
 * Final visual design follows the X2 email frames.
 */
export function renderEmail(input: {
  title: string
  intro: string
  /** Label / value rows under the intro (X2 frames: When, Where, Trainer…). */
  details?: { label: string; value: string }[]
  buttonLabel: string
  buttonUrl: string
  note?: string
  /** "Button not working? Paste this into your browser: …" */
  showLinkFallback?: boolean
  /** Small print under the card. */
  footer?: string
}) {
  const text = [
    input.title,
    '',
    input.intro,
    '',
    ...(input.details?.length ? [...input.details.map((d) => `${d.label}: ${d.value}`), ''] : []),
    `${input.buttonLabel}: ${input.buttonUrl}`,
    input.note ? `\n${input.note}` : '',
    input.footer ? `\n${input.footer}` : '',
  ]
    .join('\n')
    .trim()

  const html = `<!doctype html>
<html><body style="margin:0;background:#F8FAFC;font-family:Inter,Arial,sans-serif;color:#151B24">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border:1px solid #E7ECF1;border-radius:12px;padding:32px">
        <tr><td style="font-size:15px;font-weight:600;color:#2563EB;padding-bottom:24px">Synqop</td></tr>
        <tr><td style="font-size:20px;line-height:28px;font-weight:600;padding-bottom:12px">${escapeHtml(input.title)}</td></tr>
        <tr><td style="font-size:14px;line-height:20px;color:#5C6777;padding-bottom:24px">${escapeHtml(input.intro)}</td></tr>
        ${
          input.details?.length
            ? `<tr><td style="padding-bottom:24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E7ECF1;border-radius:8px;border-collapse:separate">${input.details
                .map(
                  (d, i) =>
                    `<tr><td style="font-size:13px;color:#76808D;padding:10px 12px;width:35%;vertical-align:top${i ? ';border-top:1px solid #E7ECF1' : ''}">${escapeHtml(d.label)}</td><td style="font-size:13px;color:#151B24;padding:10px 12px;vertical-align:top${i ? ';border-top:1px solid #E7ECF1' : ''}">${escapeHtml(d.value)}</td></tr>`,
                )
                .join('')}</table></td></tr>`
            : ''
        }
        <tr><td style="padding-bottom:24px">
          <a href="${escapeHtml(input.buttonUrl)}" style="display:inline-block;background:#2563EB;color:#FFFFFF;text-decoration:none;font-size:13px;font-weight:600;padding:10px 16px;border-radius:8px">${escapeHtml(input.buttonLabel)}</a>
        </td></tr>
        ${input.note ? `<tr><td style="font-size:12px;line-height:16px;color:#76808D">${escapeHtml(input.note)}</td></tr>` : ''}
        ${input.showLinkFallback ? `<tr><td style="font-size:12px;line-height:16px;color:#76808D;padding-top:16px;word-break:break-all">Button not working? Paste this into your browser: ${escapeHtml(input.buttonUrl)}</td></tr>` : ''}
      </table>
      ${input.footer ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px"><tr><td style="font-size:12px;line-height:16px;color:#76808D;padding:16px 4px 0">${escapeHtml(input.footer)}</td></tr></table>` : ''}
    </td></tr>
  </table>
</body></html>`

  return { text, html }
}
