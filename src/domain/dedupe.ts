import { phoneKey } from '../adapters/normalize'

/**
 * Duplicate-lead detection. Domained businesses dedupe on their registrable
 * domain (the strong key, tldts-normalized). Businesses WITHOUT a website —
 * the gap that let daily sourcing and manual entry pile up copies of the same
 * shop — fall back to a normalized phone (libphonenumber E.164), then a
 * normalized name+city match.
 */

export function normName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Canonical phone comparison key (E.164 digits); null if not usable. */
export function normPhone(phone: string | null | undefined): string | null {
  return phoneKey(phone)
}

export interface DuplicateQuery {
  domain?: string | null
  name: string
  city?: string | null
  phone?: string | null
}

export interface DuplicateHit {
  id: number
  reason: 'domain' | 'phone' | 'name+city'
}

export async function findDuplicateCompany(
  db: D1Database,
  q: DuplicateQuery,
): Promise<DuplicateHit | null> {
  // Domained lead: the domain is authoritative — don't cross-match on name.
  if (q.domain) {
    const row = await db
      .prepare('SELECT id FROM companies WHERE domain = ?')
      .bind(q.domain)
      .first<{ id: number }>()
    return row ? { id: row.id, reason: 'domain' } : null
  }

  // No domain — fall back to phone, then name+city.
  const phone = normPhone(q.phone)
  if (phone) {
    const rows = await db
      .prepare("SELECT id, phone FROM companies WHERE phone IS NOT NULL AND phone != ''")
      .all<{ id: number; phone: string }>()
    for (const row of rows.results) {
      if (normPhone(row.phone) === phone) return { id: row.id, reason: 'phone' }
    }
  }

  const name = normName(q.name)
  const city = (q.city ?? '').trim().toLowerCase()
  if (name && city) {
    const rows = await db
      .prepare("SELECT id, name FROM companies WHERE lower(trim(coalesce(city, ''))) = ?")
      .bind(city)
      .all<{ id: number; name: string }>()
    for (const row of rows.results) {
      if (normName(row.name) === name) return { id: row.id, reason: 'name+city' }
    }
  }

  return null
}
