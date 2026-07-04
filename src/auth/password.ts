// Workers caps PBKDF2 at 100k iterations; SHA-256, 16-byte salt, 32-byte key.
const ITERATIONS = 100_000
const HASH = 'SHA-256'
const KEY_BYTES = 32

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: HASH, salt: salt as BufferSource, iterations },
    material,
    KEY_BYTES * 8,
  )
  return toHex(bits)
}

/** Format: pbkdf2:{iterations}:{salt-hex}:{hash-hex} */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await derive(password, salt, ITERATIONS)
  return `pbkdf2:${ITERATIONS}:${toHex(salt)}:${hash}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false
  const iterations = Number(parts[1])
  const salt = fromHex(parts[2] ?? '')
  const expected = parts[3] ?? ''
  if (!Number.isInteger(iterations) || iterations < 1 || salt.length === 0) return false
  const actual = await derive(password, salt, iterations)
  // Constant-time compare over fixed-length hex strings.
  if (actual.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}
