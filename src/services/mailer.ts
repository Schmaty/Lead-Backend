import nodemailer from 'nodemailer'
import type { AppConfig } from '../config.js'

/**
 * Send an email if SMTP is configured. Returns true when a message was sent.
 * Callers fall back to returning/logging links when this returns false.
 */
export async function sendMail(
  config: AppConfig,
  message: { to: string; subject: string; text: string },
): Promise<boolean> {
  if (!config.smtpUrl) return false
  const transport = nodemailer.createTransport(config.smtpUrl)
  await transport.sendMail({ from: config.smtpFrom, ...message })
  return true
}
