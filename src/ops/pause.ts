import { logActivity } from '../domain/activities'

/**
 * Manual emergency stop for outbound email. This is the human kill switch,
 * separate from the automatic bounce breaker: an owner can halt ALL sending
 * instantly and it stays halted until a human resumes it. The send path
 * checks this first, before any other wall.
 */
const PAUSE_KEY = 'sending:paused'

export interface PauseState {
  paused: boolean
  by?: string
  at?: string
  reason?: string
}

export async function getPauseState(kv: KVNamespace): Promise<PauseState> {
  const raw = await kv.get(PAUSE_KEY)
  if (!raw) return { paused: false }
  try {
    return JSON.parse(raw) as PauseState
  } catch {
    return { paused: false }
  }
}

export async function setSendingPaused(
  db: D1Database,
  kv: KVNamespace,
  paused: boolean,
  actor: string,
  now: Date,
  reason?: string,
): Promise<PauseState> {
  const state: PauseState = {
    paused,
    by: actor,
    at: now.toISOString(),
    ...(paused && reason ? { reason: reason.slice(0, 300) } : {}),
  }
  await kv.put(PAUSE_KEY, JSON.stringify(state))
  await logActivity(db, {
    entityType: 'system',
    actor,
    kind: paused ? 'sending_paused' : 'sending_resumed',
    detail: reason ? { reason: reason.slice(0, 300) } : {},
  })
  return state
}
