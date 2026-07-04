import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { contactPageUrls, isPathAllowed, parseRobots } from '../src/adapters/crawler'
import { mapZeroBounceStatus } from '../src/adapters/zerobounce'
import { mockPlaces, mockSiteFetcher, mockVerifier } from '../src/adapters/mocks'
import { DEFAULT_SETTINGS } from '../src/config/defaults'
import { crawlForEmails } from '../src/crawler/crawl'
import { runSourcing } from '../src/pipeline/source-run'
import { runCronTick } from '../src/schedule/cron'
import { resolveTimezone } from '../src/schedule/timezones'
import { needsReverify, reverifyIfStale } from '../src/verification/staleness'
import { createOwners, loginCookie, countRows, OWNER_A } from './helpers'

const NOW = new Date('2026-07-07T10:00:00Z')

describe('universal timezone resolution', () => {
  it('matches IANA city names first, incl. multi-word cities', () => {
    expect(resolveTimezone('Warsaw', 'PL')).toBe('Europe/Warsaw')
    expect(resolveTimezone('New York', 'US')).toBe('America/New_York')
    expect(resolveTimezone('Amman', null)).toBe('Asia/Amman')
  })
  it('falls back to a country default, then to fail-safe null', () => {
    expect(resolveTimezone('Gdansk', 'PL')).toBe('Europe/Warsaw')
    expect(resolveTimezone('Springfield', 'US')).toBe('America/Chicago')
    expect(resolveTimezone('Nowhere', null)).toBeNull()
    expect(resolveTimezone(null, 'ZZ')).toBeNull()
  })
})

describe('staleness re-verify (>60 days, exact boundary)', () => {
  const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 3600 * 1000).toISOString()

  it('60 days must NOT trigger re-verify; 61 must', () => {
    expect(needsReverify(daysAgo(60), DEFAULT_SETTINGS, NOW)).toBe(false)
    expect(needsReverify(daysAgo(61), DEFAULT_SETTINGS, NOW)).toBe(true)
    expect(needsReverify(daysAgo(1), DEFAULT_SETTINGS, NOW)).toBe(false)
    expect(needsReverify(null, DEFAULT_SETTINGS, NOW)).toBe(true)
  })

  it('re-verifies a stale contact and audits; holds without a key', async () => {
    await createOwners()
    const company = await env.DB.prepare(
      `INSERT INTO companies (name, stage) VALUES ('Stale Co', 'lost') RETURNING id`,
    ).first<{ id: number }>()
    const contact = await env.DB.prepare(
      `INSERT INTO contacts (company_id, email, email_status, email_verified_at)
       VALUES (?, 'old@stale.example', 'valid', ?) RETURNING id, email, email_status, email_verified_at`,
    )
      .bind(company!.id, daysAgo(61))
      .first<{ id: number; email: string; email_status: string; email_verified_at: string }>()

    // No key: fail-safe hold, audited.
    const held = await reverifyIfStale(env.DB, null, contact!, DEFAULT_SETTINGS, NOW)
    expect(held).toBe('unknown')
    expect(await countRows('activities', "kind = 'verification_held'")).toBe(1)

    // With a verifier: status refreshed and audited.
    const outcome = await reverifyIfStale(
      env.DB,
      mockVerifier({ 'old@stale.example': 'invalid' }),
      contact!,
      DEFAULT_SETTINGS,
      NOW,
    )
    expect(outcome).toBe('invalid')
    const updated = await env.DB.prepare('SELECT email_status FROM contacts WHERE id = ?')
      .bind(contact!.id)
      .first<{ email_status: string }>()
    expect(updated?.email_status).toBe('invalid')
    expect(await countRows('activities', "kind = 'email_reverified'")).toBe(1)
  })
})

describe('crawler safety', () => {
  it('parses robots.txt star-group disallows', () => {
    const rules = parseRobots(
      'User-agent: Googlebot\nDisallow: /gbot\n\nUser-agent: *\nDisallow: /admin\nDisallow: /private # secret\n',
    )
    expect(rules).toEqual(['/admin', '/private'])
    expect(isPathAllowed(rules, '/contact')).toBe(true)
    expect(isPathAllowed(rules, '/admin/panel')).toBe(false)
  })

  it('finds same-host contact pages only, capped', () => {
    const html = `
      <a href="/contact">Contact</a>
      <a href="https://evil.example/contact">Elsewhere</a>
      <a href="/about-us">About</a>
      <a href="/kontakt">Kontakt</a>`
    const urls = contactPageUrls(html, 'https://good.example/')
    expect(urls).toHaveLength(2)
    expect(urls.every((u) => u.startsWith('https://good.example/'))).toBe(true)
  })

  it('walks homepage then contact page for emails', async () => {
    const fetcher = mockSiteFetcher({
      'https://biz.example': '<a href="/contact">contact us</a>',
      'https://biz.example/contact': '<p>write to hello@biz.example</p>',
    })
    expect(await crawlForEmails(fetcher, 'https://biz.example')).toEqual(['hello@biz.example'])
    expect(await crawlForEmails(fetcher, 'https://unreachable.example')).toEqual([])
  })
})

