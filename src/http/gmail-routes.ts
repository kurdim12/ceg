import { Hono } from 'hono'
import { gmailAuthUrl, tokensKey, type GmailTokens } from '../adapters/gmail'
import { logActivity } from '../domain/activities'
import { getSecret } from '../settings/store'
import type { Env } from '../env'
import { requireAuth, type AuthVars } from './middleware'

/** Owner-authenticated Gmail connect/disconnect. */
export const gmailRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>()

gmailRoutes.use('*', requireAuth)

gmailRoutes.get('/connect', async (c) => {
  const clientId = await getSecret(c.env, 'GMAIL_CLIENT_ID')
  const clientSecret = await getSecret(c.env, 'GMAIL_CLIENT_SECRET')
  if (!clientId || !clientSecret) {
    return c.json(
      { error: 'GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET unset — Gmail connect is holding' },
      409,
    )
  }
  const nonce = crypto.randomUUID()
  await c.env.KV.put(
    `gmail:state:${nonce}`,
    String(c.get('session').userId),
    { expirationTtl: 600 },
  )
  const redirectUri = new URL('/api/auth/gmail/callback', c.req.url).toString()
  return c.json({ url: gmailAuthUrl({ clientId, redirectUri, state: nonce }) })
})

gmailRoutes.post('/disconnect', async (c) => {
  const userId = c.get('session').userId
  await c.env.KV.delete(tokensKey(userId))
  await c.env.DB.prepare('UPDATE users SET gmail_connected = 0 WHERE id = ?').bind(userId).run()
  await logActivity(c.env.DB, {
    entityType: 'user',
    entityId: userId,
    actor: `user:${userId}`,
    kind: 'gmail_disconnected',
    detail: { by: 'owner request' },
  })
  return c.json({ ok: true })
})

/**
 * OAuth callback — public route (Google redirects here); the state nonce
 * binds the grant to the owner who initiated it.
 */
export const gmailCallback = new Hono<{ Bindings: Env }>()

gmailCallback.get('/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  if (!code || !state) return c.text('Missing code or state.', 400)

  const stateKey = `gmail:state:${state}`
  const userIdRaw = await c.env.KV.get(stateKey)
  if (!userIdRaw) return c.text('Connection request expired — start again from Settings.', 400)
  await c.env.KV.delete(stateKey)
  const userId = Number(userIdRaw)

  const clientId = await getSecret(c.env, 'GMAIL_CLIENT_ID')
  const clientSecret = await getSecret(c.env, 'GMAIL_CLIENT_SECRET')
  if (!clientId || !clientSecret) return c.text('Gmail client credentials are not configured.', 409)

  const redirectUri = new URL('/api/auth/gmail/callback', c.req.url).toString()
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) return c.text('Google did not accept the connection. Try again.', 502)
  const data = (await res.json()) as { refresh_token?: string; access_token?: string; expires_in?: number }
  if (!data.refresh_token) {
    return c.text('Google returned no refresh token — remove prior access and reconnect.', 502)
  }

  const tokens: GmailTokens = {
    refresh_token: data.refresh_token,
    access_token: data.access_token,
    access_expires_at: data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : undefined,
  }
  await c.env.KV.put(tokensKey(userId), JSON.stringify(tokens))
  await c.env.DB.prepare('UPDATE users SET gmail_connected = 1 WHERE id = ?').bind(userId).run()
  await logActivity(c.env.DB, {
    entityType: 'user',
    entityId: userId,
    actor: `user:${userId}`,
    kind: 'gmail_connected',
  })
  return c.redirect('/?gmail=connected')
})
