import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { phoneNormalizer, domainNormalizer, phoneKey } from '../src/adapters/normalize'
import { createCompany as createLead } from '../src/domain/manual-ops'
import { findDuplicateCompany } from '../src/domain/dedupe'
import { countRows } from './helpers'

describe('phone normalization (libphonenumber-js)', () => {
  it('00 prefix and + prefix normalize to the same E.164', () => {
    expect(phoneNormalizer.toE164('+1 212 736 5000')).toBe('+12127365000')
    expect(phoneNormalizer.toE164('001 212 736 5000')).toBe('+12127365000')
  })

  it('a local-looking phone with a country hint normalizes', () => {
    expect(phoneNormalizer.toE164('(212) 736-5000', 'US')).toBe('+12127365000')
  })

  it('invalid phone returns null and never throws', () => {
    expect(phoneNormalizer.toE164('garbage')).toBeNull()
    expect(phoneNormalizer.toE164('12345', 'US')).toBeNull()
    expect(phoneNormalizer.toE164('')).toBeNull()
    expect(phoneNormalizer.toE164(null)).toBeNull()
  })

  it('phoneKey collapses formatting + IDD differences into one dedup key', () => {
    const k = phoneKey('+1 212 736 5000')
    expect(k).not.toBeNull()
    expect(phoneKey('001-212-736-5000')).toBe(k)
    expect(phoneKey('(212) 736 5000', 'US')).toBe(k)
  })
})

describe('domain normalization (tldts)', () => {
  it('strips www and paths to the registrable domain', () => {
    expect(domainNormalizer.registrableDomain('www.example.com')).toBe('example.com')
    expect(domainNormalizer.registrableDomain('https://example.com/path?q=1')).toBe('example.com')
  })

  it('collapses subdomains and handles multi-part TLDs', () => {
    expect(domainNormalizer.registrableDomain('sub.example.co.uk')).toBe('example.co.uk')
    expect(domainNormalizer.registrableDomain('https://a.b.example.co.uk/x')).toBe('example.co.uk')
  })

  it('returns null for malformed/empty input, never throws', () => {
    expect(domainNormalizer.registrableDomain('notaurl')).toBeNull()
    expect(domainNormalizer.registrableDomain('')).toBeNull()
    expect(domainNormalizer.registrableDomain(null)).toBeNull()
  })
})

describe('dedup uses the normalizers end to end', () => {
  it('same business, different domain formatting, is not duplicated', async () => {
    await createLead(env.DB, { name: 'Site Co', website: 'https://www.siteco.com/contact' }, 'x')
    expect((await findDuplicateCompany(env.DB, { domain: 'siteco.com', name: 'x' }))?.reason).toBe('domain')
    await expect(createLead(env.DB, { name: 'Other', website: 'http://siteco.com' }, 'x')).rejects.toThrow(/duplicate/)
    expect(await countRows('companies')).toBe(1)
  })

  it('same phone in different formats (no website) is not duplicated', async () => {
    await createLead(env.DB, { name: 'Phone Co', city: 'Lyon', phone: '+33 1 70 18 99 00' }, 'x')
    await expect(createLead(env.DB, { name: 'Phone Co Two', city: 'Nice', phone: '0033170189900' }, 'x')).rejects.toThrow(/duplicate/)
    expect(await countRows('companies')).toBe(1)
  })

  it('same name+city (no website/phone) is not duplicated; a different city is allowed', async () => {
    await createLead(env.DB, { name: 'Bistro', city: 'Rome' }, 'x')
    await expect(createLead(env.DB, { name: 'bistro', city: 'ROME' }, 'x')).rejects.toThrow(/duplicate/)
    const other = await createLead(env.DB, { name: 'Bistro', city: 'Milan' }, 'x')
    expect(other.id).toBeGreaterThan(0)
    expect(await countRows('companies')).toBe(2)
  })
})
