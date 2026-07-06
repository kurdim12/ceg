import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { schemaState } from '../src/ops/schema'
import { evaluateAlerts } from '../src/ops/alerts'
import { LATEST_MIGRATION } from '../src/config/migrations'
import { DEFAULT_SETTINGS } from '../src/config/defaults'

const NOW = new Date('2026-07-07T12:00:00Z')

describe('schema-drift guard', () => {
  it('reports current when the DB is at the latest migration', async () => {
    const s = await schemaState(env.DB)
    expect(s.appliedLatest).toBe(LATEST_MIGRATION) // ledger tracked by the test harness
    expect(s.behind).toBe(false)
    expect(s.ok).toBe(true)
  })

  it('detects a database behind the code and raises a schema_pending alert', async () => {
    // Simulate a deploy that shipped code ahead of its migrations.
    await env.DB.prepare('DELETE FROM d1_migrations WHERE name = ?').bind(LATEST_MIGRATION).run()

    const s = await schemaState(env.DB)
    expect(s.behind).toBe(true)
    expect(s.ok).toBe(false)
    expect(s.appliedLatest! < LATEST_MIGRATION).toBe(true)

    const alerts = await evaluateAlerts(env.DB, env, DEFAULT_SETTINGS, NOW)
    const drift = alerts.find((a) => a.kind === 'schema_pending')
    expect(drift).toBeTruthy()
    expect(drift!.message).toContain(LATEST_MIGRATION)
  })

  it('does not cry wolf when there is no migration ledger', async () => {
    await env.DB.prepare('DROP TABLE IF EXISTS d1_migrations').run()
    const s = await schemaState(env.DB)
    expect(s.ok).toBe(true)
    expect(s.behind).toBe(false)
  })
})
