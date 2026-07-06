import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { runAgentChat } from '../src/agent/loop'
import type { LlmAdapter } from '../src/adapters/types'
import { createOwners, loginCookie, OWNER_A } from './helpers'

const BASE = 'http://engine.local'

/** A fake LLM that records the system prompt it was handed, then ends the turn. */
function capturingLlm(): { llm: LlmAdapter; seen: () => string } {
  let system = ''
  return {
    llm: {
      async complete(args) {
        system = args.system
        return JSON.stringify({ final: 'done' })
      },
    },
    seen: () => system,
  }
}

describe('assistant screen context', () => {
  it('injects the open lead into the system prompt as trusted context', async () => {
    await createOwners()
    const { llm, seen } = capturingLlm()
    const turn = await runAgentChat(
      { db: env.DB, kv: env.KV, llm, userId: 1 },
      'move this to won',
      [],
      { view: 'leads', record: { id: 42, name: 'DEMO Atlas Trading' } },
    )
    expect(turn.reply).toBe('done')
    const sys = seen()
    expect(sys).toContain('The owner is on the "leads" screen')
    expect(sys).toContain('#42 "DEMO Atlas Trading"')
  })

  it('omits the context block entirely when no context is provided', async () => {
    const { llm, seen } = capturingLlm()
    await runAgentChat({ db: env.DB, kv: env.KV, llm, userId: 1 }, 'hello', [])
    // The base prompt mentions "CURRENT SCREEN" in its security rule; the
    // context block's own lines must be absent when no context is passed.
    expect(seen()).not.toContain('The owner is on the')
    expect(seen()).not.toContain('They have this lead open')
  })

  it('POST /api/agent/chat accepts a context payload and stays auth-gated', async () => {
    await createOwners()
    const anon = await SELF.fetch(`${BASE}/api/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi', context: { view: 'leads' } }),
    })
    expect(anon.status).toBe(401)

    const cookie = await loginCookie(OWNER_A.email, OWNER_A.password)
    const ok = await SELF.fetch(`${BASE}/api/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        message: 'what is this?',
        context: { view: 'leads', record: { id: 1, name: 'Test Co' } },
      }),
    })
    // LLM key is unset in tests → the agent holds safely with a 200 message.
    expect(ok.status).toBe(200)
    const body = await ok.json<{ reply: string }>()
    expect(body.reply).toMatch(/holding|OPENROUTER/i)
  })
})
