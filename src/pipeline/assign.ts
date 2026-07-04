/** Round-robin assignment: the owner currently carrying fewer leads. */
export async function pickAssignee(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT u.id
       FROM users u
       LEFT JOIN companies c ON c.assignee_id = u.id
       WHERE u.role = 'owner_admin'
       GROUP BY u.id
       ORDER BY COUNT(c.id) ASC, u.id ASC
       LIMIT 1`,
    )
    .first<{ id: number }>()
  return row?.id ?? null
}
