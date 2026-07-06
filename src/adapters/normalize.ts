import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js'
import { getDomain } from 'tldts'

/**
 * Data-normalization adapters. Small, permissive (MIT) libraries behind thin,
 * replaceable interfaces — same pattern as our other adapters: they NEVER
 * throw in normal use, and return null on anything they can't normalize, so a
 * bad value degrades to "no match" rather than an error.
 */

export interface PhoneNormalizer {
  /** Canonical E.164 (e.g. "+12127365000") or null if not a valid number. */
  toE164(raw: string | null | undefined, region?: string): string | null
}

export interface DomainNormalizer {
  /** Registrable domain / eTLD+1 (e.g. "example.co.uk") or null. */
  registrableDomain(input: string | null | undefined): string | null
}

/** Treat a leading international-dialing "00" like "+": 0044… ≡ +44… */
function iddToPlus(s: string): string {
  return /^00\d/.test(s) ? '+' + s.slice(2) : s
}

export const phoneNormalizer: PhoneNormalizer = {
  toE164(raw, region) {
    if (typeof raw !== 'string') return null
    const s = iddToPlus(raw.trim())
    if (s === '') return null
    try {
      const parsed = parsePhoneNumberFromString(s, region as CountryCode | undefined)
      return parsed && parsed.isValid() ? parsed.number : null
    } catch {
      return null
    }
  },
}

export const domainNormalizer: DomainNormalizer = {
  registrableDomain(input) {
    if (typeof input !== 'string') return null
    const s = input.trim()
    if (s === '') return null
    try {
      const d = getDomain(s)
      if (d) return d.toLowerCase()
    } catch {
      /* fall through to the URL fallback */
    }
    // Fallback for hosts tldts can't resolve to a known public suffix (e.g. the
    // reserved *.example domains used in demo/test fixtures): strip scheme+www.
    try {
      const url = new URL(s.includes('://') ? s : `https://${s}`)
      const host = url.hostname.replace(/^www\./, '').toLowerCase()
      // Must look like a domain (contain a dot) — else it's not a host.
      return host.includes('.') ? host : null
    } catch {
      const bare = s.replace(/^www\./, '').toLowerCase()
      return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(bare) ? bare : null
    }
  },
}

/**
 * Comparison key for phone dedup: canonical digits. Uses libphonenumber's E.164
 * when the number is valid, else the raw digits (with IDD "00" treated as "+"),
 * so "+351 21 555 0100", "00351 215550100" and "(351) 21-555-0100" all collide.
 */
export function phoneKey(raw: string | null | undefined, region?: string): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const e164 = phoneNormalizer.toE164(raw, region)
  const digits = (e164 ?? iddToPlus(raw.trim())).replace(/\D/g, '')
  return digits.length >= 7 ? digits : null
}
