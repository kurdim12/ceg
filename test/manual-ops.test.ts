import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { deleteCompany, setStageManual } from '../src/domain/manual-ops'
import { getTool } from '../src/agent/registry'
import { createOwners, createCompany, loginCookie, countRows, OWNER_A } from './helpers'

const BASE = 'http://engine.local'

describe('manual stage override', () => {
  it('moves a company to any stage, CAS-guarded and audited', async () => {
    await createOwners()
    const id = await createCompany({ stage: 'new' })
    // Illegal-by-graph jump (new → won) is allowed for a manual owner override.
    const result = await setStageManual(env.DB, { companyId: id, to: 'won', expectedVersion: 0, actor: 'user:1' })
    expect(result).toEqual({ from: 'new', to: 'won' })
    const row = await env.DB.prepare('SELECT stage, stage_version AS v FROM companies WHERE id = ?')
      .bind(id).first<{ stage: string; v: number }>()
    expect(row).toEqual({ stage: 'won', v: 1 })
    expect(await countRows('activities', `entity_id = ${id} AND kind = 'stage_set_manual'`)).toBe(1)
  })

  it('rejects a stale version (conflict) and an unknown stage', async () => {
    await createOwners()
    const id = await createCompany({ stage: 'new' })
    await expect(setStageManual(env.DB, { companyId: id, to: 'imaginary', expectedVersion: 0, actor: 'x' }))
      .rejects.toThrow(/unknown stage/)
    await setStageManual(env.DB, { companyId: id, to: 'replied', expectedVersion: 0, actor: 'x' })
    await expect(setStageManual(env.DB, { companyId: id, to: 'lost', expectedVersion: 0, actor: 'x' }))
      .rejects.toThrow(/conflict/)
  })

  it('is reachable over HTTP and gated by auth', async () => {
    await createOwners()
    const id = await createCompany({ stage: 'new' })
    const anon = await SELF.fetch(`${BASE}/api/companies/${id}/stage`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: 'won' }),
    })
    expect(anon.status).toBe(401)
    const cookie = await loginCookie(OWNER_A.email, OWNER_A.password)
    const ok = await SELF.fetch(`${BASE}/api/companies/${id}/stage`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ stage: 'meeting_booked' }),
    })
    expect(ok.status).toBe(200)
    const row = await env.DB.prepare('SELECT stage FROM companies WHERE id = ?').bind(id).first<{ stage: string }>()
    expect(row?.stage).toBe('meeting_booked')
  })
})

describe('delete company', () => {
  it('removes the company and its rows, keeping an audit trail', async () => {
    await createOwners()
    const id = await createCompany({ stage: 'deal' })
    await env.DB.prepare(`INSERT INTO contacts (company_id, email) VALUES (?, 'x@y.z')`).bind(id).run()
    await env.DB.prepare(`INSERT INTO deals (company_id, status) VALUES (?, 'open')`).bind(id).run()
    const result = await deleteCompany(env.DB, id, 'user:1')
    expect(result.deleted).toBe(true)
    expect(await countRows('companies', `id = ${id}`)).toBe(0)
    expect(await countRows('contacts', `company_id = ${id}`)).toBe(0)
    expect(await countRows('deals', `company_id = ${id}`)).toBe(0)
    // Append-only trail records the deletion.
    expect(await countRows('activities', `entity_id = ${id} AND kind = 'company_deleted'`)).toBe(1)
  })

  it('DELETE /api/companies/:id is auth-gated', async () => {
    await createOwners()
    const id = await createCompany()
    const anon = await SELF.fetch(`${BASE}/api/companies/${id}`, { method: 'DELETE' })
    expect(anon.status).toBe(401)
    const cookie = await loginCookie(OWNER_A.email, OWNER_A.password)
    const ok = await SELF.fetch(`${BASE}/api/companies/${id}`, { method: 'DELETE', headers: { Cookie: cookie } })
    expect(ok.status).toBe(200)
    expect(await countRows('companies', `id = ${id}`)).toBe(0)
  })
})

describe('agent full-power tools', () => {
  const ctx = () => ({ db: env.DB, kv: env.KV, llm: null, userId: 1 })

  it('set_stage overrides freely; send_email queues an approved message; delete_lead removes', async () => {
    await createOwners()
    const id = await createCompany({ stage: 'new' })
    const contact = await env.DB.prepare(`INSERT INTO contacts (company_id, email, email_status) VALUES (?, 'lead@x.z', 'valid') RETURNING id`)
      .bind(id).first<{ id: number }>()
    if (!contact) throw new Error('no contact')

    const staged = await getTool('set_stage')!.execute(ctx(), { companyId: id, to: 'deal' })
    expect(staged.ok).toBe(true)

    const sent = await getTool('send_email')!.execute(ctx(), {
      companyId: id, contactId: contact.id, subject: 'Hi', body: 'Body text',
    })
    expect(sent.ok).toBe(true)
    expect(await countRows('email_messages', "status = 'approved' AND approved_by = 'agent'")).toBe(1)

    const del = await getTool('delete_lead')!.execute(ctx(), { companyId: id })
    expect(del.ok).toBe(true)
    expect(await countRows('companies', `id = ${id}`)).toBe(0)
  })
})
