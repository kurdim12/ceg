import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('born-safe skeleton', () => {
  it('serves /health with DRY_RUN on', async () => {
    const res = await SELF.fetch('http://engine.local/health')
    expect(res.status).toBe(200)
    const body = await res.json<{ ok: boolean; dryRun: boolean }>()
    expect(body.ok).toBe(true)
    expect(body.dryRun).toBe(true)
  })

  it('has working KV and D1 bindings', async () => {
    await env.KV.put('smoke', 'ok')
    expect(await env.KV.get('smoke')).toBe('ok')
    const row = await env.DB.prepare('SELECT 1 AS one').first<{ one: number }>()
    expect(row?.one).toBe(1)
  })
})
