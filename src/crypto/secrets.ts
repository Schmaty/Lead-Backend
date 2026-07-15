import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

/**
 * Encrypt a secret with AES-256-GCM. Output format: base64(iv):base64(tag):base64(ciphertext)
 */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`
}

export function decryptSecret(blob: string, key: Buffer): string {
  const parts = blob.split(':')
  if (parts.length !== 3) throw new Error('Malformed encrypted secret')
  const [ivB64, tagB64, dataB64] = parts
  const iv = Buffer.from(ivB64!, 'base64')
  const tag = Buffer.from(tagB64!, 'base64')
  const data = Buffer.from(dataB64!, 'base64')
  if (iv.length !== IV_LENGTH || tag.length !== AUTH_TAG_LENGTH) throw new Error('Malformed encrypted secret')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

/** Mask a secret for display: first 3 chars + ellipsis + last 4, never the middle. */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '…' + value.slice(-2)
  return `${value.slice(0, 3)}…${value.slice(-4)}`
}
