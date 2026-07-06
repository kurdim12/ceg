import { LATEST_MIGRATION } from '../config/migrations'

export interface SchemaState {
  /** true if the DB is at (or ahead of) the migration the code expects. */
  ok: boolean
  /** true only when the ledger is present but missing an expected migration. */
  behind: boolean
  appliedLatest: string | null
  expectedLatest: string
}

/**
 * Detects a database that is behind the deployed code. Migration names are
 * zero-padded, so a lexicographic MAX gives the newest applied one. If the
 * migration ledger is absent (unusual), we return ok=true rather than cry
 * wolf — a false "pending" is worse than silence there.
 */
export async function schemaState(db: D1Database): Promise<SchemaState> {
  let appliedLatest: string | null
  try {
    const row = await db
      .prepare('SELECT MAX(name) AS latest FROM d1_migrations')
      .first<{ latest: string | null }>()
    appliedLatest = row?.latest ?? null
  } catch {
    return { ok: true, behind: false, appliedLatest: null, expectedLatest: LATEST_MIGRATION }
  }
  const behind = appliedLatest !== null && appliedLatest < LATEST_MIGRATION
  return { ok: !behind, behind, appliedLatest, expectedLatest: LATEST_MIGRATION }
}
