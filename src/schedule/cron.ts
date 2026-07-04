import { getGmailFor, getGmailReaderFor, getLlm, getPlaces, getSiteFetcher, getVerifier } from '../adapters/factory'
import { logActivity } from '../domain/activities'
import { processInboundMessage } from '../inbox/process'
import { runSourcing } from '../pipeline/source-run'
import { advanceDueEnrollments } from '../sequence/enroll'
import { autoApprovePastReview } from '../sequence/review-mode'
import { processApprovedSends, resumePausedEnrollments } from '../sequence/send'
import { getSettings } from '../settings/store'
import type { Settings } from '../config/defaults'

type CronEnv = { DB: D1Database; KV: KVNamespace; DRY_RUN: string }

/**
 * The single hourly cron tick. Every hour: resume expired OOO pauses,
 * advance due enrollments into drafts for leads inside their local
 * window, auto-approve past first-20 review, and walk the send path
 * (which itself enforces breaker → suppression → window → caps →
 * DRY_RUN → connected inbox). At the sourcing hour (default 23:00 UTC =
 * 02:00 Amman): one daily sourcing run. Every hold is audited, never
 * silent.
 */
export async function runCronTick(env: CronEnv, now: Date): Promise<void> {
  const settings = await getSettings(env.KV)

  await resumePausedEnrollments(env.DB, now)
  const advanced = await advanceDueEnrollments(env.DB, settings, now)
  if (advanced.drafted > 0 || advanced.exhausted > 0) {
    await logActivity(env.DB, {
      entityType: 'system',
      actor: 'system:dispatcher',
      kind: 'dispatch_tick',
      detail: { ...advanced, at: now.toISOString() },
    })
  }

  await autoApprovePastReview(env.DB, now)
  await processApprovedSends(env.DB, env.KV, settings, {
    dryRun: env.DRY_RUN === 'true',
    gmailFor: (userId) => getGmailFor(env.DB, env.KV, userId),
    now,
  })
  await pollConnectedInboxes(env, settings, now)

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

/**
 * Reads each connected owner inbox and runs new messages through triage.
 * Not-connected inboxes are skipped quietly — /api/status already shows
 * them as holding; a failing poll on a connected inbox IS audited.
 */
async function pollConnectedInboxes(
  env: CronEnv,
  settings: Settings,
  now: Date,
): Promise<void> {
  const owners = await env.DB.prepare(
    `SELECT id FROM users WHERE role = 'owner_admin' AND gmail_connected = 1`,
  ).all<{ id: number }>()
  const llm = await getLlm(env.KV)

  for (const owner of owners.results) {
    const reader = await getGmailReaderFor(env.DB, env.KV, owner.id)
    if (!reader) continue
    const cursorKey = `gmail:inbox_cursor:${owner.id}`
    try {
      const cursorRaw = await env.KV.get(cursorKey)
      const { messages, cursor } = await reader.listNewInbound(
        cursorRaw ? Number(cursorRaw) : null,
      )
      for (const msg of messages) {
        await processInboundMessage(
          env.DB,
          env.KV,
          { llm, settings, now },
          {
            fromEmail: msg.fromEmail,
            subject: msg.subject,
            body: msg.body,
            toUserId: owner.id,
          },
        )
      }
      if (cursor !== null) await env.KV.put(cursorKey, String(cursor))
    } catch (err) {
      await logActivity(env.DB, {
        entityType: 'system',
        actor: 'system:inbox',
        kind: 'inbox_poll_failed',
        detail: { ownerId: owner.id, error: (err as Error).message.slice(0, 300) },
      })
    }
  }
}
