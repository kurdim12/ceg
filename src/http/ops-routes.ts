import { Hono } from 'hono'
import { logActivity } from '../domain/activities'
import { readStage, transitionStage } from '../domain/transitions'
import { evaluateDropGate } from '../ops/phone-gate'
import { buildDailyRecap } from '../ops/recap'
import { evaluateAlerts } from '../ops/alerts'
import { getSettings } from '../settings/store'
import type { Env } from '../env'
import { requireAuth, type AuthVars } from './middleware'
import type { Stage } from '../domain/stages'

export const opsRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>()

opsRoutes.use('*', requireAuth)

const CALL_OUTCOMES = [
  'answered-interested', 'answered-not-interested', 'no-answer',
  'wrong-number', 'callback-later',
] as const

/**
 * The signed-in owner's call queue, one entry per lead with everything
 * the one-screen call view needs (map §3).
 */
opsRoutes.get('/call-queue', async (c) => {
  const userId = c.get('session').userId
  const settings = await getSettings(c.env.KV)
  const companies = await c.env.DB.prepare(
    `SELECT id, name, city, timezone, stage, phone,
            phone_format_valid AS phoneFormatValid, phone_confirmed AS phoneConfirmed
     FROM companies
     WHERE assignee_id = ? AND stage IN ('no_valid_email', 'unresponsive_email')
     ORDER BY stage_changed_at
     LIMIT 50`,
  )
    .bind(userId)
    .all<{
      id: number; name: string; city: string | null; timezone: string | null
      stage: string; phone: string | null; phoneFormatValid: number; phoneConfirmed: number
    }>()

  const queue = []
  for (const company of companies.results) {
    const contacts = await c.env.DB.prepare(
      `SELECT id, name, role, email, email_status AS emailStatus FROM contacts WHERE company_id = ?`,
    )
      .bind(company.id)
      .all()
    const thread = await c.env.DB.prepare(
      `SELECT direction, subject, body, status, created_at AS createdAt
       FROM email_messages WHERE company_id = ? ORDER BY id LIMIT 30`,
    )
      .bind(company.id)
      .all()
    const lastActivity = await c.env.DB.prepare(
      `SELECT kind, actor, created_at AS createdAt FROM activities
       WHERE entity_type = 'company' AND entity_id = ? ORDER BY id DESC LIMIT 1`,
    )
      .bind(company.id)
      .first()
    const callNotes = await c.env.DB.prepare(
      `SELECT outcome, notes, created_at AS createdAt FROM call_attempts
       WHERE company_id = ? ORDER BY id DESC LIMIT 10`,
    )
      .bind(company.id)
      .all()
    const gate = await evaluateDropGate(c.env.DB, settings, company.id)
    queue.push({
      ...company,
      contacts: contacts.results,
      thread: thread.results,
      lastActivity,
      callNotes: callNotes.results,
      dropGate: gate,
    })
  }
  return c.json({ queue })
})

