import { DEFAULT_SETTINGS, validateSettings, type Settings } from '../config/defaults'
import { logActivity } from '../domain/activities'

const SETTINGS_KEY = 'settings'

/**
 * v1 pattern carried by decision: secrets live in KV under `secret:{NAME}`.
 * Key-name contract (execution prompt Context): these exact field names.
 */
export const SECRET_NAMES = [
  'ZEROBOUNCE_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_PLACES_API_KEY',
  'GMAIL_CLIENT_ID',
  'GMAIL_CLIENT_SECRET',
] as const
export type SecretName = (typeof SECRET_NAMES)[number]

export async function getSettings(kv: KVNamespace): Promise<Settings> {
  const raw = await kv.get(SETTINGS_KEY)
  if (!raw) return { ...DEFAULT_SETTINGS }
  // Stored values were validated on write; merge over defaults so new keys
  // added in later versions pick up their defaults automatically.
  return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) }
}

/** Validates, persists, and audits. Throws SettingsValidationError on bad input. */
export async function updateSettings(
  db: D1Database,
  kv: KVNamespace,
  patch: Record<string, unknown>,
  actor: string,
): Promise<Settings> {
  const current = await getSettings(kv)
  const next = validateSettings({ ...current, ...patch })
  await kv.put(SETTINGS_KEY, JSON.stringify(next))
  await logActivity(db, {
    entityType: 'settings',
    actor,
    kind: 'settings_update',
    detail: { changedKeys: Object.keys(patch) },
  })
  return next
}

export function isSecretName(name: string): name is SecretName {
  return (SECRET_NAMES as readonly string[]).includes(name)
}

export async function getSecret(kv: KVNamespace, name: SecretName): Promise<string | null> {
  const value = await kv.get(`secret:${name}`)
  return value && value.trim() !== '' ? value : null
}

/** Set by a human through settings; value never echoed back or logged. */
export async function setSecret(
  db: D1Database,
  kv: KVNamespace,
  name: SecretName,
  value: string,
  actor: string,
): Promise<void> {
  if (value.trim() === '') throw new Error('secret value must not be blank')
  await kv.put(`secret:${name}`, value)
  await logActivity(db, {
    entityType: 'settings',
    actor,
    kind: 'secret_set',
    detail: { name },
  })
}

/** Which external adapters are live (key present) vs holding (fail-safe). */
export async function secretStatus(kv: KVNamespace): Promise<Record<SecretName, boolean>> {
  const entries = await Promise.all(
    SECRET_NAMES.map(async (name) => [name, (await getSecret(kv, name)) !== null] as const),
  )
  return Object.fromEntries(entries) as Record<SecretName, boolean>
}
