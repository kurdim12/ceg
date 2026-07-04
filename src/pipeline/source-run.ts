import type { PlacesAdapter, SiteFetcher, VerifierAdapter } from '../adapters/types'
import { logActivity } from '../domain/activities'
import { resolveTimezone } from '../schedule/timezones'
import { ingestBusiness } from './ingest'

export interface SourcingParams {
  geo: string
  businessType: string
  count: number
}

export interface SourcingTally {
  requested: number
  found: number
  created: number
  deduped: number
  enrolled: number
  noValidEmail: number
  held: number
}

/**
 * One sourcing run — cron-daily or human-triggered with explicit
 * parameters (geo, business type, count are always caller-supplied;
 * nothing about geography is baked in).
 */
export async function runSourcing(
  db: D1Database,
  adapters: {
    places: PlacesAdapter
    fetchSite: SiteFetcher | null
    verifier: VerifierAdapter | null
  },
  params: SourcingParams,
  now: Date,
  actor: string,
): Promise<SourcingTally> {
  const businesses = await adapters.places.searchBusinesses(params)
  const tally: SourcingTally = {
    requested: params.count,
    found: businesses.length,
    created: 0,
    deduped: 0,
    enrolled: 0,
    noValidEmail: 0,
    held: 0,
  }

  for (const biz of businesses) {
    const outcome = await ingestBusiness(db, biz, {
      fetchSite: adapters.fetchSite,
      verifier: adapters.verifier,
      now,
      resolveTimezone,
    })
    switch (outcome.kind) {
      case 'deduped':
        tally.deduped++
        break
      case 'enrolled':
        tally.created++
        tally.enrolled++
        break
      case 'no_valid_email':
        tally.created++
        tally.noValidEmail++
        break
      case 'held':
        tally.created++
        tally.held++
        break
    }
  }

  await logActivity(db, {
    entityType: 'system',
    actor,
    kind: 'sourcing_run',
    detail: { ...params, ...tally },
  })
  return tally
}
