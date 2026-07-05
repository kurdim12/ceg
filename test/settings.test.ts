import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, validateSettings, SettingsValidationError } from '../src/config/defaults'
import { createOwners, loginCookie, OWNER_A } from './helpers'

const BASE = 'http://engine.local'

describe('Reference A defaults', () => {
  it('carries the map §11 values exactly', () => {
    expect(DEFAULT_SETTINGS.sendCapPerInboxPerDay).toBe(15)
    expect(DEFAULT_SETTINGS.sequenceSteps).toBe(3)
    expect(DEFAULT_SETTINGS.sequenceSpacingHours).toBe(72)
    expect(DEFAULT_SETTINGS.sendWindowStartLocal).toBe('09:00')
    expect(DEFAULT_SETTINGS.sendWindowEndLocal).toBe('16:30')
    expect(DEFAULT_SETTINGS.sendWeekdaysOnly).toBe(true)
    expect(DEFAULT_SETTINGS.sourcingVolumePerDay).toBe(25)
    expect(DEFAULT_SETTINGS.sourcingUtcHour).toBe(23) // 02:00 Amman, UTC+3
    expect(DEFAULT_SETTINGS.bounceWarnPct).toBe(2)
    expect(DEFAULT_SETTINGS.bounceStopPct).toBe(3)
    expect(DEFAULT_SETTINGS.bounceFloorSends).toBe(25)
    expect(DEFAULT_SETTINGS.reverifyStalenessDays).toBe(60)
    expect(DEFAULT_SETTINGS.oooPauseDays).toBe(7)
    expect(DEFAULT_SETTINGS.contactStaggerMinDays).toBe(3)
    expect(DEFAULT_SETTINGS.contactStaggerMaxDays).toBe(4)
    expect(DEFAULT_SETTINGS.phoneGateAttempts).toBe(3)
    expect(DEFAULT_SETTINGS.phoneGateWindowDays).toBe(14)
    expect(DEFAULT_SETTINGS.lostReapproachMonths).toBe(6)
    expect(DEFAULT_SETTINGS.dropRecycleMonths).toBe(12)
    expect(DEFAULT_SETTINGS.currency).toBe('USD')
  })
})

describe('"no cap" is not a configurable state', () => {
  const reject = (patch: Record<string, unknown>) =>
    expect(() => validateSettings(patch)).toThrow(SettingsValidationError)

  it('rejects zero, negative, blank, fractional, and effectively-unlimited caps', () => {
    reject({ sendCapPerInboxPerDay: 0 })
    reject({ sendCapPerInboxPerDay: -5 })
    reject({ sendCapPerInboxPerDay: '' })
    reject({ sendCapPerInboxPerDay: 'unlimited' })
    reject({ sendCapPerInboxPerDay: 14.5 })
    reject({ sendCapPerInboxPerDay: 10_000 })
    reject({ sendCapPerInboxPerDay: null })
  })

  it('rejects inverted thresholds and non-USD currency', () => {
    reject({ bounceWarnPct: 5, bounceStopPct: 3 })
    reject({ contactStaggerMinDays: 6, contactStaggerMaxDays: 4 })
    reject({ currency: 'EUR' })
    reject({ sendWindowStartLocal: '17:00', sendWindowEndLocal: '09:00' })
    reject({ sendWindowStartLocal: 'nine am' })
  })

  it('accepts a legal adjustment', () => {
    const next = validateSettings({ sendCapPerInboxPerDay: 20 })
    expect(next.sendCapPerInboxPerDay).toBe(20)
    expect(next.sequenceSteps).toBe(3)
  })
})

describe('settings routes', () => {
  it('serves defaults with secret presence booleans only', async () => {
    await createOwners()
    const cookie = await loginCookie(OWNER_A.email, OWNER_A.password)
    const res = await SELF.fetch(BASE + '/api/settings', { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const body = await res.json<{
      settings: typeof DEFAULT_SETTINGS
      secrets: Record<string, boolean>
      dryRun: boolean
    }>()
    expect(body.settings.sendCapPerInboxPerDay).toBe(15)
    expect(body.dryRun).toBe(true)
    expect(body.secrets.ZEROBOUNCE_API_KEY).toBe(false)
    expect(Object.values(body.secrets).every((v) => typeof v === 'boolean')).toBe(true)
  })

  it('persists valid updates and rejects no-cap attempts over HTTP', async () => {
    await createOwners()
    const cookie = await loginCookie(OWNER_A.email, OWNER_A.password)
    const ok = await SELF.fetch(BASE + '/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ sendCapPerInboxPerDay: 18 }),
    })
    expect(ok.status).toBe(200)

    const bad = await SELF.fetch(BASE + '/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ sendCapPerInboxPerDay: 0 }),
    })
    expect(bad.status).toBe(400)

    const read = await SELF.fetch(BASE + '/api/settings', { headers: { Cookie: cookie } })
    const body = await read.json<{ settings: { sendCapPerInboxPerDay: number } }>()
    expect(body.settings.sendCapPerInboxPerDay).toBe(18)
  })

  it('stores secrets by exact contract name and audits without echoing values', async () => {
    await createOwners()
    const cookie = await loginCookie(OWNER_A.email, OWNER_A.password)
    const put = await SELF.fetch(BASE + '/api/secrets/ZEROBOUNCE_API_KEY', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ value: 'zb-test-key' }),
    })
    expect(put.status).toBe(200)
    expect(await env.KV.get('secret:ZEROBOUNCE_API_KEY')).toBe('zb-test-key')

    const unknown = await SELF.fetch(BASE + '/api/secrets/NOT_A_SECRET', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ value: 'x' }),
    })
    expect(unknown.status).toBe(404)

    const audit = await env.DB.prepare(
      "SELECT detail FROM activities WHERE kind = 'secret_set' ORDER BY id DESC LIMIT 1",
    ).first<{ detail: string }>()
    expect(audit?.detail).toContain('ZEROBOUNCE_API_KEY')
    expect(audit?.detail).not.toContain('zb-test-key')
  })
})

describe('Cloudflare-secret fallback for API keys', () => {
  it('reads a key from an env binding when KV has none; KV wins when both exist', async () => {
    const { getSecret } = await import('../src/settings/store')
    // Nothing anywhere → null (subsystem holds).
    expect(await getSecret({ KV: env.KV }, 'ZEROBOUNCE_API_KEY')).toBeNull()
    // Cloudflare secret/variable only → used.
    const withEnv = { KV: env.KV, ZEROBOUNCE_API_KEY: 'zb-from-cloudflare' }
    expect(await getSecret(withEnv, 'ZEROBOUNCE_API_KEY')).toBe('zb-from-cloudflare')
    // Dashboard-pasted KV value takes precedence (owners rotate without a deploy).
    await env.KV.put('secret:ZEROBOUNCE_API_KEY', 'zb-from-dashboard')
    expect(await getSecret(withEnv, 'ZEROBOUNCE_API_KEY')).toBe('zb-from-dashboard')
    // Blank values never activate anything.
    expect(await getSecret({ KV: env.KV, OPENROUTER_API_KEY: '   ' }, 'OPENROUTER_API_KEY')).toBeNull()
  })
})
