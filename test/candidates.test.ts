import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import {
  approveCandidate,
  createLeadCandidate,
  getCandidate,
  listCandidates,
  rejectCandidate,
  scoreCandidate,
} from '../src/domain/candidates'
import { ingestBusiness } from '../src/pipeline/ingest'
import { mockSiteFetcher } from '../src/adapters/mocks'
import { createOwners, loginCookie, countRows, OWNER_A } from './helpers'

const BASE = 'http://engine.local'
const NOW = new Date('2026-07-07T10:00:00Z')

const BIZ = {
  name: 'Candid Coffee', website: 'https://candid.example',
  phone: '+48 22 555 0199', address: 'ul. Testowa 2', city: 'Warsaw', country: 'PL',
}
function fetcher() {
  return mockSiteFetcher({
    'https://candid.example': '<a href="mailto:hello@candid.example">mail</a>',
  })
}

describe('scoreCandidate (deterministic + explainable)', () => {
  it('is a pure function: same input, same score and reasons', () => {
    const a = scoreCandidate({ extractedEmail: 'x@y.z', website: 'https://y.z', domain: 'y.z', phone: '+1', name: 'Y', city: 'Oslo' })
    const b = scoreCandidate({ extractedEmail: 'x@y.z', website: 'https://y.z', domain: 'y.z', phone: '+1', name: 'Y', city: 'Oslo' })
    expect(a).toEqual(b)
    expect(a.confidence).toBe(100) // 40 + 20 + 15 + 15 + 10
    expect(a.reasons.length).toBe(5)
  })
  it('scores partial signals below the max and never exceeds 100', () => {
    expect(scoreCandidate({ phone: '+1', name: 'A', city: 'B' }).confidence).toBe(30)
    expect(scoreCandidate({}).confidence).toBe(0)
    expect(scoreCandidate({ extractedEmail: 'a@b.c', website: 'https://b.c', domain: 'b.c', phone: '1', name: 'A', city: 'C' }).confidence).toBeLessThanOrEqual(100)
  })
})

describe('sourcing creates candidates, never companies', () => {
  it('ingestBusiness parks a scored candidate with evidence and touches nothing else', async () => {
    await createOwners()
    const outcome = await ingestBusiness(env.DB, BIZ, { fetchSite: fetcher(), now: NOW })
    expect(outcome.kind).toBe('candidate')

    // No CRM side effects at all — this is the whole point of the change.
    expect(await countRows('companies')).toBe(0)
    expect(await countRows('contacts')).toBe(0)
    expect(await countRows('sequence_enrollments')).toBe(0)
    expect(await countRows('email_messages')).toBe(0)

    const [cand] = await listCandidates(env.DB, 'new')
    expect(cand!.name).toBe('Candid Coffee')
    expect(cand!.domain).toBe('candid.example')
    expect(cand!.extractedEmail).toBe('hello@candid.example')
    expect(cand!.confidence).toBe(100)
    // Evidence carries provenance: where the email came from + the score reasons.
    expect(cand!.evidence.emailSource).toBe('https://candid.example')
    expect(Array.isArray(cand!.evidence.scoring)).toBe(true)
    expect(await countRows('activities', "kind = 'candidate_created'")).toBe(1)
  })

  it('does not pile up duplicate OPEN candidates for the same business', async () => {
    await createOwners()
    await ingestBusiness(env.DB, BIZ, { fetchSite: fetcher(), now: NOW })
    const again = await ingestBusiness(env.DB, BIZ, { fetchSite: fetcher(), now: NOW })
    expect(again.kind).toBe('deduped')
    expect(await countRows('lead_candidates', "status = 'new'")).toBe(1)
  })
})

describe('approval is the only candidate → company bridge', () => {
  it('creates a company at stage new — and never enrolls or drafts email', async () => {
    await createOwners()
    const { id } = await createLeadCandidate(
      env.DB,
      { sourceType: 'places', name: 'Candid Coffee', website: 'https://candid.example', domain: 'candid.example', city: 'Warsaw', country: 'PL', phone: '+48 22 555 0199', extractedEmail: 'hello@candid.example' },
      'test',
    )
    // Before approval: no company exists.
    expect(await countRows('companies')).toBe(0)

    const result = await approveCandidate(env.DB, id, 'user:1')
    expect(result.status).toBe('approved')

    const company = await env.DB.prepare('SELECT stage FROM companies WHERE id = ?')
      .bind(result.companyId)
      .first<{ stage: string }>()
    expect(company?.stage).toBe('new') // NOT email_sequence — approval never enrolls
    // The crawled email became an unverified contact, nothing more.
    expect(await countRows('contacts', `company_id = ${result.companyId}`)).toBe(1)
    expect(await countRows('sequence_enrollments')).toBe(0)
    expect(await countRows('email_messages')).toBe(0)

    const cand = await getCandidate(env.DB, id)
    expect(cand?.status).toBe('approved')
    expect(cand?.companyId).toBe(result.companyId)
    expect(await countRows('activities', "kind = 'candidate_approved'")).toBe(1)
  })

  it('a duplicate candidate links the existing company and creates no second one', async () => {
    await createOwners()
    // A company already exists on this domain.
    const existing = await env.DB.prepare(
      "INSERT INTO companies (name, domain, stage) VALUES ('Existing', 'dupe.example', 'new') RETURNING id",
    ).first<{ id: number }>()

    const { id } = await createLeadCandidate(
      env.DB,
      { sourceType: 'places', name: 'Dupe Co', website: 'https://dupe.example', city: 'Warsaw' },
      'test',
    )
    const result = await approveCandidate(env.DB, id, 'user:1')
    expect(result.status).toBe('duplicate')
    expect(result.companyId).toBe(existing!.id)
    expect(result.matchedBy).toBe('domain')
    // Still exactly one company — no duplicate created.
    expect(await countRows('companies')).toBe(1)
    const cand = await getCandidate(env.DB, id)
    expect(cand?.status).toBe('duplicate')
    expect(cand?.companyId).toBe(existing!.id)
    expect(await countRows('activities', "kind = 'candidate_duplicate'")).toBe(1)
  })
})

