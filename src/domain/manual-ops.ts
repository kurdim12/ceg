import { domainNormalizer } from '../adapters/normalize'
import { activityStatement, logActivity } from './activities'
import { findDuplicateCompany } from './dedupe'
import { isStage, type Stage } from './stages'
import { TransitionConflictError } from './transitions'

/** A field edit or delete lost a compare-and-swap: someone else changed the row. */
export class EditConflictError extends Error {
  constructor(companyId: number) {
    super(`edit conflict for company ${companyId} (someone else changed it — reload)`)
  }
}

/** Fields an owner may set when hand-creating or editing a lead. */
export interface CompanyInput {
  name?: string | null
  website?: string | null
  city?: string | null
  country?: string | null
  timezone?: string | null
  phone?: string | null
  businessType?: string | null
  assigneeId?: number | null
}

/** Map of accepted input keys → the physical column they write. */
const EDITABLE_COLUMNS: Record<keyof CompanyInput, string> = {
  name: 'name',
  website: 'website',
  city: 'city',
  country: 'country',
  timezone: 'timezone',
  phone: 'phone',
  businessType: 'business_type',
  assigneeId: 'assignee_id',
}

/** Normalise a website into an https URL + its registrable domain (for dedupe). */
function deriveWebsite(raw: string): { website: string; domain: string | null } {
  const withScheme = raw.includes('://') ? raw : `https://${raw}`
  return { website: withScheme, domain: domainNormalizer.registrableDomain(withScheme) }
}

/** Coerce one input value for its column, enforcing the same limits the agent uses. */
function coerce(key: keyof CompanyInput, value: unknown): string | number | null {
  if (key === 'assigneeId') {
    if (value === null || value === undefined || value === '') return null
    if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error('assigneeId must be an integer or null')
    return value
  }
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  const trimmed = value.trim().slice(0, key === 'name' ? 200 : 500)
  return trimmed === '' ? null : trimmed
}

/**
 * Owner-initiated manual lead creation. Mirrors the sourcing insert but from
 * a human: source='manual', stage='new', domain derived from the website so
 * the existing dedupe still holds. Audited.
 */
export async function createCompany(
  db: D1Database,
  input: CompanyInput,
  actor: string,
): Promise<{ id: number }> {
  const name = coerce('name', input.name)
  if (!name || typeof name !== 'string') throw new Error('name is required')

  let website: string | null = null
  let domain: string | null = null
  if (typeof input.website === 'string' && input.website.trim() !== '') {
    const derived = deriveWebsite(input.website.trim())
    website = derived.website
    domain = derived.domain
  }

  // Reject a clear duplicate (domain, else phone, else name+city) so manual
  // entry and sourcing can't pile up copies of the same business.
  const dupe = await findDuplicateCompany(db, {
    domain,
    name,
    city: input.city ?? null,
    phone: input.phone ?? null,
  })
  if (dupe) {
    throw new Error(`this looks like a duplicate of an existing lead (matched by ${dupe.reason})`)
  }

  const row = await db
    .prepare(
      `INSERT INTO companies
         (name, domain, website, city, country, timezone, phone, business_type,
          source, assignee_id, stage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, 'new')
       RETURNING id`,
    )
    .bind(
      name,
      domain,
      website,
      coerce('city', input.city),
      coerce('country', input.country),
      coerce('timezone', input.timezone),
      coerce('phone', input.phone),
      coerce('businessType', input.businessType),
      coerce('assigneeId', input.assigneeId),
    )
    .first<{ id: number }>()
  await logActivity(db, {
    entityType: 'company',
    entityId: row!.id,
    actor,
    kind: 'company_created',
    detail: { name, source: 'manual' },
  })
  return { id: row!.id }
}

/**
 * Owner-initiated field edit. Only the allowlisted columns can be touched;
 * name can never be blanked. Audited with the set of fields changed (values
 * are not echoed into the trail for edits that may hold PII beyond names).
 */
