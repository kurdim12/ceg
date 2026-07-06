/**
 * Duplicate-lead detection. Domained businesses dedupe on their bare domain
 * (the strong key). Businesses WITHOUT a website — the gap that let daily
 * sourcing and manual entry pile up copies of the same shop — fall back to an
 * exact phone match, then a normalized name+city match.
 */

export function normName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Digits only; null if too short to be a meaningful match key. */
export function normPhone(phone: string | null | undefined): string | null {
  if (!phone) return null
  const digits = phone.replace(/\D/g, '')
  return digits.length >= 7 ? digits : null
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
