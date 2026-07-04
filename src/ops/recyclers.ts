import type { Settings } from '../config/defaults'
import { logActivity } from '../domain/activities'
import { readStage, transitionStage } from '../domain/transitions'

/**
 * Recycler jobs (map §12 item 16): `lost` leads become re-approachable
 * after 6 months; `dropped` leads recycle into the pool after 12 months.
 * Leads whose every emailed contact is suppressed never recycle — a
 * "stop emailing me" outlives every clock.
 */
export async function runRecyclers(
  db: D1Database,
  settings: Settings,
  now: Date,
): Promise<{ lostRecycled: number; droppedRecycled: number }> {
  const nowIso = now.toISOString()

  async function recycle(
    fromStage: 'lost' | 'dropped',
    months: number,
    kind: string,
  ): Promise<number> {
    const candidates = await db
      .prepare(
        `SELECT c.id FROM companies c
         WHERE c.stage = ?
           AND c.stage_changed_at <= datetime(?, '-' || ? || ' months')
           AND NOT EXISTS (
             SELECT 1 FROM contacts ct
             JOIN suppression s ON s.email = lower(ct.email)
             WHERE ct.company_id = c.id
           )
         LIMIT 100`,
      )
      .bind(fromStage, nowIso, months)
      .all<{ id: number }>()

    let recycled = 0
    for (const row of candidates.results) {
      try {
        const state = await readStage(db, row.id)
        if (!state || state.stage !== fromStage) continue
        await transitionStage(db, {
          companyId: row.id,
          from: fromStage,
          to: 'new',
          expectedVersion: state.version,
          actor: 'system:recycler',
          detail: { afterMonths: months, kind },
        })
        recycled++
      } catch {
        // Conflicts skip quietly; the next daily run picks them up.
      }
    }
    if (recycled > 0) {
      await logActivity(db, {
        entityType: 'system',
        actor: 'system:recycler',
        kind,
        detail: { recycled },
      })
    }
    return recycled
  }

  const lostRecycled = await recycle('lost', settings.lostReapproachMonths, 'recycled_lost')
  const droppedRecycled = await recycle('dropped', settings.dropRecycleMonths, 'recycled_dropped')
  return { lostRecycled, droppedRecycled }
}
