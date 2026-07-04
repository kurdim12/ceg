export type EntityType =
  | 'company'
  | 'contact'
  | 'deal'
  | 'meeting'
  | 'user'
  | 'suppression'
  | 'settings'
  | 'system'

export interface ActivityInput {
  entityType: EntityType
  entityId?: number
  actor: string
  kind: string
  detail?: Record<string, unknown>
}

export function activityStatement(db: D1Database, input: ActivityInput): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO activities (entity_type, entity_id, actor, kind, detail) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(
      input.entityType,
      input.entityId ?? null,
      input.actor,
      input.kind,
      JSON.stringify(input.detail ?? {}),
    )
}

export async function logActivity(db: D1Database, input: ActivityInput): Promise<void> {
  await activityStatement(db, input).run()
}
