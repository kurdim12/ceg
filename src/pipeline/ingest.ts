import type { SiteFetcher, SourcedBusiness, VerifierAdapter } from '../adapters/types'
import { domainOf } from '../crawler/extract'
import { crawlForEmails } from '../crawler/crawl'
import { logActivity } from '../domain/activities'
import { findDuplicateCompany } from '../domain/dedupe'
import { transitionStage } from '../domain/transitions'
import { enrollContact } from '../sequence/enroll'
import { pickAssignee } from './assign'

export interface IngestDeps {
  /** null = subsystem holding (key unset) — fail-safe, never fake (rule 2). */
  fetchSite: SiteFetcher | null
  verifier: VerifierAdapter | null
  now: Date
  /** Timezone resolution from city; Phase 3 wires the real resolver. */
  resolveTimezone: (city: string, country: string | null) => string | null
}

export type IngestOutcome =
  | { kind: 'deduped'; companyId: number }
  | { kind: 'held'; companyId: number; reason: 'no_verifier' | 'no_crawler' }
  | { kind: 'enrolled'; companyId: number; contactId: number }
  | { kind: 'no_valid_email'; companyId: number }

/**
 * One sourced business through the front half of the pipe:
 * dedupe → create → crawl → verify → assign → enroll or park.
 * Every decision leaves an activity row.
 */
export async function ingestBusiness(
  db: D1Database,
  biz: SourcedBusiness,
  deps: IngestDeps,
): Promise<IngestOutcome> {
  const domain = domainOf(biz.website)

  // Dedupe on domain, then (for websiteless businesses) phone, then name+city —
  // so a nightly sourcing run can't keep re-creating the same shop.
  const dupe = await findDuplicateCompany(db, {
    domain,
    name: biz.name,
    city: biz.city,
    phone: biz.phone,
  })
  if (dupe) {
    await logActivity(db, {
      entityType: 'company',
      entityId: dupe.id,
      actor: 'system:sourcing',
      kind: 'sourcing_deduped',
      detail: { matchedBy: dupe.reason, domain },
    })
    return { kind: 'deduped', companyId: dupe.id }
  }

  const assignee = await pickAssignee(db)
  const timezone = deps.resolveTimezone(biz.city, biz.country)
  const company = await db
    .prepare(
      `INSERT INTO companies
         (name, domain, website, city, country, timezone, phone, phone_format_valid,
          address, source, assignee_id, stage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'places', ?, 'new') RETURNING id`,
    )
    .bind(
      biz.name, domain, biz.website, biz.city, biz.country, timezone, biz.phone,
      biz.phone && biz.phone.trim() !== '' ? 1 : 0, biz.address, assignee,
    )
    .first<{ id: number }>()
  const companyId = company!.id
  await logActivity(db, {
    entityType: 'company',
    entityId: companyId,
    actor: 'system:sourcing',
    kind: 'company_sourced',
    detail: { domain, city: biz.city, assignee },
  })

  // Crawl the site for real addresses — Places never returns emails.
  if (!deps.fetchSite) {
    await logActivity(db, {
      entityType: 'company',
      entityId: companyId,
      actor: 'system:sourcing',
      kind: 'crawl_held',
      detail: { reason: 'crawler unavailable' },
    })
    return { kind: 'held', companyId, reason: 'no_crawler' }
  }
  const emails = biz.website ? await crawlForEmails(deps.fetchSite, biz.website, 3) : []
  await logActivity(db, {
    entityType: 'company',
    entityId: companyId,
    actor: 'system:crawler',
    kind: 'site_crawled',
    detail: { emailsFound: emails.length },
  })

  const contactIds: Array<{ id: number; email: string }> = []
  for (const email of emails) {
    const contact = await db
      .prepare(`INSERT INTO contacts (company_id, email) VALUES (?, ?) RETURNING id`)
      .bind(companyId, email)
      .first<{ id: number }>()
    contactIds.push({ id: contact!.id, email })
    await logActivity(db, {
      entityType: 'contact',
      entityId: contact!.id,
      actor: 'system:crawler',
      kind: 'contact_added',
      detail: { companyId },
    })
  }

  if (contactIds.length === 0) {
    await transitionStage(db, {
      companyId,
      from: 'new',
      to: 'no_valid_email',
      expectedVersion: 0,
      actor: 'system:sourcing',
      detail: { reason: 'no emails found on site' },
    })
    return { kind: 'no_valid_email', companyId }
  }

  // Verify at ingest (map §5). No verifier key = HOLD, never fake.
  if (!deps.verifier) {
    await logActivity(db, {
      entityType: 'company',
      entityId: companyId,
      actor: 'system:verifier',
      kind: 'verification_held',
      detail: { reason: 'ZEROBOUNCE_API_KEY unset — holding, not sending' },
    })
    return { kind: 'held', companyId, reason: 'no_verifier' }
  }

  let firstValid: { id: number; email: string } | null = null
  for (const contact of contactIds) {
    const outcome = await deps.verifier.verify(contact.email)
    await db
      .prepare(
        `UPDATE contacts SET email_status = ?, email_verified_at = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .bind(outcome, deps.now.toISOString(), contact.id)
      .run()
    await logActivity(db, {
      entityType: 'contact',
      entityId: contact.id,
      actor: 'system:verifier',
      kind: 'email_verified',
      detail: { outcome },
    })
    // Catch-all / unknown are HELD — only 'valid' may enter a sequence.
    if (outcome === 'valid' && !firstValid) firstValid = contact
  }

  if (!firstValid) {
    await transitionStage(db, {
      companyId,
      from: 'new',
      to: 'no_valid_email',
      expectedVersion: 0,
      actor: 'system:verifier',
      detail: { reason: 'no deliverable email (invalid/catch-all/unknown are held)' },
    })
    return { kind: 'no_valid_email', companyId }
  }

  await transitionStage(db, {
    companyId,
    from: 'new',
    to: 'email_sequence',
    expectedVersion: 0,
    actor: 'system:sourcing',
  })
  await enrollContact(db, {
    companyId,
    contactId: firstValid.id,
    actor: 'system:sourcing',
    now: deps.now,
  })
  return { kind: 'enrolled', companyId, contactId: firstValid.id }
}
