import { isLegalTransition, type Stage } from './stages'
import { activityStatement } from './activities'

export class IllegalTransitionError extends Error {
  constructor(from: Stage, to: Stage) {
    super(`illegal stage transition: ${from} -> ${to}`)
  }
}

export class TransitionConflictError extends Error {
  constructor(companyId: number) {
    super(`stage transition conflict for company ${companyId} (stale read, retry)`)
  }
}

/**
 * Compare-and-swap stage transition. The UPDATE only lands if the row still
 * holds the stage (and version) the caller read — a concurrent writer makes
 * this a no-op and the caller gets a conflict, never a lost update.
 *
 * The audit INSERT runs in the same atomic batch, guarded by `changes()` so
 * it only writes when the UPDATE actually landed — no false audit rows.
 */
export async function transitionStage(
  db: D1Database,
  args: {
    companyId: number
    from: Stage
    to: Stage
    expectedVersion: number
    actor: string
    detail?: Record<string, unknown>
  },
): Promise<void> {
  const { companyId, from, to, expectedVersion, actor } = args
  if (!isLegalTransition(from, to)) throw new IllegalTransitionError(from, to)

  const update = db
    .prepare(
      `UPDATE companies
         SET stage = ?, stage_version = stage_version + 1,
             stage_changed_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND stage = ? AND stage_version = ?`,
    )
    .bind(to, companyId, from, expectedVersion)

  const auditIfLanded = db
    .prepare(
      `INSERT INTO activities (entity_type, entity_id, actor, kind, detail)
       SELECT 'company', ?, ?, 'stage_change', ?
       WHERE (SELECT changes()) = 1`,
    )
    .bind(companyId, actor, JSON.stringify({ from, to, ...args.detail }))

  const [updateResult] = await db.batch([update, auditIfLanded])
  if ((updateResult?.meta.changes ?? 0) !== 1) {
    await activityStatement(db, {
      entityType: 'company',
      entityId: companyId,
      actor,
      kind: 'stage_change_conflict',
      detail: { from, to, expectedVersion },
    }).run()
    throw new TransitionConflictError(companyId)
  }
}

export async function readStage(
  db: D1Database,
  companyId: number,
): Promise<{ stage: Stage; version: number } | null> {
  const row = await db
    .prepare('SELECT stage, stage_version AS version FROM companies WHERE id = ?')
    .bind(companyId)
    .first<{ stage: Stage; version: number }>()
  return row ?? null
}
