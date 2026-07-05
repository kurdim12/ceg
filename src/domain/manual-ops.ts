import { activityStatement } from './activities'
import { isStage, type Stage } from './stages'
import { TransitionConflictError } from './transitions'

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
): Promise<{ deleted: boolean; name: string | null }> {
  const company = await db
    .prepare('SELECT name FROM companies WHERE id = ?')
    .bind(companyId)
    .first<{ name: string }>()
  if (!company) return { deleted: false, name: null }

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