/** Action 1 of 3 on the call screen: log a call outcome. */
opsRoutes.post('/calls', async (c) => {
  const body = await c.req.json<{
    companyId?: number
    contactId?: number
    outcome?: string
    notes?: string
  }>()
  const userId = c.get('session').userId
  if (!Number.isInteger(body.companyId)) return c.json({ error: 'companyId required' }, 400)
  if (!CALL_OUTCOMES.includes(body.outcome as (typeof CALL_OUTCOMES)[number])) {
    return c.json({ error: `outcome must be one of: ${CALL_OUTCOMES.join(', ')}` }, 400)
  }

  await c.env.DB.prepare(
    `INSERT INTO call_attempts (company_id, contact_id, by_user_id, outcome, notes)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      body.companyId, body.contactId ?? null, userId, body.outcome,
      body.notes?.slice(0, 2000) ?? null,
    )
    .run()

  // A human answered → the phone is confirmed (two-field phone, map §3).
  if (body.outcome === 'answered-interested' || body.outcome === 'answered-not-interested') {
    await c.env.DB.prepare(
      `UPDATE companies SET phone_confirmed = 1, updated_at = datetime('now') WHERE id = ?`,
    )
      .bind(body.companyId)
      .run()
  }
  await logActivity(c.env.DB, {
    entityType: 'company',
    entityId: body.companyId,
    actor: `user:${userId}`,
    kind: 'call_logged',
    detail: { outcome: body.outcome },
  })
  return c.json({ ok: true })
})

/** Action 2 of 3: book a meeting — lands in the meetings table, moves stage. */
opsRoutes.post('/meetings', async (c) => {
  const body = await c.req.json<{
    companyId?: number
    contactId?: number
    scheduledAt?: string
    notes?: string
  }>()
  const userId = c.get('session').userId
  if (!Number.isInteger(body.companyId) || !Number.isInteger(body.contactId)) {
    return c.json({ error: 'companyId and contactId required' }, 400)
  }
  await c.env.DB.prepare(
    `INSERT INTO meetings (company_id, contact_id, scheduled_at, source, notes)
     VALUES (?, ?, ?, 'manual', ?)`,
  )
    .bind(body.companyId, body.contactId, body.scheduledAt ?? null, body.notes ?? null)
    .run()

  const state = await readStage(c.env.DB, body.companyId!)
  if (state && state.stage !== 'meeting_booked' &&
      ['replied', 'unresponsive_email', 'no_valid_email'].includes(state.stage)) {
    await transitionStage(c.env.DB, {
      companyId: body.companyId!,
      from: state.stage,
      to: 'meeting_booked',
      expectedVersion: state.version,
      actor: `user:${userId}`,
      detail: { via: 'call_screen' },
    })
  }
  await logActivity(c.env.DB, {
    entityType: 'meeting',
    entityId: body.companyId,
    actor: `user:${userId}`,
    kind: 'meeting_booked',
  })
  return c.json({ ok: true })
})

/** WhatsApp stays manual on the owners' phones — the CRM only logs it. */
opsRoutes.post('/whatsapp-log', async (c) => {
  const { companyId, note } = await c.req.json<{ companyId?: number; note?: string }>()
  if (!Number.isInteger(companyId) || !note || note.trim() === '') {
    return c.json({ error: 'companyId and note required' }, 400)
  }
  await logActivity(c.env.DB, {
    entityType: 'company',
    entityId: companyId,
    actor: `user:${c.get('session').userId}`,
    kind: 'whatsapp_logged',
    detail: { note: note.slice(0, 2000) },
  })
  return c.json({ ok: true })
})

/**
 * Action 3 of 3 prepared the request; this is the owner's confirming
 * click — the ONLY path to `dropped`, and only through an open gate.
 */
/** Owner-initiated "send to drop queue" from the call screen. */
opsRoutes.post('/drops', async (c) => {
  const { companyId, reason } = await c.req.json<{ companyId?: number; reason?: string }>()
  const userId = c.get('session').userId
  if (!Number.isInteger(companyId)) return c.json({ error: 'companyId required' }, 400)
  const row = await c.env.DB.prepare(
    `INSERT INTO drop_requests (company_id, prepared_by, reason) VALUES (?, ?, ?) RETURNING id`,
  )
    .bind(companyId, `user:${userId}`, reason?.slice(0, 500) ?? null)
    .first<{ id: number }>()
  await logActivity(c.env.DB, {
    entityType: 'company',
    entityId: companyId,
    actor: `user:${userId}`,
    kind: 'drop_prepared',
    detail: { dropRequestId: row!.id },
  })
  return c.json({ ok: true, dropRequestId: row!.id })
})

opsRoutes.post('/drops/:id/confirm', async (c) => {
  const id = Number(c.req.param('id'))
  const userId = c.get('session').userId
  const request = await c.env.DB.prepare(
    `SELECT company_id AS companyId FROM drop_requests WHERE id = ? AND status = 'pending'`,
  )
    .bind(id)
    .first<{ companyId: number }>()
  if (!request) return c.json({ error: 'no pending drop request with that id' }, 404)

  const settings = await getSettings(c.env.KV)
  const gate = await evaluateDropGate(c.env.DB, settings, request.companyId)
  if (!gate.droppable) {
    return c.json({ error: `drop gate closed: ${gate.reason}` }, 409)
  }

  const state = await readStage(c.env.DB, request.companyId)
  if (!state || !['unresponsive_email', 'no_valid_email'].includes(state.stage)) {
    return c.json({ error: `lead is in stage ${state?.stage ?? 'unknown'} — not droppable from there` }, 409)
  }
  await transitionStage(c.env.DB, {
    companyId: request.companyId,
    from: state.stage as Stage,
    to: 'dropped',
    expectedVersion: state.version,
    actor: `user:${userId}`,
    detail: { dropRequestId: id, gate },
  })
  await c.env.DB.prepare(
    `UPDATE drop_requests SET status = 'confirmed', resolved_at = datetime('now'), resolved_by = ? WHERE id = ?`,
  )
    .bind(`user:${userId}`, id)
    .run()
  return c.json({ ok: true })
})

opsRoutes.post('/drops/:id/reject', async (c) => {
  const id = Number(c.req.param('id'))
  const userId = c.get('session').userId
  const result = await c.env.DB.prepare(
    `UPDATE drop_requests SET status = 'rejected', resolved_at = datetime('now'), resolved_by = ?
     WHERE id = ? AND status = 'pending'`,
  )
    .bind(`user:${userId}`, id)
    .run()
  if (result.meta.changes !== 1) return c.json({ error: 'no pending drop request with that id' }, 404)
  await logActivity(c.env.DB, {
    entityType: 'system',
    actor: `user:${userId}`,
    kind: 'drop_rejected',
    detail: { dropRequestId: id },
  })
  return c.json({ ok: true })
})

opsRoutes.get('/recap', async (c) => {
  const settings = await getSettings(c.env.KV)
  const recap = await buildDailyRecap(c.env.DB, c.env, settings, new Date())
  return c.json(recap)
})

opsRoutes.get('/alerts', async (c) => {
  const settings = await getSettings(c.env.KV)
  const alerts = await evaluateAlerts(c.env.DB, c.env, settings, new Date())
  return c.json({ alerts })
})
