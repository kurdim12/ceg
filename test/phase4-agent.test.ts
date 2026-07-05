import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { mockLlm } from '../src/adapters/mocks'
import { AGENT_TOOLS, BULK_CONFIRM_LIMIT, confirmBulk, getTool, type AgentContext } from '../src/agent/registry'
import { runAgentChat } from '../src/agent/loop'
import { createOwners, createCompany, countRows } from './helpers'

function ctx(llmScript?: (prompt: string) => string): AgentContext {
  return {
    db: env.DB,
    kv: env.KV,
    llm: llmScript ? mockLlm(llmScript) : null,
    userId: 1,
  }
}

describe('the tool registry (full-power, no-limits per owner)', () => {
  it('exposes the full capability surface including send, delete, and free stage set', () => {
    const names = AGENT_TOOLS.map((t) => t.name).sort()
    expect(names).toEqual(
      [
        'add_contact', 'add_suppression', 'bulk_move_stage', 'delete_lead', 'draft_reply',
        'get_lead', 'get_settings', 'log_note', 'move_stage', 'send_email', 'set_stage',
        'prepare_drop', 'search_leads', 'update_lead_field',
      ].sort(),
    )
    // The one guard that remains is config-write: settings stay owner-only.
    expect(names.some((n) => n.includes('update_settings') || n.includes('set_config'))).toBe(false)
  })

  it('move_stage enforces CAS legality and refuses drop entirely', async () => {
    await createOwners()
    const id = await createCompany({ stage: 'new' })
    const move = getTool('move_stage')!
    await expect(move.execute(ctx(), { companyId: id, to: 'won' })).rejects.toThrow(/illegal/)
    await expect(move.execute(ctx(), { companyId: id, to: 'dropped' })).rejects.toThrow(/prepare_drop/)
    const ok = await move.execute(ctx(), { companyId: id, to: 'email_sequence' })
    expect(ok.ok).toBe(true)
  })

  it('update_lead_field only touches allowlisted fields', async () => {
    await createOwners()
    const id = await createCompany()
    const update = getTool('update_lead_field')!
    await expect(
      update.execute(ctx(), { companyId: id, field: 'stage', value: 'won' }),
    ).rejects.toThrow(/field must be one of/)
    await expect(
      update.execute(ctx(), { companyId: id, field: 'password_hash', value: 'x' }),
    ).rejects.toThrow(/field must be one of/)
    const ok = await update.execute(ctx(), { companyId: id, field: 'city', value: 'Lisbon' })
    expect(ok.ok).toBe(true)
    expect(await countRows('activities', "actor = 'agent' AND kind = 'field_edit'")).toBe(1)
  })

  it(`bulk boundary: ${BULK_CONFIRM_LIMIT} executes, ${BULK_CONFIRM_LIMIT + 1} previews with zero writes`, async () => {
    await createOwners()
    const bulk = getTool('bulk_move_stage')!

    const twenty: number[] = []
    for (let i = 0; i < BULK_CONFIRM_LIMIT; i++) twenty.push(await createCompany({ stage: 'new' }))
    const executed = await bulk.execute(ctx(), { companyIds: twenty, to: 'email_sequence' })
    expect((executed.results as Array<{ ok: boolean }>).filter((r) => r.ok)).toHaveLength(20)

    const twentyOne: number[] = []
    for (let i = 0; i < BULK_CONFIRM_LIMIT + 1; i++) twentyOne.push(await createCompany({ stage: 'new' }))
    const preview = await bulk.execute(ctx(), { companyIds: twentyOne, to: 'email_sequence' })
    expect(preview.requiresConfirmation).toBe(true)
    expect(await countRows('companies', "stage = 'email_sequence'")).toBe(20) // none of the 21 moved

    // Owner confirms → the 21 move, audited to the owner.
    const result = await confirmBulk(env.DB, env.KV, String(preview.confirmToken), 'user:1')
    expect(result).toEqual({ ok: true, moved: 21 })
    expect(await countRows('companies', "stage = 'email_sequence'")).toBe(41)
    // A second confirm of the same token is dead.
    const replay = await confirmBulk(env.DB, env.KV, String(preview.confirmToken), 'user:1')
    expect(replay.ok).toBe(false)
  })

  it('prepare_drop creates a pending request and changes no stage', async () => {
    await createOwners()
    const id = await createCompany({ stage: 'new' })
    const prepare = getTool('prepare_drop')!
    const result = await prepare.execute(ctx(), { companyId: id, reason: '3 failed calls over 2 weeks' })
    expect(result.ok).toBe(true)
    expect(await countRows('drop_requests', "status = 'pending'")).toBe(1)
    const company = await env.DB.prepare('SELECT stage FROM companies WHERE id = ?')
      .bind(id)
      .first<{ stage: string }>()
    expect(company?.stage).toBe('new')
  })

  it('get_lead reports empty as empty — no invented data', async () => {
    await createOwners()
    const get = getTool('get_lead')!
    const missing = await get.execute(ctx(), { companyId: 99_999 })
    expect(String(missing.error)).toContain('do not guess')
  })
})

describe('agent chat loop', () => {
  it('holds politely without an LLM key', async () => {
    await createOwners()
    const turn = await runAgentChat(ctx(), 'How many leads do we have?')
    expect(turn.reply).toContain('OPENROUTER_API_KEY')
    expect(turn.toolCalls).toHaveLength(0)
  })

  it('executes registry tools and returns a final answer, all audited', async () => {
    await createOwners()
    await createCompany({ name: 'Chat Test Co', stage: 'new' })
    let step = 0
    const turn = await runAgentChat(
      ctx(() => {
        step++
        return step === 1
          ? '{"tool": "search_leads", "args": {"stage": "new"}}'
          : '{"final": "You have 1 new lead: Chat Test Co."}'
      }),
      'What is in my pipeline?',
    )
    expect(turn.toolCalls).toEqual([{ tool: 'search_leads', ok: true }])
    expect(turn.reply).toContain('Chat Test Co')
    expect(await countRows('activities', "kind = 'agent_tool_call'")).toBe(1)
  })

  it('an unknown tool name is inert; nothing happens', async () => {
    await createOwners()
    const id = await createCompany({ stage: 'new' })
    let step = 0
    const turn = await runAgentChat(
      ctx(() => {
        step++
        if (step === 1) return '{"tool": "nuke_everything", "args": {}}'
        return '{"final": "That is not something I can do."}'
      }),
      'Do something impossible.',
    )
    expect(turn.toolCalls).toEqual([{ tool: 'nuke_everything', ok: false }])
    expect(await countRows('companies')).toBe(1)
    expect(await countRows('activities', "kind = 'agent_tool_call'")).toBe(0)
  })

  it('unparseable model output becomes a final answer, never an action', async () => {
    await createOwners()
    const turn = await runAgentChat(ctx(() => 'I think you should… (not JSON)'), 'hello')
    expect(turn.reply).toContain('I think you should')
    expect(turn.toolCalls).toHaveLength(0)
  })
})
