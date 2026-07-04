import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from '../src/auth/password'
import { createOwners, loginCookie, OWNER_A } from './helpers'

const BASE = 'http://engine.local'

function post(path: string, body: unknown, cookie?: string) {
  return SELF.fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  })
}

describe('PBKDF2 passwords', () => {
  it('roundtrips and rejects wrong passwords', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(hash.startsWith('pbkdf2:100000:')).toBe(true)
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true)
    expect(await verifyPassword('wrong password', hash)).toBe(false)
    expect(await verifyPassword('anything', 'garbage')).toBe(false)
  })
})

describe('one-time setup', () => {
  const owners = [
    { email: 'a@example.com', name: 'A', password: 'password-abc-1' },
    { email: 'b@example.com', name: 'B', password: 'password-abc-2' },
  ]

  it('rejects a bad token', async () => {
    const res = await post('/api/auth/setup', { token: 'nope', owners })
    expect(res.status).toBe(403)
  })

  it('creates exactly two owners once, then locks', async () => {
    const ok = await post('/api/auth/setup', { token: 'test-setup-token', owners })
    expect(ok.status).toBe(200)
    const again = await post('/api/auth/setup', { token: 'test-setup-token', owners })
    expect(again.status).toBe(409)
  })

  it('requires exactly two owners with strong passwords', async () => {
    const one = await post('/api/auth/setup', { token: 'test-setup-token', owners: [owners[0]] })
    expect(one.status).toBe(400)
    const weak = await post('/api/auth/setup', {
      token: 'test-setup-token',
      owners: [owners[0], { email: 'c@example.com', name: 'C', password: 'short' }],
    })
    expect(weak.status).toBe(400)
  })
})

describe('login and session gate', () => {
  it('logs in with a cookie and reads /api/me', async () => {
    await createOwners()
    const cookie = await loginCookie(OWNER_A.email, OWNER_A.password)
    const me = await SELF.fetch(BASE + '/api/me', { headers: { Cookie: cookie } })
    expect(me.status).toBe(200)
    const body = await me.json<{ email: string }>()
    expect(body.email).toBe(OWNER_A.email)
  })

  it('rejects bad credentials and missing sessions', async () => {
    await createOwners()
    const bad = await post('/api/auth/login', { email: OWNER_A.email, password: 'wrong' })
    expect(bad.status).toBe(401)
    const anon = await SELF.fetch(BASE + '/api/me')
    expect(anon.status).toBe(401)
    const forged = await SELF.fetch(BASE + '/api/me', {
      headers: { Cookie: `session=${'0'.repeat(64)}` },
    })
    expect(forged.status).toBe(401)
  })

  it('logout destroys the session', async () => {
    await createOwners()
    const cookie = await loginCookie(OWNER_A.email, OWNER_A.password)
    await post('/api/auth/logout', {}, cookie)
    const me = await SELF.fetch(BASE + '/api/me', { headers: { Cookie: cookie } })
    expect(me.status).toBe(401)
  })
})
