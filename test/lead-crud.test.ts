import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createCompany as createLead, updateCompanyFields } from '../src/domain/manual-ops'
import { createOwners, loginCookie, countRows, OWNER_A } from './helpers'

const BASE = 'http://engine.local'

describe('create lead (manual entry)', () => {
  it('inserts a manual lead at stage new, derives domain, and audits', async () => {
    await createOwners()
    const { id } = await createLead(
      env.DB,
      { name: 'Harbor Textiles', website: 'harbor-textiles.com', city: 'New York', phone: '+1 212 555 0100' },
      'user:1',
    )
    const row = await env.DB.prepare(
      'SELECT name, domain, website, city, phone, source, stage FROM companies WHERE id = ?',
    ).bind(id).first<Record<string, string>>()
    expect(row).toMatchObject({
      name: 'Harbor Textiles',
      domain: 'harbor-textiles.com',
      website: 'https://harbor-textiles.com',
      city: 'New York',
      source: 'manual',
      stage: 'new',
    })
    expect(await countRows('activities', `entity_id = ${id} AND kind = 'company_created'`)).toBe(1)
  })

  it('requires a name and rejects a duplicate domain', async () => {
    await createOwners()
    await expect(createLead(env.DB, { name: '   ' }, 'user:1')).rejects.toThrow(/name is required/)
    await createLead(env.DB, { name: 'First', website: 'dup.example' }, 'user:1')
    await expect(createLead(env.DB, { name: 'Second', website: 'https://www.dup.example/path' }, 'user:1'))
      .rejects.toThrow(/duplicate/)
  })

  it('POST /api/companies is auth-gated and validates the name', async () => {
    await createOwners()
    const anon = await SELF.fetch(`${BASE}/api/companies`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'X' }),
    })
    expect(anon.status).toBe(401)

    const cookie = await loginCookie(OWNER_A.email, OWNER_A.password)
    const noName = await SELF.fetch(`${BASE}/api/companies`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({}),
    })
    expect(noName.status).toBe(400)

    const ok = await SELF.fetch(`${BASE}/api/companies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'Via HTTP', businessType: 'roaster' }),
    })
    expect(ok.status).toBe(201)
    const body = await ok.json<{ id: number }>()
    expect(await countRows('companies', `id = ${body.id} AND stage = 'new'`)).toBe(1)
  })
})

describe('edit lead fields', () => {
  it('updates allowlisted fields, keeps domain in step, and audits', async () => {
    await createOwners()
    const { id } = await createLead(env.DB, { name: 'Old Name' }, 'user:1')
    const res = await updateCompanyFields(
      env.DB,
      id,
      { name: 'New Name', phone: '+44 20 555 0000', website: 'newsite.io', businessType: 'importer' },
      'user:1',
    )
    expect(res.updated.sort()).toEqual(['businessType', 'name', 'phone', 'website'])
    const row = await env.DB.prepare(
      'SELECT name, phone, website, domain, business_type AS bt FROM companies WHERE id = ?',
    ).bind(id).first<Record<string, string>>()
    expect(row).toMatchObject({
      name: 'New Name',
      phone: '+44 20 555 0000',
      website: 'https://newsite.io',
      domain: 'newsite.io',
      bt: 'importer',
    })
    expect(await countRows('activities', `entity_id = ${id} AND kind = 'lead_edited'`)).toBe(1)
  })

  it('refuses to blank the name, an empty patch, and an unknown company', async () => {
    await createOwners()
    const { id } = await createLead(env.DB, { name: 'Keeps Name' }, 'user:1')
    await expect(updateCompanyFields(env.DB, id, { name: '   ' }, 'x')).rejects.toThrow(/name cannot be empty/)
    await expect(updateCompanyFields(env.DB, id, { notAField: 'x' }, 'x')).rejects.toThrow(/no editable fields/)
    await expect(updateCompanyFields(env.DB, 999999, { city: 'Nowhere' }, 'x')).rejects.toThrow(/no such company/)
  })

  it('PATCH /api/companies/:id is auth-gated and edits over HTTP', async () => {
    await createOwners()
    const { id } = await createLead(env.DB, { name: 'HTTP Edit' }, 'user:1')
    const anon = await SELF.fetch(`${BASE}/api/companies/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ city: 'Berlin' }),
    })
    expect(anon.status).toBe(401)

    const cookie = await loginCookie(OWNER_A.email, OWNER_A.password)
    const ok = await SELF.fetch(`${BASE}/api/companies/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ city: 'Berlin', country: 'DE' }),
    })
    expect(ok.status).toBe(200)
    const row = await env.DB.prepare('SELECT city, country FROM companies WHERE id = ?').bind(id).first()
    expect(row).toEqual({ city: 'Berlin', country: 'DE' })
  })
})

describe('owner self + users endpoints', () => {
  it('GET /api/me reports gmail-connection state; GET /api/users lists both owners', async () => {
    await createOwners()
    const cookie = await loginCookie(OWNER_A.email, OWNER_A.password)

    const me = await (await SELF.fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } })).json<{
      gmailConnected: boolean; bookingLink: string | null
    }>()
    expect(me.gmailConnected).toBe(false)
    expect(me.bookingLink).toBeNull()

    const users = await (await SELF.fetch(`${BASE}/api/users`, { headers: { Cookie: cookie } })).json<{
      users: Array<{ id: number; name: string }>
    }>()
    expect(users.users).toHaveLength(2)
  })
})
