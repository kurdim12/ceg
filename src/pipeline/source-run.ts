import type { PlacesAdapter, SiteFetcher } from '../adapters/types'
import { logActivity } from '../domain/activities'
import { ingestBusiness } from './ingest'

export interface SourcingParams {
  geo: string
  businessType: string
  count: number
}

export interface SourcingTally {
  requested: number
  found: number
  /** New candidates parked for human review. */
  candidates: number
  /** Businesses that already had an open candidate — not re-created. */
  deduped: number
}

/**
 * One sourcing run — cron-daily or human-triggered with explicit parameters
 * (geo, business type, count are always caller-supplied; nothing about
 * geography is baked in). Produces lead CANDIDATES only: no company is
 * created, nothing is verified, enrolled, or emailed. A human reviews and
 * approves candidates before they enter the CRM.
 */
export async function runSourcing(
  db: D1Database,
  adapters: {
    places: PlacesAdapter
    fetchSite: SiteFetcher | null
  },
  params: SourcingParams,
  now: Date,
  actor: string,
): Promise<SourcingTally> {
  const businesses = await adapters.places.searchBusinesses(params)
  const tally: SourcingTally = {
    requested: params.count,
    found: businesses.length,
    candidates: 0,
    deduped: 0,
  }

  for (const biz of businesses) {
    const outcome = await ingestBusiness(db, biz, { fetchSite: adapters.fetchSite, now })
    if (outcome.kind === 'candidate') tally.candidates++
    else tally.deduped++
  }

  await logActivity(db, {
    entityType: 'system',
    actor,
    kind: 'sourcing_run',
    detail: { ...params, ...tally },
  })
  return tally
}
