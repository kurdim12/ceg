import { getPlaces, getSiteFetcher, getVerifier } from '../adapters/factory'
import { logActivity } from '../domain/activities'
import { runSourcing } from '../pipeline/source-run'
import { advanceDueEnrollments } from '../sequence/enroll'
import { getSettings } from '../settings/store'

type CronEnv = { DB: D1Database; KV: KVNamespace }

/**
 * The single hourly cron tick. Every hour: advance due enrollments into
 * drafts for leads inside their local window. At the sourcing hour
 * (default 23:00 UTC = 02:00 Amman): one daily sourcing run. Every hold
 * (missing key, unconfigured targets) is audited, never silent.
 */
export async function runCronTick(env: CronEnv, now: Date): Promise<void> {
  const settings = await getSettings(env.KV)

  const advanced = await advanceDueEnrollments(env.DB, settings, now)
  if (advanced.drafted > 0 || advanced.exhausted > 0) {
    await logActivity(env.DB, {
      entityType: 'system',
      actor: 'system:dispatcher',
      kind: 'dispatch_tick',
      detail: { ...advanced, at: now.toISOString() },
    })
  }

  if (now.getUTCHours() !== settings.sourcingUtcHour) return

  const places = await getPlaces(env.KV)
  if (!places) {
    await logActivity(env.DB, {
      entityType: 'system',
      actor: 'system:sourcing',
      kind: 'sourcing_held',
      detail: { reason: 'GOOGLE_PLACES_API_KEY unset — daily sourcing holds' },
    })
    return
  }
  if (settings.sourcingGeo === '' || settings.sourcingBusinessType === '') {
    await logActivity(env.DB, {
      entityType: 'system',
      actor: 'system:sourcing',
      kind: 'sourcing_skipped',
      detail: { reason: 'sourcing geo/business type not configured in settings' },
    })
    return
  }

  await runSourcing(
    env.DB,
    {
      places,
      fetchSite: getSiteFetcher(),
      verifier: await getVerifier(env.KV),
    },
    {
      geo: settings.sourcingGeo,
      businessType: settings.sourcingBusinessType,
      count: settings.sourcingVolumePerDay,
    },
    now,
    'system:sourcing',
  )
}