export async function updateCompanyFields(
  db: D1Database,
  companyId: number,
  patch: Record<string, unknown>,
  actor: string,
  expectedRev?: number,
): Promise<{ updated: string[] }> {
  const sets: string[] = []
  const binds: Array<string | number | null> = []
  const applied: string[] = []

  for (const key of Object.keys(EDITABLE_COLUMNS) as Array<keyof CompanyInput>) {
    if (!(key in patch)) continue
    let website: string | null
    if (key === 'website') {
      const raw = patch.website
      if (typeof raw === 'string' && raw.trim() !== '') {
        const derived = deriveWebsite(raw.trim())
        website = derived.website
        // Keep domain in step with the website so dedupe stays honest.
        sets.push('domain = ?')
        binds.push(derived.domain)
      } else {
        website = null
        sets.push('domain = ?')
        binds.push(null)
      }
      sets.push('website = ?')
      binds.push(website)
      applied.push(key)
      continue
    }
    const value = coerce(key, patch[key])
    if (key === 'name' && value === null) throw new Error('name cannot be empty')
    sets.push(`${EDITABLE_COLUMNS[key]} = ?`)
    binds.push(value)
    applied.push(key)
  }

  if (sets.length === 0) throw new Error('no editable fields provided')

  const exists = await db
    .prepare('SELECT rev FROM companies WHERE id = ?')
    .bind(companyId)
    .first<{ rev: number }>()
  if (!exists) throw new Error('no such company')

  // Bump the row version, and compare-and-swap on the caller's expected rev
  // when supplied: a stale editor changes 0 rows and gets a conflict.
  sets.push('rev = rev + 1')
  let sql = `UPDATE companies SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`
  binds.push(companyId)
  if (typeof expectedRev === 'number') {
    sql += ' AND rev = ?'
    binds.push(expectedRev)
  }
  const res = await db.prepare(sql).bind(...binds).run()
  if ((res.meta.changes ?? 0) !== 1) throw new EditConflictError(companyId)

  await logActivity(db, {
    entityType: 'company',
    entityId: companyId,
    actor,
    kind: 'lead_edited',
    detail: { fields: applied },
  })
  return { updated: applied }
}

/**
 * Owner-initiated manual stage override. Unlike transitionStage, this does
 * NOT enforce the legal-transition graph — an owner-admin correcting a
 * lead by hand may move it to any stage. It KEEPS the CAS guard (a stale
 * writer loses) and appends an audit row in the same atomic batch.
 */
export async function setStageManual(
  db: D1Database,
  args: { companyId: number; to: string; expectedVersion: number; actor: string },
): Promise<{ from: Stage; to: Stage }> {
  const { companyId, to, expectedVersion, actor } = args
  if (!isStage(to)) throw new Error(`unknown stage: ${to}`)

  const current = await db
    .prepare('SELECT stage FROM companies WHERE id = ?')
    .bind(companyId)
    .first<{ stage: Stage }>()
  if (!current) throw new Error('no such company')

  const update = db
    .prepare(
      `UPDATE companies
         SET stage = ?, stage_version = stage_version + 1,
             stage_changed_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND stage_version = ?`,
    )
    .bind(to, companyId, expectedVersion)
  const auditIfLanded = db
    .prepare(
      `INSERT INTO activities (entity_type, entity_id, actor, kind, detail)
       SELECT 'company', ?, ?, 'stage_set_manual', ?
       WHERE (SELECT changes()) = 1`,
    )
    .bind(companyId, actor, JSON.stringify({ from: current.stage, to }))

  const [res] = await db.batch([update, auditIfLanded])
  if ((res?.meta.changes ?? 0) !== 1) throw new TransitionConflictError(companyId)
  return { from: current.stage, to: to as Stage }
}

/**
 * Hard-delete a company and every row that hangs off it, in FK-safe order.
 * The append-only activity trail is preserved by design — the deletion
 * itself is logged as a system-level activity so history stays truthful.
 * (Granted under the owner's explicit "no limits" choice.)
 */
export async function deleteCompany(
  db: D1Database,
  companyId: number,
  actor: string,
  expectedRev?: number,
): Promise<{ deleted: boolean; name: string | null; conflict?: boolean }> {
  const company = await db
    .prepare('SELECT name, rev FROM companies WHERE id = ?')
    .bind(companyId)
    .first<{ name: string; rev: number }>()
  if (!company) return { deleted: false, name: null }

  // Refuse to delete a row that changed under a stale reader.
  if (typeof expectedRev === 'number' && company.rev !== expectedRev) {
    return { deleted: false, name: company.name, conflict: true }
  }

  await db.batch([
    db.prepare('DELETE FROM drop_requests WHERE company_id = ?').bind(companyId),
    db.prepare('DELETE FROM call_attempts WHERE company_id = ?').bind(companyId),
    db.prepare('DELETE FROM meetings WHERE company_id = ?').bind(companyId),
    db.prepare('DELETE FROM email_messages WHERE company_id = ?').bind(companyId),
    db.prepare('DELETE FROM sequence_enrollments WHERE company_id = ?').bind(companyId),
    db.prepare('DELETE FROM deals WHERE company_id = ?').bind(companyId),
    db.prepare('DELETE FROM contacts WHERE company_id = ?').bind(companyId),
    db.prepare('DELETE FROM companies WHERE id = ?').bind(companyId),
    activityStatement(db, {
      entityType: 'company',
      entityId: companyId,
      actor,
      kind: 'company_deleted',
      detail: { name: company.name },
    }),
  ])
  return { deleted: true, name: company.name }
}