describe('ZeroBounce outcome mapping', () => {
  it('maps every documented status onto the four-policy outcomes', () => {
    expect(mapZeroBounceStatus('valid')).toBe('valid')
    expect(mapZeroBounceStatus('catch-all')).toBe('catch_all')
    expect(mapZeroBounceStatus('unknown')).toBe('unknown')
    for (const bad of ['invalid', 'spamtrap', 'abuse', 'do_not_mail']) {
      expect(mapZeroBounceStatus(bad)).toBe('invalid')
    }
  })
})

describe('sourcing runs', () => {
  const businesses = [
    {
      name: 'Alpha', website: 'https://alpha.example', phone: '+1', address: null,
      city: 'Warsaw', country: 'PL',
    },
    {
      name: 'Alpha Again', website: 'https://www.alpha.example/home', phone: null, address: null,
      city: 'Warsaw', country: 'PL',
    },
    {
      name: 'Beta (no site)', website: null, phone: '+2', address: null,
      city: 'Lyon', country: 'FR',
    },
  ]

  it('tallies created / deduped / parked with domain dedupe across www + paths', async () => {
    await createOwners()
    const tally = await runSourcing(
      env.DB,
      {
        places: mockPlaces(businesses),
        fetchSite: mockSiteFetcher({
          'https://alpha.example': '<a href="mailto:team@alpha.example">mail</a>',
        }),
        verifier: mockVerifier({ 'team@alpha.example': 'valid' }),
      },
      { geo: 'Warsaw', businessType: 'roasters', count: 10 },
      NOW,
      'test',
    )
    expect(tally.found).toBe(3)
    expect(tally.created).toBe(2) // Alpha + Beta; Alpha Again deduped by domain
    expect(tally.deduped).toBe(1)
    expect(tally.enrolled).toBe(1) // Alpha
    expect(tally.noValidEmail).toBe(1) // Beta: no site, no email — call queue path
    expect(await countRows('activities', "kind = 'sourcing_run'")).toBe(1)
  })

  it('manual run route validates params and holds without the Places key', async () => {
    await createOwners()
    const cookie = await loginCookie(OWNER_A.email, OWNER_A.password)
    const run = (body: unknown) =>
      SELF.fetch('http://engine.local/api/sourcing/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify(body),
      })
    expect((await run({ geo: '', businessType: 'cafes', count: 5 })).status).toBe(400)
    expect((await run({ geo: 'Lisbon', businessType: 'cafes', count: 0 })).status).toBe(400)
    expect((await run({ geo: 'Lisbon', businessType: 'cafes', count: 101 })).status).toBe(400)
    // Params fine, but GOOGLE_PLACES_API_KEY unset → holds with a clear reason.
    const held = await run({ geo: 'Lisbon', businessType: 'cafes', count: 5 })
    expect(held.status).toBe(409)
    const body = await held.json<{ error: string }>()
    expect(body.error).toContain('GOOGLE_PLACES_API_KEY')
  })
})

describe('hourly cron tick', () => {
  it('holds daily sourcing without the key, audibly, at the sourcing hour only', async () => {
    await createOwners()
    // Not the sourcing hour: no sourcing activity at all.
    await runCronTick({ DB: env.DB, KV: env.KV, DRY_RUN: env.DRY_RUN }, new Date('2026-07-07T10:00:00Z'))
    expect(await countRows('activities', "kind IN ('sourcing_held','sourcing_skipped')")).toBe(0)
    // Sourcing hour (23:00 UTC = 02:00 Amman) with no key: audited hold.
    await runCronTick({ DB: env.DB, KV: env.KV, DRY_RUN: env.DRY_RUN }, new Date('2026-07-07T23:00:00Z'))
    expect(await countRows('activities', "kind = 'sourcing_held'")).toBe(1)
  })

  it('skips (audited) when key present but targets unconfigured', async () => {
    await createOwners()
    await env.KV.put('secret:GOOGLE_PLACES_API_KEY', 'places-test-key')
    await runCronTick({ DB: env.DB, KV: env.KV, DRY_RUN: env.DRY_RUN }, new Date('2026-07-07T23:00:00Z'))
    expect(await countRows('activities', "kind = 'sourcing_skipped'")).toBe(1)
  })
})
