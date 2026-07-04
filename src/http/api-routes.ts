import { Hono } from 'hono'
import { SettingsValidationError } from '../config/defaults'
import { getSettings, isSecretName, secretStatus, setSecret, updateSettings } from '../settings/store'
import { resetDemoData } from '../demo/seed'
import { logActivity } from '../domain/activities'
import type { Env } from '../env'
import { requireAuth, type AuthVars } from './middleware'

export const apiRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>()

apiRoutes.use('*', requireAuth)

apiRoutes.get('/me', (c) => {
  const s = c.get('session')
  return c.json({ id: s.userId, email: s.email, name: s.name })
})

apiRoutes.get('/settings', async (c) => {
  const [settings, secrets] = await Promise.all([
    getSettings(c.env.KV),
    secretStatus(c.env.KV),
  ])
  // Secrets are reported as present/absent booleans only — values never leave KV.
  return c.json({ settings, secrets, dryRun: c.env.DRY_RUN === 'true' })
})

apiRoutes.put('/settings', async (c) => {
  const patch = await c.req.json<Record<string, unknown>>()
  const actor = `user:${c.get('session').userId}`
  try {
    const next = await updateSettings(c.env.DB, c.env.KV, patch, actor)
    return c.json({ ok: true, settings: next })
  } catch (err) {
    if (err instanceof SettingsValidationError) return c.json({ error: err.message }, 400)
    throw err
  }
})

apiRoutes.put('/secrets/:name', async (c) => {
  const name = c.req.param('name')
  if (!isSecretName(name)) return c.json({ error: 'unknown secret name' }, 404)
  const { value } = await c.req.json<{ value?: string }>()
  if (!value || value.trim() === '') return c.json({ error: 'value required' }, 400)
  await setSecret(c.env.DB, c.env.KV, name, value, `user:${c.get('session').userId}`)
  return c.json({ ok: true, name })
})

apiRoutes.get('/companies', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT c.id, c.name, c.domain, c.city, c.country, c.timezone, c.stage,
            c.assignee_id AS assigneeId, u.name AS assigneeName,
            c.phone, c.phone_format_valid AS phoneFormatValid,
            c.phone_confirmed AS phoneConfirmed, c.is_demo AS isDemo,
            (SELECT COUNT(*) FROM contacts ct WHERE ct.company_id = c.id) AS contactCount
     FROM companies c LEFT JOIN users u ON u.id = c.assignee_id
     ORDER BY c.updated_at DESC
     LIMIT 200`,
  ).all()
  return c.json({ companies: rows.results })
})

apiRoutes.get('/companies/:id/activities', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'bad id' }, 400)
  const rows = await c.env.DB.prepare(
    `SELECT id, actor, kind, detail, created_at AS createdAt
     FROM activities WHERE entity_type = 'company' AND entity_id = ?
     ORDER BY id DESC LIMIT 200`,
  )
    .bind(id)
    .all()
  return c.json({ activities: rows.results })
})

apiRoutes.post('/demo/reset', async (c) => {
  const owners = await c.env.DB.prepare(
    "SELECT id FROM users WHERE role = 'owner_admin' ORDER BY id LIMIT 2",
  ).all<{ id: number }>()
  if (owners.results.length < 2) {
    return c.json({ error: 'demo data needs the two owner accounts first' }, 409)
  }
  const actor = `user:${c.get('session').userId}`
  const result = await resetDemoData(
    c.env.DB,
    [owners.results[0]!.id, owners.results[1]!.id],
    actor,
  )
  await logActivity(c.env.DB, {
    entityType: 'system',
    actor,
    kind: 'demo_reset_requested',
  })
  return c.json({ ok: true, ...result })
})
