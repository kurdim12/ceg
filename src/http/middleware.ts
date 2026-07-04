import { createMiddleware } from 'hono/factory'
import { getCookie } from 'hono/cookie'
import { getSession, type Session } from '../auth/sessions'
import type { Env } from '../env'

export type AuthVars = { session: Session; sessionToken: string }

/** Human-session gate for every /api route except login/setup/health. */
export const requireAuth = createMiddleware<{ Bindings: Env; Variables: AuthVars }>(
  async (c, next) => {
    const token = getCookie(c, 'session')
    if (!token) return c.json({ error: 'unauthorized' }, 401)
    const session = await getSession(c.env.KV, token)
    if (!session) return c.json({ error: 'unauthorized' }, 401)
    c.set('session', session)
    c.set('sessionToken', token)
    await next()
  },
)
