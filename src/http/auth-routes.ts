import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { hashPassword, verifyPassword } from '../auth/password'
import { createSession, destroySession } from '../auth/sessions'
import { clearLoginRate, isLoginBlocked, recordLoginFailure } from '../auth/rate-limit'
import { logActivity } from '../domain/activities'
import type { Env } from '../env'

export const authRoutes = new Hono<{ Bindings: Env }>()

/**
 * One-time bootstrap of the two owner-admin accounts. Fail-safe: disabled
 * entirely unless the SETUP_TOKEN secret is configured, and refuses to run
 * once any user exists.
 */
authRoutes.post('/setup', async (c) => {
  const configured = c.env.SETUP_TOKEN
  if (!configured || configured.trim() === '') {
    return c.json({ error: 'setup is not enabled on this deployment' }, 403)
  }
  const body = await c.req.json<{
    token?: string
    owners?: Array<{ email?: string; name?: string; password?: string }>
  }>()
  if (body.token !== configured) return c.json({ error: 'invalid setup token' }, 403)

  const existing = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>()
  if ((existing?.n ?? 0) > 0) return c.json({ error: 'setup already completed' }, 409)

  const owners = body.owners ?? []
  if (owners.length !== 2) return c.json({ error: 'exactly two owner accounts required' }, 400)
  for (const owner of owners) {
    if (!owner.email || !owner.name || !owner.password || owner.password.length < 10) {
      return c.json({ error: 'each owner needs email, name, and a password of 10+ chars' }, 400)
    }
  }

  const ids: number[] = []
  for (const owner of owners) {
    const hash = await hashPassword(owner.password!)
    const row = await c.env.DB.prepare(
      `INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, 'owner_admin', ?) RETURNING id`,
    )
      .bind(owner.email!.toLowerCase(), owner.name!, hash)
      .first<{ id: number }>()
    ids.push(row!.id)
    await logActivity(c.env.DB, {
      entityType: 'user',
      entityId: row!.id,
      actor: 'system:setup',
      kind: 'user_created',
      detail: { email: owner.email },
    })
  }
  return c.json({ ok: true, userIds: ids })
})

authRoutes.post('/login', async (c) => {
  const { email, password } = await c.req.json<{ email?: string; password?: string }>()
  if (!email || !password) return c.json({ error: 'email and password required' }, 400)
  const id = email.toLowerCase()

  // Brute-force throttle: checked BEFORE any password comparison, so a locked
  // identifier reveals nothing about whether the account or password is valid.
  if (await isLoginBlocked(c.env.KV, id)) {
    await logActivity(c.env.DB, { entityType: 'user', actor: 'anon', kind: 'login_rate_limited', detail: { email: id } })
    return c.json({ error: 'too many attempts — wait a few minutes and try again' }, 429)
  }

  const user = await c.env.DB.prepare(
    'SELECT id, email, name, password_hash FROM users WHERE email = ?',
  )
    .bind(id)
    .first<{ id: number; email: string; name: string; password_hash: string }>()

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    await recordLoginFailure(c.env.KV, id)
    await logActivity(c.env.DB, { entityType: 'user', actor: 'anon', kind: 'login_failed', detail: { email: id } })
    return c.json({ error: 'invalid credentials' }, 401)
  }

  await clearLoginRate(c.env.KV, id)
  const token = await createSession(c.env.KV, user, new Date())
  setCookie(c, 'session', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
  })
  await logActivity(c.env.DB, {
    entityType: 'user',
    entityId: user.id,
    actor: `user:${user.id}`,
    kind: 'login',
  })
  return c.json({ ok: true, user: { id: user.id, email: user.email, name: user.name } })
})

authRoutes.post('/logout', async (c) => {
  const token = getCookie(c, 'session')
  if (token) await destroySession(c.env.KV, token)
  deleteCookie(c, 'session', { path: '/' })
  return c.json({ ok: true })
})
