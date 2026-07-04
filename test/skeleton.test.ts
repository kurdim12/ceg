import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { mockSiteFetcher, mockVerifier } from '../src/adapters/mocks'
import { DEFAULT_SETTINGS } from '../src/config/defaults'
import { ingestBusiness } from '../src/pipeline/ingest'
import { advanceDueEnrollments } from '../src/sequence/enroll'
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
    <p>Sales: sales@vistula-trading.example</p>
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

function deps(now: Date) {
  return {
    fetchSite: mockSiteFetcher({ 'https://vistula-trading.example': FIXTURE_SITE }),
    verifier: mockVerifier({
      'office@vistula-trading.example': 'valid' as const,
      'sales@vistula-trading.example': 'catch_all' as const,
    }),
    now,
    resolveTimezone: () => 'Europe/Warsaw',
  }
}

describe('walking skeleton: one lead, whole pipe, DRY_RUN', () => {
  it('source → dedupe → crawl → verify → assign → enroll → step-1 draft → trail', async () => {
    const [ownerA] = await createOwners()

    // Ingest: the front half of the pipe.
    const outcome = await ingestBusiness(env.DB, FIXTURE_BIZ, deps(TUESDAY_10_UTC))
    expect(outcome.kind).toBe('enrolled')
    if (outcome.kind !== 'enrolled') return

    // Company created, assigned, in email_sequence.
    const company = await env.DB.prepare(
      'SELECT domain, stage, assignee_id AS assignee, timezone FROM companies WHERE id = ?',
    )
      .bind(outcome.companyId)
      .first<{ domain: string; stage: string; assignee: number; timezone: string }>()
    expect(company?.domain).toBe('vistula-trading.example')
    expect(company?.stage).toBe('email_sequence')
    expect(company?.assignee).toBe(ownerA) // round-robin picked the emptier book
    expect(company?.timezone).toBe('Europe/Warsaw')

    // Both crawled emails became contacts; junk filename filtered out;
    // only the valid one is enrollable, the catch-all is held.
    expect(await countRows('contacts', `company_id = ${outcome.companyId}`)).toBe(2)
    expect(
      await countRows(
        'contacts',
        `company_id = ${outcome.companyId} AND email_status = 'valid'`,
      ),
    ).toBe(1)

    // Dispatcher pass inside the send window renders the step-1 DRAFT.
    const advanced = await advanceDueEnrollments(env.DB, DEFAULT_SETTINGS, TUESDAY_10_UTC)
    expect(advanced.drafted).toBe(1)

    const draft = await env.DB.prepare(
      `SELECT step, status, subject, body, to_email FROM email_messages WHERE company_id = ?`,
    )
      .bind(outcome.companyId)
      .first<{ step: number; status: string; subject: string; body: string; to_email: string }>()
    expect(draft?.step).toBe(1)
    expect(draft?.status).toBe('draft') // DRY_RUN world: nothing sends
    expect(draft?.to_email).toBe('office@vistula-trading.example')
    expect(draft?.subject).toContain('Vistula Trading')
    expect(draft?.body).toContain('Warsaw')
    // Plain text, at most one link (none without a booking link configured).
    expect(draft?.body).not.toContain('<')
    expect((draft?.body.match(/https?:\/\//g) ?? []).length).toBeLessThanOrEqual(1)

    // Activity trail is complete end to end.
    const kinds = (
      await env.DB.prepare(
        `SELECT kind FROM activities WHERE
           (entity_type = 'company' AND entity_id = ?) OR
           (entity_type = 'contact' AND entity_id IN
             (SELECT id FROM contacts WHERE company_id = ?))
         ORDER BY id`,
      )
        .bind(outcome.companyId, outcome.companyId)
        .all<{ kind: string }>()
    ).results.map((r) => r.kind)
    for (const expected of [
      'company_sourced', 'site_crawled', 'contact_added', 'email_verified',
      'stage_change', 'sequence_enrolled', 'draft_created',
    ]) {
      expect(kinds, `activity ${expected} must be in the trail`).toContain(expected)
    }

    // Re-ingesting the same business dedupes by domain — no second company.
    const again = await ingestBusiness(env.DB, FIXTURE_BIZ, deps(TUESDAY_10_UTC))
    expect(again.kind).toBe('deduped')
    expect(await countRows('companies', `domain = 'vistula-trading.example'`)).toBe(1)
  })

  it('holds everything when the verifier key is unset — fail-safe, never fake', async () => {
    await createOwners()
    const outcome = await ingestBusiness(env.DB, FIXTURE_BIZ, {
      ...deps(TUESDAY_10_UTC),
      verifier: null,
    })
    expect(outcome.kind).toBe('held')
    if (outcome.kind !== 'held') return
    // Lead parked at new, nothing enrolled, nothing drafted, reason audited.
    const stage = await env.DB.prepare('SELECT stage FROM companies WHERE id = ?')
      .bind(outcome.companyId)
      .first<{ stage: string }>()
    expect(stage?.stage).toBe('new')
    expect(await countRows('sequence_enrollments')).toBe(0)
    expect(await countRows('email_messages')).toBe(0)
    expect(await countRows('activities', `kind = 'verification_held'`)).toBe(1)
  })

  it('parks a lead with no deliverable email as no_valid_email', async () => {
    await createOwners()
    const outcome = await ingestBusiness(env.DB, FIXTURE_BIZ, {
      ...deps(TUESDAY_10_UTC),
      verifier: mockVerifier({
        'office@vistula-trading.example': 'invalid',
        'sales@vistula-trading.example': 'unknown',
      }),
    })
    expect(outcome.kind).toBe('no_valid_email')
    if (outcome.kind !== 'no_valid_email') return
    const stage = await env.DB.prepare('SELECT stage FROM companies WHERE id = ?')
      .bind(outcome.companyId)
      .first<{ stage: string }>()
    expect(stage?.stage).toBe('no_valid_email') // never deleted — routed to the call path
  })

  it('does not draft outside the lead-local window or on weekends', async () => {
    await createOwners()
    // New York at 10:00 UTC is 06:00 local — before the window opens.
    const outcome = await ingestBusiness(env.DB, FIXTURE_BIZ, {
      ...deps(TUESDAY_10_UTC),
      resolveTimezone: () => 'America/New_York',
    })
    expect(outcome.kind).toBe('enrolled')
    const early = await advanceDueEnrollments(env.DB, DEFAULT_SETTINGS, TUESDAY_10_UTC)
    expect(early.drafted).toBe(0)
    expect(await countRows('email_messages')).toBe(0)

    // Same instant, in-window timezone, but it's Sunday: still nothing.
    expect(isInSendWindow('Europe/Warsaw', DEFAULT_SETTINGS, SUNDAY_10_UTC)).toBe(false)

    // Six hours later New York is 12:00 local on a weekday — the draft lands.
    const noon = new Date('2026-07-07T16:00:00Z')
    const later = await advanceDueEnrollments(env.DB, DEFAULT_SETTINGS, noon)
    expect(later.drafted).toBe(1)
  })

  it('window math: boundaries behave per spec', () => {
    const s = DEFAULT_SETTINGS
    // 09:00 exactly is in; 16:30 exactly is out (end-exclusive); 08:59 out.
    const mondayAt = (hhmmUtc: string) => new Date(`2026-07-06T${hhmmUtc}:00Z`)
    // UTC timezone keeps wall clock == UTC clock for boundary reads.
    expect(isInSendWindow('UTC', s, mondayAt('09:00'))).toBe(true)
    expect(isInSendWindow('UTC', s, mondayAt('08:59'))).toBe(false)
    expect(isInSendWindow('UTC', s, mondayAt('16:29'))).toBe(true)
    expect(isInSendWindow('UTC', s, mondayAt('16:30'))).toBe(false)
    expect(isInSendWindow(null, s, mondayAt('12:00'))).toBe(false) // unknown tz fails safe
    expect(isInSendWindow('Not/A_Zone', s, mondayAt('12:00'))).toBe(false)
  })
})
