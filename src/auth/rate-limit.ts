/**
 * Login brute-force throttle. A KV counter per identifier, checked BEFORE any
 * password comparison so a locked identifier reveals nothing about validity.
 * The window is a rolling TTL: each failure re-arms it, so a persistent
 * attacker stays locked; a quiet period lets it expire on its own.
 */
export const MAX_LOGIN_ATTEMPTS = 8
export const LOGIN_WINDOW_SECONDS = 15 * 60

function key(id: string): string {
  return `login:rl:${id.toLowerCase()}`
}

export async function loginAttemptsRemaining(kv: KVNamespace, id: string): Promise<number> {
  const raw = await kv.get(key(id))
  const used = raw ? Number(raw) : 0
  return Math.max(0, MAX_LOGIN_ATTEMPTS - used)
}

export async function isLoginBlocked(kv: KVNamespace, id: string): Promise<boolean> {
  return (await loginAttemptsRemaining(kv, id)) <= 0
}

export async function recordLoginFailure(kv: KVNamespace, id: string): Promise<void> {
  const raw = await kv.get(key(id))
  const used = raw ? Number(raw) : 0
  await kv.put(key(id), String(used + 1), { expirationTtl: LOGIN_WINDOW_SECONDS })
}

export async function clearLoginRate(kv: KVNamespace, id: string): Promise<void> {
  await kv.delete(key(id))
}
