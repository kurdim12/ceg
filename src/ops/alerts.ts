import type { Settings } from '../config/defaults'
import { getBreaker } from '../sequence/breaker'
import { schemaState } from './schema'
import { secretStatus, type SecretSource } from '../settings/store'

export interface Alert {
  kind: 'breaker_tripped' | 'gmail_disconnected' | 'api_key_missing' | 'cron_missed' | 'schema_pending'
  message: string
}

export const LAST_TICK_KEY = 'ops:last_cron_tick'

/**
 * System alerts (map §10): Gmail disconnected · breaker tripped · API
 * credits/keys · cron missed. Shown on the dashboard banner, folded into
 * the recap, and (once live) emailed to maintainer AND owners.
 */
export async function evaluateAlerts(
  db: D1Database,
  source: SecretSource,
  _settings: Settings,
  now: Date,
): Promise<Alert[]> {
  const alerts: Alert[] = []

  // A database behind the deployed code breaks reads/writes that reference new
  // columns. Surface it loudly and first — this is the guard for the exact gap
  // where a deploy shipped code ahead of its migrations.
  const schema = await schemaState(db)
  if (schema.behind) {
    alerts.push({
      kind: 'schema_pending',
      message: `Database update pending: applied ${schema.appliedLatest ?? 'none'}, code expects ${schema.expectedLatest}. Some screens may error until migrations are applied (npm run deploy, or wrangler d1 migrations apply).`,
    })
  }

  const breaker = await getBreaker(source.KV)
  if (breaker.tripped) {
    alerts.push({
      kind: 'breaker_tripped',
      message: `Bounce breaker is TRIPPED (${breaker.reason ?? 'no reason recorded'}). Sending is stopped until a human resets it in Settings.`,
    })
  }

  // Disconnection alert fires for owners who were connected and lost it —
  // an audited gmail_disconnected with no newer gmail_connected.
  const disconnected = await db
    .prepare(
      `SELECT u.id, u.name FROM users u
       WHERE u.role = 'owner_admin' AND u.gmail_connected = 0
         AND EXISTS (SELECT 1 FROM activities a
                     WHERE a.entity_type = 'user' AND a.entity_id = u.id
                       AND a.kind = 'gmail_connected')`,
    )
    .all<{ id: number; name: string }>()
  for (const owner of disconnected.results) {
    alerts.push({
      kind: 'gmail_disconnected',
      message: `${owner.name}'s Gmail is disconnected — their sequences are holding until they reconnect in Settings.`,
    })
  }

  const secrets = await secretStatus(source)
  const missing = Object.entries(secrets)
    .filter(([, present]) => !present)
    .map(([name]) => name)
  if (missing.length > 0) {
    alerts.push({
      kind: 'api_key_missing',
      message: `Holding for keys: ${missing.join(', ')}. Each subsystem fails safe until its key is set in Settings.`,
    })
  }

  const lastTick = await source.KV.get(LAST_TICK_KEY)
  if (lastTick && now.getTime() - new Date(lastTick).getTime() > 2 * 3600 * 1000) {
    alerts.push({
      kind: 'cron_missed',
      message: `The hourly dispatcher last ran at ${lastTick} — more than 2 hours ago. Check the Worker's cron trigger.`,
    })
  }

  return alerts
}