describe('terminal states cannot be re-actioned', () => {
  it('a rejected candidate cannot be approved', async () => {
    await createOwners()
    const { id } = await createLeadCandidate(env.DB, { sourceType: 'manual', name: 'Nope Co' }, 'test')
    await rejectCandidate(env.DB, id, 'user:1', 'not a fit')
    await expect(approveCandidate(env.DB, id, 'user:1')).rejects.toThrow(/only new candidates/)
    expect(await countRows('companies')).toBe(0)
    expect(await countRows('activities', "kind = 'candidate_rejected'")).toBe(1)
  })

  it('an approved candidate cannot be approved twice', async () => {
    await createOwners()
    const { id } = await createLeadCandidate(env.DB, { sourceType: 'manual', name: 'Once Co', website: 'https://once.example' }, 'test')
    await approveCandidate(env.DB, id, 'user:1')
    await expect(approveCandidate(env.DB, id, 'user:1')).rejects.toThrow(/only new candidates/)
    // Exactly one company from the single successful approval.
    expect(await countRows('companies')).toBe(1)
  })

  it('a rejected candidate cannot be rejected again', async () => {
    await createOwners()
    const { id } = await createLeadCandidate(env.DB, { sourceType: 'manual', name: 'Twice Co' }, 'test')
    await rejectCandidate(env.DB, id, 'user:1')
    await expect(rejectCandidate(env.DB, id, 'user:1')).rejects.toThrow(/only new candidates/)
  })
})

describe('candidate routes', () => {
  async function seedOne() {
    const { id } = await createLeadCandidate(
      env.DB,
      { sourceType: 'places', name: 'Route Co', website: 'https://route.example', city: 'Warsaw' },
      'test',
    )
    return id
  }

  it('require auth', async () => {
    expect((await SELF.fetch(`${BASE}/api/candidates`)).status).toBe(401)
    expect((await SELF.fetch(`${BASE}/api/candidates/1/approve`, { method: 'POST' })).status).toBe(401)
    expect((await SELF.fetch(`${BASE}/api/candidates/1/reject`, { method: 'POST' })).status).toBe(401)
  })

  it('list, approve, and reject through the API — audited end to end', async () => {
    await createOwners()
    const cookie = await loginCookie(OWNER_A.email, OWNER_A.password)
    const idA = await seedOne()
    const idB = await seedOne()

    const list = await SELF.fetch(`${BASE}/api/candidates?status=new`, { headers: { Cookie: cookie } })
    expect(list.status).toBe(200)
    const listed = await list.json<{ candidates: Array<{ id: number }> }>()
    expect(listed.candidates.length).toBe(2)

    const approve = await SELF.fetch(`${BASE}/api/candidates/${idA}/approve`, {
      method: 'POST', headers: { Cookie: cookie },
    })
    expect(approve.status).toBe(200)
    const approved = await approve.json<{ status: string; companyId: number }>()
    expect(approved.status).toBe('approved')
    expect(Number.isInteger(approved.companyId)).toBe(true)

    const reject = await SELF.fetch(`${BASE}/api/candidates/${idB}/reject`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'out of area' }),
    })
    expect(reject.status).toBe(200)

    // Approving an already-approved candidate is a clean 409, not a 500.
    const again = await SELF.fetch(`${BASE}/api/candidates/${idA}/approve`, {
      method: 'POST', headers: { Cookie: cookie },
    })
    expect(again.status).toBe(409)

    expect(await countRows('activities', "kind = 'candidate_approved'")).toBe(1)
    expect(await countRows('activities', "kind = 'candidate_rejected'")).toBe(1)
  })

  it('reject invalid payloads with 400, not 500', async () => {
    await createOwners()
    const cookie = await loginCookie(OWNER_A.email, OWNER_A.password)
    // Unknown status filter.
    expect((await SELF.fetch(`${BASE}/api/candidates?status=bogus`, { headers: { Cookie: cookie } })).status).toBe(400)
    // Non-integer id.
    expect((await SELF.fetch(`${BASE}/api/candidates/abc/approve`, { method: 'POST', headers: { Cookie: cookie } })).status).toBe(400)
    // Malformed JSON body on reject.
    const bad = await SELF.fetch(`${BASE}/api/candidates/1/reject`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{not json',
    })
    expect(bad.status).toBe(400)
    // Missing candidate.
    expect((await SELF.fetch(`${BASE}/api/candidates/99999`, { headers: { Cookie: cookie } })).status).toBe(404)
  })
})
