import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import {
  createCompany as createLead,
  deleteCompany,
  updateCompanyFields,
  EditConflictError,
} from '../src/domain/manual-ops'
import { findDuplicateCompany } from '../src/domain/dedupe'
import { MAX_LOGIN_ATTEMPTS } from '../src/auth/rate-limit'
import { createOwners, countRows, OWNER_A } from './helpers'

const BASE = 'http://engine.local'
const login = (email: string, password: string) =>
  SELF.fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  })

describe('duplicate-lead prevention', () => {
  it('findDuplicateCompany matches on domain, phone (any format), and name+city', async () => {
    await createLead(env.DB, { name: 'Acme Coffee', website: 'acme.example', city: 'Lisbon', phone: '+351 21 555 0100' }, 'x')
    // domain
    expect((await findDuplicateCompany(env.DB, { domain: 'acme.example', name: 'Whatever' }))?.reason).toBe('domain')
    // phone, different punctuation, no domain given
    expect((await findDuplicateCompany(env.DB, { name: 'Different Name', city: 'Porto', phone: '+351 (21) 555-0100' }))?.reason).toBe('phone')
    // name + city, different case/spacing, no domain
    expect((await findDuplicateCompany(env.DB, { name: '  acme   COFFEE ', city: 'lisbon' }))?.reason).toBe('name+city')
    // different city → not a duplicate
    expect(await findDuplicateCompany(env.DB, { name: 'Acme Coffee', city: 'Madrid' })).toBeNull()
  })

  it('a websiteless business is not re-created by name+city or phone', async () => {
    await createLead(env.DB, { name: 'Corner Bakery', city: 'Osaka', phone: '+81 6 5555 0101' }, 'x')
    await expect(createLead(env.DB, { name: 'corner bakery', city: 'Osaka' }, 'x')).rejects.toThrow(/duplicate/)
    await expect(createLead(env.DB, { name: 'Totally Different', city: 'Kyoto', phone: '+81.6.5555.0101' }, 'x')).rejects.toThrow(/duplicate/)
    expect(await countRows('companies')).toBe(1)
  })

  it('two different domains with the same name are both allowed (domain is authoritative)', async () => {
    await createLead(env.DB, { name: 'Joes', website: 'joes-nyc.example', city: 'New York' }, 'x')
    const second = await createLead(env.DB, { name: 'Joes', website: 'joes-la.example', city: 'New York' }, 'x')
    expect(second.id).toBeGreaterThan(0)
    expect(await countRows('companies')).toBe(2)
  })
})

describe('login rate limiting', () => {
  it('locks after too many failures, before password verification, and clears on success', async () => {
    await createOwners()
    for (let i = 0; i < MAX_LOGIN_ATTEMPTS; i++) {
      const bad = await login(OWNER_A.email, 'wrong-password')
      expect(bad.status).toBe(401)
    }
    // Now blocked — even the CORRECT password is refused (checked before verify).
    const blocked = await login(OWNER_A.email, OWNER_A.password)
    expect(blocked.status).toBe(429)
    expect(await countRows('activities', "kind = 'login_rate_limited'")).toBeGreaterThan(0)
    expect(await countRows('activities', "kind = 'login_failed'")).toBe(MAX_LOGIN_ATTEMPTS)
  })

  it('a correct login under the threshold works and resets the counter', async () => {
    await createOwners()
    expect((await login(OWNER_A.email, 'nope')).status).toBe(401)
    expect((await login(OWNER_A.email, OWNER_A.password)).status).toBe(200)
    // Counter cleared → a fresh wrong attempt is 401 again, not an early 429.
    expect((await login(OWNER_A.email, 'nope')).status).toBe(401)
  })
})

describe('lead edit/delete compare-and-swap', () => {
  it('updateCompanyFields rejects a stale rev and bumps rev on success', async () => {
    const { id } = await createLead(env.DB, { name: 'Rev Co' }, 'x')
    await updateCompanyFields(env.DB, id, { city: 'Warsaw' }, 'x', 0) // rev 0 → 1
    await expect(updateCompanyFields(env.DB, id, { city: 'Gdansk' }, 'x', 0)).rejects.toThrow(EditConflictError)
    // Correct current rev (1) succeeds.
    await updateCompanyFields(env.DB, id, { city: 'Gdansk' }, 'x', 1)
    const row = await env.DB.prepare('SELECT city, rev FROM companies WHERE id = ?').bind(id).first<{ city: string; rev: number }>()
    expect(row).toEqual({ city: 'Gdansk', rev: 2 })
  })

  it('deleteCompany refuses a stale rev but deletes with the right one', async () => {
    const { id } = await createLead(env.DB, { name: 'Del Co' }, 'x')
    await updateCompanyFields(env.DB, id, { city: 'X' }, 'x') // rev → 1
    const stale = await deleteCompany(env.DB, id, 'x', 0)
    expect(stale).toMatchObject({ deleted: false, conflict: true })
    expect(await countRows('companies', `id = ${id}`)).toBe(1) // still there
    const ok = await deleteCompany(env.DB, id, 'x', 1)
    expect(ok.deleted).toBe(true)
    expect(await countRows('companies', `id = ${id}`)).toBe(0)
  })

  it('PATCH and DELETE return 409 over HTTP on a stale rev', async () => {
    await createOwners()
    const cookie = (await login(OWNER_A.email, OWNER_A.password)).headers.get('set-cookie')!.match(/session=[0-9a-f]+/)![0]
    const { id } = await createLead(env.DB, { name: 'HTTP Rev' }, 'x')
    await updateCompanyFields(env.DB, id, { city: 'Bump' }, 'x') // rev → 1, so 0 is stale

    const patch = await SELF.fetch(`${BASE}/api/companies/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ city: 'Nope', expectedRev: 0 }),
    })
    expect(patch.status).toBe(409)

    const del = await SELF.fetch(`${BASE}/api/companies/${id}?rev=0`, { method: 'DELETE', headers: { Cookie: cookie } })
    expect(del.status).toBe(409)
    expect(await countRows('companies', `id = ${id}`)).toBe(1)
  })
})
