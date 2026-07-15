/**
 * Small deny-list of the most common breached passwords (12+ char variants and
 * bases that survive the length check via padding). Checked case-insensitively
 * after stripping digits/symbols from the ends, so "Password12345!" is caught.
 */
export const COMMON_PASSWORDS = new Set([
  'password',
  'passwords',
  'password1234',
  'passw0rd',
  'letmein',
  'welcome',
  'iloveyou',
  'sunshine',
  'princess',
  'football',
  'baseball',
  'superman',
  'trustno1',
  'dragon',
  'monkey',
  'shadow',
  'master',
  'qwerty',
  'qwertyuiop',
  'qwerty123456',
  'asdfghjkl',
  'zxcvbnm',
  '123456789012',
  '111111111111',
  '000000000000',
  'abc123456789',
  'admin',
  'administrator',
  'changeme',
  'changemenow',
  'default',
  'secret',
  'secret123456',
  'leadline',
  'temporary',
  'temp1234',
  'starwars',
  'pokemon',
  'batman',
  'whatever',
  'summer2024',
  'summer2025',
  'winter2024',
  'winter2025',
])

/** Returns a human-readable problem, or null if the password passes policy. */
export function passwordPolicyProblem(password: string, email?: string): string | null {
  if (password.length < 12) {
    return 'Password must be at least 12 characters long'
  }
  if (password.length > 200) {
    return 'Password must be at most 200 characters long'
  }
  const normalized = password.toLowerCase()
  const stripped = normalized.replace(/^[\d\W_]+|[\d\W_]+$/g, '')
  if (COMMON_PASSWORDS.has(normalized) || COMMON_PASSWORDS.has(stripped)) {
    return 'Password is too common — pick something less guessable'
  }
  if (email) {
    const local = email.toLowerCase().split('@')[0]
    if (local && local.length >= 4 && normalized.includes(local)) {
      return 'Password must not contain your email address'
    }
  }
  return null
}
