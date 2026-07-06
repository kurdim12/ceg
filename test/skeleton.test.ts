import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { mockSiteFetcher } from '../src/adapters/mocks'
import { DEFAULT_SETTINGS } from '../src/config/defaults'
import { approveCandidate } from '../src/domain/candidates'
import { ingestBusiness } from '../src/pipeline/ingest'
import { advanceDueEnrollments, enrollContact } from '../src/sequence/enroll'
import { isInSendWindow } from '../src/schedule/window'
import { createOwners, countRows } from './helpers'

// Tuesday 2026-07-07 10:00 UTC → 12:00 in Warsaw (in window),
// 06:00 in New York (before window), Sunday tests use 2026-07-05.
const TUESDAY_10_UTC = new Date('2026-07-07T10:00:00Z')
const SUNDAY_10_UTC = new Date('2026-07-05T10:00:00Z')

const FIXTURE_SITE = `
  <html><body>
    <h1>Vistula Trading</h1>
    <a href="mailto:office@vistula-trading.example">Contact us</a>
    <img src="logo@2x.png" />
  </body></html>`

const FIXTURE_BIZ = {
  name: 'Vistula Trading',
  website: 'https://vistula-trading.example',
  phone: '+48 22 555 0100',
  address: 'ul. Testowa 1, Warszawa',
  city: 'Warsaw',
  country: 'PL',
}
const fetcher = () => mockSiteFetcher({ 'https://vistula-trading.example': FIXTURE_SITE })

describe('walking skeleton: source → candidate → human approval → CRM lead', () => {
  it('sourcing parks a candidate with evidence and writes NOTHING into the CRM', async () => {
    await createOwners()
    const outcome = await ingestBusiness(env.DB, FIXTURE_BIZ, { fetchSite: fetcher(), now: TUESDAY_10_UTC })
    expect(outcome.kind).toBe('candidate')
    if (outcome.kind !== 'candidate') return

    // The whole safety point: no company, no contact, no sequence, no email.
    expect(await countRows('companies')).toBe(0)
    expect(await countRows('contacts')).toBe(0)
    expect(await countRows('sequence_enrollments')).toBe(0)
    expect(await countRows('email_messages')).toBe(0)

    const cand = await env.DB.prepare(
      "SELECT domain, extracted_email AS email, confidence, status, evidence_json AS ev FROM lead_candidates WHERE id = ?",
    )
      .bind(outcome.candidateId)
      .first<{ domain: string; email: string; confidence: number; status: string; ev: string }>()
    expect(cand?.domain).toBe('vistula-trading.example')
    expect(cand?.email).toBe('office@vistula-trading.example') // crawled as evidence, junk filename filtered
    expect(cand?.status).toBe('new')
    expect(cand?.confidence).toBe(100)
    expect(JSON.parse(cand!.ev).emailSource).toBe('https://vistula-trading.example')

    // Re-sourcing the same business dedupes at the candidate level.
    const again = await ingestBusiness(env.DB, FIXTURE_BIZ, { fetchSite: fetcher(), now: TUESDAY_10_UTC })
    expect(again.kind).toBe('deduped')
    expect(await countRows('lead_candidates', "status = 'new'")).toBe(1)
  })

  it('human approval creates a lead at stage new, timezone resolved, and NEVER enrolls or drafts', async () => {
    const [ownerA] = await createOwners()
    const outcome = await ingestBusiness(env.DB, FIXTURE_BIZ, { fetchSite: fetcher(), now: TUESDAY_10_UTC })
    if (outcome.kind !== 'candidate') throw new Error('expected candidate')

    const result = await approveCandidate(env.DB, outcome.candidateId, `user:${ownerA}`)
    expect(result.status).toBe('approved')

    const company = await env.DB.prepare(
      'SELECT stage, timezone, domain FROM companies WHERE id = ?',
    )
      .bind(result.companyId)
      .first<{ stage: string; timezone: string; domain: string }>()
    expect(company?.stage).toBe('new') // approval creates a lead, it does not sequence it
    expect(company?.timezone).toBe('Europe/Warsaw')
    expect(company?.domain).toBe('vistula-trading.example')

    // Crawled email carried over as one unverified contact; nothing sent.
    expect(await countRows('contacts', `company_id = ${result.companyId}`)).toBe(1)
    expect(await countRows('sequence_enrollments')).toBe(0)
    expect(await countRows('email_messages')).toBe(0)
  })
})

describe('post-approval the existing send machinery still gates correctly', () => {
  it('only drafts inside the lead-local window and on weekdays', async () => {
    await createOwners()
    // Approve a candidate into a lead, then a human enrolls its contact.
    const outcome = await ingestBusiness(env.DB, FIXTURE_BIZ, { fetchSite: fetcher(), now: TUESDAY_10_UTC })
    if (outcome.kind !== 'candidate') throw new Error('expected candidate')
    const { companyId } = await approveCandidate(env.DB, outcome.candidateId, 'user:1')
    const contact = await env.DB.prepare('SELECT id FROM contacts WHERE company_id = ?')
      .bind(companyId)
      .first<{ id: number }>()
    await enrollContact(env.DB, { companyId, contactId: contact!.id, actor: 'test', now: TUESDAY_10_UTC })

    // Warsaw at 10:00 UTC is 12:00 local on a Tuesday — inside the window.
    const inWindow = await advanceDueEnrollments(env.DB, DEFAULT_SETTINGS, TUESDAY_10_UTC)
    expect(inWindow.drafted).toBe(1)
    const draft = await env.DB.prepare(
      "SELECT status, to_email AS toEmail FROM email_messages WHERE company_id = ?",
    )
      .bind(companyId)
      .first<{ status: string; toEmail: string }>()
    expect(draft?.status).toBe('draft') // DRY_RUN world: nothing sends
    expect(draft?.toEmail).toBe('office@vistula-trading.example')
  })

  it('window math: boundaries behave per spec', () => {
    const s = DEFAULT_SETTINGS
    const mondayAt = (hhmmUtc: string) => new Date(`2026-07-06T${hhmmUtc}:00Z`)
    expect(isInSendWindow('UTC', s, mondayAt('09:00'))).toBe(true)
    expect(isInSendWindow('UTC', s, mondayAt('08:59'))).toBe(false)
    expect(isInSendWindow('UTC', s, mondayAt('16:29'))).toBe(true)
    expect(isInSendWindow('UTC', s, mondayAt('16:30'))).toBe(false)
    expect(isInSendWindow('Europe/Warsaw', s, SUNDAY_10_UTC)).toBe(false) // weekend
    expect(isInSendWindow(null, s, mondayAt('12:00'))).toBe(false) // unknown tz fails safe
    expect(isInSendWindow('Not/A_Zone', s, mondayAt('12:00'))).toBe(false)
  })
})
