import { domainNormalizer } from '../adapters/normalize'
import { resolveTimezone } from '../schedule/timezones'
import { logActivity } from './activities'
import { normName } from './dedupe'
import { findDuplicateCompany } from './dedupe'
import { createCompany } from './manual-ops'

/**
 * Lead candidates — the Source Intelligence layer. Machine sourcing (Places,
 * crawler, import) writes candidates here, never straight into `companies`.
 * A human approves a candidate before it becomes a CRM lead, and a candidate
 * can NEVER enroll into a sequence or trigger an email. Approval is the only
 * bridge from candidate → company, and it re-runs the existing dedup logic.
 */

export type CandidateSourceType = 'places' | 'crawl' | 'manual' | 'import'
export type CandidateStatus = 'new' | 'approved' | 'rejected' | 'duplicate' | 'failed'

export interface CandidateInput {
  sourceType: CandidateSourceType
  sourceUrl?: string | null
  name: string
  domain?: string | null
  website?: string | null
  city?: string | null
  country?: string | null
  phone?: string | null
  extractedEmail?: string | null
  /** Provenance blob: where fields came from, what matched. Stored as JSON. */
  evidence?: Record<string, unknown>
  isDemo?: boolean
}

export interface ScoreResult {
  confidence: number
  reasons: string[]
}

/**
 * Deterministic, explainable confidence (0-100). No model, no randomness —
 * the same inputs always score the same, and every point is attributable to
 * a named reason kept in the candidate's evidence. Weights favour the signals
 * that make a lead actionable: a real contact email, then a website/domain we
 * can dedupe and enrich on, then a phone, then locational completeness.
 */
export function scoreCandidate(input: {
  extractedEmail?: string | null
  website?: string | null
  domain?: string | null
  phone?: string | null
  name?: string | null
  city?: string | null
}): ScoreResult {
  const reasons: string[] = []
  let score = 0
  if (input.extractedEmail && input.extractedEmail.trim() !== '') {
    score += 40
    reasons.push('contact email found (+40)')
  }
  if ((input.website && input.website.trim() !== '') || (input.domain && input.domain.trim() !== '')) {
    score += 20
    reasons.push('has a website (+20)')
  }
  if (input.phone && input.phone.trim() !== '') {
    score += 15
    reasons.push('has a phone number (+15)')
  }
  if (input.name && input.name.trim() !== '' && input.city && input.city.trim() !== '') {
    score += 15
    reasons.push('name + city present (+15)')
  }
  if (input.domain && input.domain.trim() !== '') {
    score += 10
    reasons.push('resolvable registrable domain (+10)')
  }
  return { confidence: Math.min(100, score), reasons }
}

export interface CandidateRow {
  id: number
  sourceType: CandidateSourceType
  sourceUrl: string | null
  name: string
  domain: string | null
  website: string | null
  city: string | null
  country: string | null
  phone: string | null
  extractedEmail: string | null
  evidence: Record<string, unknown>
  confidence: number
  status: CandidateStatus
  reviewedBy: string | null
  reviewedAt: string | null
  companyId: number | null
  rejectionReason: string | null
  createdAt: string
}

const SELECT_COLS = `
  id, source_type AS sourceType, source_url AS sourceUrl, name, domain, website,
  city, country, phone, extracted_email AS extractedEmail, evidence_json AS evidenceJson,
  confidence, status, reviewed_by AS reviewedBy, reviewed_at AS reviewedAt,
  company_id AS companyId, rejection_reason AS rejectionReason, created_at AS createdAt`

interface RawCandidate {
  id: number
  sourceType: CandidateSourceType
  sourceUrl: string | null
  name: string
  domain: string | null
  website: string | null
  city: string | null
  country: string | null
  phone: string | null
  extractedEmail: string | null
  evidenceJson: string
  confidence: number
  status: CandidateStatus
  reviewedBy: string | null
  reviewedAt: string | null
  companyId: number | null
  rejectionReason: string | null
  createdAt: string
}

function hydrate(raw: RawCandidate): CandidateRow {
  let evidence: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(raw.evidenceJson) as unknown
    if (parsed && typeof parsed === 'object') evidence = parsed as Record<string, unknown>
  } catch {
    evidence = {}
  }
  const { evidenceJson: _drop, ...rest } = raw
  void _drop
  return { ...rest, evidence }
}

