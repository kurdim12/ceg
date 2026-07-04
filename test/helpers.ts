import { env, SELF } from 'cloudflare:test'
import { hashPassword } from '../src/auth/password'
import type { Stage } from '../src/domain/stages'

export const OWNER_A = { email: 'owner-a@example.com', name: 'Owner A', password: 'owner-a-pass-123' }
export const OWNER_B = { email: 'owner-b@example.com', name: 'Owner B', password: 'owner-b-pass-123' }

/** Inserts the two owner accounts directly; returns their ids. */
export async function createOwners(): Promise<[number, number]> {
  const ids: number[] = []
  for (const owner of [OWNER_A, OWNER_B]) {
    const hash = await hashPassword(owner.password)
    const row = await env.DB.prepare(
      `INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, 'owner_admin', ?) RETURNING id`,
    )
      .bind(owner.email, owner.name, hash)
      .first<{ id: number }>()
    ids.push(row!.id)
  }
  return [ids[0]!, ids[1]!]
}

/** Logs in via the real route and returns the session cookie header value. */
export async function loginCookie(email: string, password: string): Promise<string> {
  const res = await SELF.fetch('http://engine.local/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`)
  const setCookie = res.headers.get('set-cookie') ?? ''
  const match = /session=([0-9a-f]+)/.exec(setCookie)
  if (!match) throw new Error('no session cookie in login response')
  return `session=${match[1]}`
}

export async function createCompany(
  args: { name?: string; domain?: string; stage?: Stage; assigneeId?: number } = {},
): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO companies (name, domain, stage, assignee_id) VALUES (?, ?, ?, ?) RETURNING id`,
  )
    .bind(
      args.name ?? 'Test Co',
      args.domain ?? `test-${crypto.randomUUID()}.example`,
      args.stage ?? 'new',
      args.assigneeId ?? null,
    )
    .first<{ id: number }>()
  return row!.id
}

export async function countRows(table: string, where = '1=1'): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first<{
    n: number
  }>()
  return row?.n ?? 0
}
