const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60

export interface Session {
  userId: number
  email: string
  name: string
  createdAt: string
}

function sessionKey(token: string): string {
  return `session:${token}`
}

export async function createSession(
  kv: KVNamespace,
  user: { id: number; email: string; name: string },
  now: Date,
): Promise<string> {
  const raw = crypto.getRandomValues(new Uint8Array(32))
  const token = [...raw].map((b) => b.toString(16).padStart(2, '0')).join('')
  const session: Session = {
    userId: user.id,
    email: user.email,
    name: user.name,
    createdAt: now.toISOString(),
  }
  await kv.put(sessionKey(token), JSON.stringify(session), {
    expirationTtl: SESSION_TTL_SECONDS,
  })
  return token
}

export async function getSession(kv: KVNamespace, token: string): Promise<Session | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null
  const raw = await kv.get(sessionKey(token))
  return raw ? (JSON.parse(raw) as Session) : null
}

export async function destroySession(kv: KVNamespace, token: string): Promise<void> {
  await kv.delete(sessionKey(token))
}