/**
 * Candidate-level dedup so a nightly re-run of the same query doesn't pile up
 * duplicate OPEN candidates for the same business. Only matches `new`
 * candidates — a resolved (approved/rejected) one must not block re-sourcing.
 */
export async function findOpenCandidate(
  db: D1Database,
  q: { domain?: string | null; name: string; city?: string | null },
): Promise<{ id: number } | null> {
  if (q.domain && q.domain.trim() !== '') {
    const row = await db
      .prepare("SELECT id FROM lead_candidates WHERE status = 'new' AND domain = ? LIMIT 1")
      .bind(q.domain)
      .first<{ id: number }>()
    if (row) return { id: row.id }
  }
  const name = normName(q.name)
  const city = (q.city ?? '').trim().toLowerCase()
  if (name && city) {
    const rows = await db
      .prepare(
        "SELECT id, name FROM lead_candidates WHERE status = 'new' AND lower(trim(coalesce(city, ''))) = ?",
      )
      .bind(city)
      .all<{ id: number; name: string }>()
    for (const row of rows.results) {
      if (normName(row.name) === name) return { id: row.id }
    }
  }
  return null
}

/**
 * Create a scored candidate. Never touches companies, contacts, sequences, or
 * email — a candidate is inert until a human approves it.
 */
export async function createLeadCandidate(
  db: D1Database,
  input: CandidateInput,
  actor: string,
): Promise<{ id: number; confidence: number }> {
  const domain =
    input.domain ?? domainNormalizer.registrableDomain(input.website ?? '') ?? null
  const { confidence, reasons } = scoreCandidate({
    extractedEmail: input.extractedEmail,
    website: input.website,
    domain,
    phone: input.phone,
    name: input.name,
    city: input.city,
  })
  const evidence = { ...(input.evidence ?? {}), scoring: reasons }

  const row = await db
    .prepare(
      `INSERT INTO lead_candidates
         (source_type, source_url, name, domain, website, city, country, phone,
          extracted_email, evidence_json, confidence, status, is_demo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)
       RETURNING id`,
    )
    .bind(
      input.sourceType,
      input.sourceUrl ?? null,
      input.name,
      domain,
      input.website ?? null,
      input.city ?? null,
      input.country ?? null,
      input.phone ?? null,
      input.extractedEmail ?? null,
      JSON.stringify(evidence),
      confidence,
      input.isDemo ? 1 : 0,
    )
    .first<{ id: number }>()

  await logActivity(db, {
    entityType: 'system',
    entityId: row!.id,
    actor,
    kind: 'candidate_created',
    detail: { candidateId: row!.id, sourceType: input.sourceType, domain, confidence },
  })
  return { id: row!.id, confidence }
}

export async function listCandidates(
  db: D1Database,
  status: CandidateStatus | 'all' = 'new',
): Promise<CandidateRow[]> {
  const order = 'ORDER BY confidence DESC, id DESC LIMIT 200'
  const rows =
    status === 'all'
      ? await db.prepare(`SELECT ${SELECT_COLS} FROM lead_candidates ${order}`).all<RawCandidate>()
      : await db
          .prepare(`SELECT ${SELECT_COLS} FROM lead_candidates WHERE status = ? ${order}`)
          .bind(status)
          .all<RawCandidate>()
  return rows.results.map(hydrate)
}

export async function getCandidate(db: D1Database, id: number): Promise<CandidateRow | null> {
  const raw = await db
    .prepare(`SELECT ${SELECT_COLS} FROM lead_candidates WHERE id = ?`)
    .bind(id)
    .first<RawCandidate>()
  return raw ? hydrate(raw) : null
}

/** A candidate that is not in the `new` state can never be actioned again. */
export class CandidateStateError extends Error {
  constructor(
    public readonly current: CandidateStatus,
    public readonly action: string,
  ) {
    super(`candidate is '${current}' — only new candidates can be ${action}`)
  }
}
export class CandidateNotFoundError extends Error {
  constructor() {
    super('no such candidate')
  }
}

export interface ApproveResult {
  status: 'approved' | 'duplicate'
  companyId: number
  matchedBy?: 'domain' | 'phone' | 'name+city'
}

/**
 * Promote a candidate to a real CRM lead — the ONLY candidate → company path,
 * and it is human-triggered. Re-runs the company dedup: a match marks the
 * candidate `duplicate` and links the existing company (no second company);
 * otherwise it creates a company via the same safe `createCompany` used for
 * manual entry. The new company lands at stage `new` and is NOT enrolled into
 * any sequence — approval creates a lead, it never sends or drafts email.
 */
