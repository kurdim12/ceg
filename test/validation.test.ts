import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { getTool } from '../src/agent/registry'
import { createOwners, loginCookie, countRows, OWNER_A } from './helpers'

const BASE = 'http://engine.local'
const jsonReq = (method: string, cookie: string, body: string) => ({
  method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body,
})
async function cookie(): Promise<string> {
  await createOwners()
  return loginCookie(OWNER_A.email, OWNER_A.password)
}

describe('request validation (zod) on write routes', () => {
  it('malformed JSON returns a clean 400, not a 500', async () => {
    const ck = await cookie()
    const res = await SELF.fetch(`${BASE}/api/companies`, jsonReq('POST', ck, '{not valid json'))
    expect(res.status).toBe(400)
    expect((await res.json<{ error: string }>()).error).toMatch(/JSON/i)
  })

  it('invalid create-lead payload (blank name, bad assignee) returns 400', async () => {
    const ck = await cookie()
    const res = await SELF.fetch(`${BASE}/api/companies`, jsonReq('POST', ck, JSON.stringify({ name: '', assigneeId: 'nope' })))
    expect(res.status).toBe(400)
    expect(await countRows('companies')).toBe(0)
  })

  it('invalid edit payload returns 400', async () => {
    const ck = await cookie()
    const created = await SELF.fetch(`${BASE}/api/companies`, jsonReq('POST', ck, JSON.stringify({ name: 'Edit Me' })))
    const { id } = await created.json<{ id: number }>()
    const bad = await SELF.fetch(`${BASE}/api/companies/${id}`, jsonReq('PATCH', ck, JSON.stringify({ name: '', expectedRev: 'x' })))
    expect(bad.status).toBe(400)
  })

  it('stage update rejects a non-string stage with 400', async () => {
    const ck = await cookie()
    const created = await SELF.fetch(`${BASE}/api/companies`, jsonReq('POST', ck, JSON.stringify({ name: 'Stage Co' })))
    const { id } = await created.json<{ id: number }>()
    const bad = await SELF.fetch(`${BASE}/api/companies/${id}/stage`, jsonReq('PUT', ck, JSON.stringify({ stage: 123 })))
    expect(bad.status).toBe(400)
  })

  it('secret update rejects an empty value without echoing anything secret', async () => {
    const ck = await cookie()
    const res = await SELF.fetch(`${BASE}/api/secrets/OPENROUTER_API_KEY`, jsonReq('PUT', ck, JSON.stringify({ value: '' })))
    expect(res.status).toBe(400)
    const { error } = await res.json<{ error: string }>()
    expect(error).not.toMatch(/sk-|secret/i)
  })

  it('happy paths still work: valid create → 201, valid edit → 200', async () => {
    const ck = await cookie()
    const created = await SELF.fetch(`${BASE}/api/companies`, jsonReq('POST', ck, JSON.stringify({ name: 'Valid Co', city: 'Berlin' })))
    expect(created.status).toBe(201)
    const { id } = await created.json<{ id: number }>()
    const edited = await SELF.fetch(`${BASE}/api/companies/${id}`, jsonReq('PATCH', ck, JSON.stringify({ city: 'Munich' })))
    expect(edited.status).toBe(200)
  })
})

describe('agent tool argument validation (zod)', () => {
  const ctx = () => ({ db: env.DB, kv: env.KV, llm: null, userId: 1 })

  it('send_email rejects malformed args before any write', async () => {
    await createOwners()
    await expect(getTool('send_email')!.execute(ctx(), { companyId: 'x', subject: '', body: '' })).rejects.toThrow()
    expect(await countRows('email_messages')).toBe(0)
  })

  it('bulk_move_stage rejects an empty id list', async () => {
    await createOwners()
    await expect(getTool('bulk_move_stage')!.execute(ctx(), { companyIds: [], to: 'won' })).rejects.toThrow()
  })
})
