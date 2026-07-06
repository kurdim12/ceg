import type { SiteFetcher, SourcedBusiness } from '../adapters/types'
import { crawlForEmails } from '../crawler/crawl'
import { domainOf } from '../crawler/extract'
import { logActivity } from '../domain/activities'
import { createLeadCandidate, findOpenCandidate } from '../domain/candidates'

export interface IngestDeps {
  /** null = crawler holding (key/subsystem unset) — fail-safe, never fake (rule 2). */
  fetchSite: SiteFetcher | null
  now: Date
}

export type IngestOutcome =
  | { kind: 'candidate'; candidateId: number; confidence: number }
  | { kind: 'deduped'; candidateId: number }

/**
 * One sourced business → ONE lead candidate. This is the front half of the
 * pipe after the Source Intelligence change: sourcing NEVER writes to
 * `companies`, never verifies, never enrolls, never drafts. It crawls the
 * site once to capture a contact email as *evidence*, scores the candidate
 * deterministically, and parks it for human review. A human approving the
 * candidate is what creates the CRM lead (see approveCandidate).
 *
 * Preserved from the old direct-to-CRM path: domain extraction, the
 * site crawl, and duplicate detection (here at the candidate level so a
 * nightly re-run can't pile up copies of the same open candidate).
 */
export async function ingestBusiness(
  db: D1Database,
  biz: SourcedBusiness,
  deps: IngestDeps,
): Promise<IngestOutcome> {
  const domain = domainOf(biz.website)

  const existing = await findOpenCandidate(db, { domain, name: biz.name, city: biz.city })
  if (existing) {
    await logActivity(db, {
      entityType: 'system',
      entityId: existing.id,
      actor: 'system:sourcing',
      kind: 'candidate_deduped',
      detail: { candidateId: existing.id, matchedOn: domain ? 'domain' : 'name+city' },
    })
    return { kind: 'deduped', candidateId: existing.id }
  }

  // Crawl the site for a real contact email — this is EVIDENCE, not a send
  // target. Places never returns emails; the crawl is the provenance of any
  // address we later show a reviewer. No crawler key ⇒ candidate with no email.
  const evidence: Record<string, unknown> = { sourceType: 'places' }
  let extractedEmail: string | null = null
  if (!deps.fetchSite) {
    evidence.crawl = 'crawler unavailable — sourced from Places listing only'
  } else if (biz.website) {
    const emails = await crawlForEmails(deps.fetchSite, biz.website, 3)
    if (emails.length > 0) {
      extractedEmail = emails[0] ?? null
      evidence.emailSource = biz.website
      evidence.emailsFound = emails
    } else {
      evidence.crawl = 'no contact email found on the site'
    }
  } else {
    evidence.crawl = 'no website on the Places listing'
  }
  if (biz.address) evidence.address = biz.address

  const { id, confidence } = await createLeadCandidate(
    db,
    {
      sourceType: 'places',
      sourceUrl: biz.website ?? null,
      name: biz.name,
      domain,
      website: biz.website,
      city: biz.city,
      country: biz.country,
      phone: biz.phone,
      extractedEmail,
      evidence,
    },
    'system:sourcing',
  )
  return { kind: 'candidate', candidateId: id, confidence }
}