export async function approveCandidate(
  db: D1Database,
  id: number,
  actor: string,
): Promise<ApproveResult> {
  const cand = await getCandidate(db, id)
  if (!cand) throw new CandidateNotFoundError()
  if (cand.status !== 'new') throw new CandidateStateError(cand.status, 'approved')

  // Claim the candidate atomically so a double-click can't approve twice or
  // create two companies. Losing the claim means someone already handled it.
  const claim = await db
    .prepare(
      `UPDATE lead_candidates
         SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now'),
             updated_at = datetime('now')
       WHERE id = ? AND status = 'new'`,
    )
    .bind(actor, id)
    .run()
  if ((claim.meta.changes ?? 0) !== 1) {
    const now = await getCandidate(db, id)
    throw new CandidateStateError(now?.status ?? 'failed', 'approved')
  }

  // Dedup against existing companies (domain → phone → name+city).
  const dupe = await findDuplicateCompany(db, {
    domain: cand.domain,
    name: cand.name,
    city: cand.city,
    phone: cand.phone,
  })
  if (dupe) {
    await db
      .prepare(
        `UPDATE lead_candidates SET status = 'duplicate', company_id = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .bind(dupe.id, id)
      .run()
    await logActivity(db, {
      entityType: 'company',
      entityId: dupe.id,
      actor,
      kind: 'candidate_duplicate',
      detail: { candidateId: id, matchedBy: dupe.reason },
    })
    return { status: 'duplicate', companyId: dupe.id, matchedBy: dupe.reason }
  }

  try {
    const { id: companyId } = await createCompany(
      db,
      {
        name: cand.name,
        website: cand.website,
        city: cand.city,
        country: cand.country,
        // Resolve the lead-local timezone now so the lead is send-window-ready
        // if a human later enrolls it (parity with the old sourcing path).
        timezone: cand.city ? resolveTimezone(cand.city, cand.country) : null,
        phone: cand.phone,
      },
      actor,
    )
    // Carry the crawled email over as an UNVERIFIED contact. It is not enrolled;
    // verification still gates any future send through the existing walls.
    if (cand.extractedEmail && cand.extractedEmail.trim() !== '') {
      await db
        .prepare("INSERT INTO contacts (company_id, email, email_status) VALUES (?, ?, 'unverified')")
        .bind(companyId, cand.extractedEmail.trim())
        .run()
    }
    await db
      .prepare(
        `UPDATE lead_candidates SET company_id = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .bind(companyId, id)
      .run()
    await logActivity(db, {
      entityType: 'company',
      entityId: companyId,
      actor,
      kind: 'candidate_approved',
      detail: { candidateId: id, confidence: cand.confidence },
    })
    return { status: 'approved', companyId }
  } catch (err) {
    // Creation failed after the claim — mark failed so the row isn't stranded
    // in a false 'approved' state, and surface the reason.
    await db
      .prepare(
        `UPDATE lead_candidates SET status = 'failed', rejection_reason = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .bind((err as Error).message.slice(0, 500), id)
      .run()
    await logActivity(db, {
      entityType: 'system',
      entityId: id,
      actor,
      kind: 'candidate_failed',
      detail: { candidateId: id, reason: (err as Error).message.slice(0, 300) },
    })
    throw err
  }
}

/** Reject a candidate with an audited reason. Terminal — cannot be re-approved. */
export async function rejectCandidate(
  db: D1Database,
  id: number,
  actor: string,
  reason?: string | null,
): Promise<{ status: 'rejected' }> {
  const res = await db
    .prepare(
      `UPDATE lead_candidates
         SET status = 'rejected', rejection_reason = ?, reviewed_by = ?,
             reviewed_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND status = 'new'`,
    )
    .bind(reason?.slice(0, 500) ?? null, actor, id)
    .run()
  if ((res.meta.changes ?? 0) !== 1) {
    const now = await getCandidate(db, id)
    if (!now) throw new CandidateNotFoundError()
    throw new CandidateStateError(now.status, 'rejected')
  }
  await logActivity(db, {
    entityType: 'system',
    entityId: id,
    actor,
    kind: 'candidate_rejected',
    detail: { candidateId: id, reason: reason?.slice(0, 300) ?? null },
  })
  return { status: 'rejected' }
}
