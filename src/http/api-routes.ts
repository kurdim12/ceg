import { Hono } from 'hono'
import { getLlm, getPlaces, getSiteFetcher, getVerifier } from '../adapters/factory'
import { confirmBulk } from '../agent/registry'
import { runAgentChat } from '../agent/loop'
import { SettingsValidationError } from '../config/defaults'
import { getSettings, isSecretName, secretStatus, setSecret, updateSettings } from '../settings/store'
import { resetDemoData } from '../demo/seed'
import { logActivity } from '../domain/activities'
import { isStage } from '../domain/stages'
import { createCompany, deleteCompany, setStageManual, updateCompanyFields } from '../domain/manual-ops'
import { runSourcing } from '../pipeline/source-run'
import { evaluateBounceRate, getBreaker, resetBreaker } from '../sequence/breaker'
import { approveDraft, approvedOutboundCount, isReviewModeActive, REVIEW_MODE_THRESHOLD } from '../sequence/review-mode'
import type { Env } from '../env'
import { requireAuth, type AuthVars } from './middleware'

export const apiRoutes = new Hono<{ Bindings: Env; Variables: AuthVars }>()

apiRoutes.use('*', requireAuth)

apiRoutes.get('/me', async (c) => {
  const s = c.get('session')
  // Surface the owner's own Gmail-connection + booking-link state so the UI
  // can show a real status instead of a bare Connect button.
  const row = await c.env.DB.prepare(
    'SELECT gmail_connected AS gmailConnected, booking_link AS bookingLink FROM users WHERE id = ?',
  )
    .bind(s.userId)
    .first<{ gmailConnected: number; bookingLink: string | null }>()
  return c.json({
    id: s.userId,
    email: s.email,
    name: s.name,
    gmailConnected: Boolean(row?.gmailConnected),
    bookingLink: row?.bookingLink ?? null,
  })
})

/** The owner accounts — powers assignee pickers on create/edit. */
apiRoutes.get('/users', async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, name, email FROM users WHERE role = 'owner_admin' ORDER BY id",
  ).all()
  return c.json({ users: rows.results })
})

apiRoutes.get('/settings', async (c) => {
  const [settings, secrets] = await Promise.all([
    getSettings(c.env.KV),
    secretStatus(c.env),
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

/** Owner-created lead (manual entry). Fields are optional except the name. */
apiRoutes.post('/companies', async (c) => {
  const body = await c.req.json<Record<string, unknown>>()
  if (typeof body.name !== 'string' || body.name.trim() === '' || body.name.length > 200) {
    return c.json({ error: 'name is required (max 200 chars)' }, 400)
  }
  try {
    const { id } = await createCompany(
      c.env.DB,
      {
        name: body.name,
        website: typeof body.website === 'string' ? body.website : null,
        city: typeof body.city === 'string' ? body.city : null,
        country: typeof body.country === 'string' ? body.country : null,
        timezone: typeof body.timezone === 'string' ? body.timezone : null,
        phone: typeof body.phone === 'string' ? body.phone : null,
        businessType: typeof body.businessType === 'string' ? body.businessType : null,
        assigneeId: typeof body.assigneeId === 'number' ? body.assigneeId : null,
      },
      `user:${c.get('session').userId}`,
    )
    return c.json({ ok: true, id }, 201)
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400)
  }
})

/** Owner edit of allowlisted lead fields (name, phone, city, country, website, type, assignee). */
apiRoutes.patch('/companies/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'bad id' }, 400)
  const patch = await c.req.json<Record<string, unknown>>()
  try {
    const result = await updateCompanyFields(c.env.DB, id, patch, `user:${c.get('session').userId}`)
    return c.json({ ok: true, ...result })
  } catch (err) {
    const msg = (err as Error).message
    return c.json({ error: msg }, msg === 'no such company' ? 404 : 400)
  }
})

/** Owner-initiated manual stage change — any stage, CAS-guarded, audited. */
apiRoutes.put('/companies/:id/stage', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'bad id' }, 400)
  const { stage } = await c.req.json<{ stage?: string }>()
  if (!stage || !isStage(stage)) return c.json({ error: 'unknown stage' }, 400)
  const current = await c.env.DB.prepare('SELECT stage_version AS v FROM companies WHERE id = ?')
    .bind(id)
    .first<{ v: number }>()
  if (!current) return c.json({ error: 'no such company' }, 404)
  try {
    const result = await setStageManual(c.env.DB, {
      companyId: id,
      to: stage,
      expectedVersion: current.v,
      actor: `user:${c.get('session').userId}`,
    })
    return c.json({ ok: true, ...result })
  } catch (err) {
    return c.json({ error: (err as Error).message }, 409)
  }
})

/** Hard delete a company and its rows (owner's explicit no-limits choice). */
apiRoutes.delete('/companies/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'bad id' }, 400)
  const result = await deleteCompany(c.env.DB, id, `user:${c.get('session').userId}`)
  if (!result.deleted) return c.json({ error: 'no such company' }, 404)
  return c.json({ ok: true, name: result.name })
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

/** Read-only deals feed for the board: company, amount, stage, assignee, entered-stage date. */
apiRoutes.get('/deals', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT d.id, d.company_id AS companyId, c.name AS companyName,
            d.amount_usd_cents AS amountUsdCents, c.stage,
            c.assignee_id AS assigneeId, u.name AS assigneeName,
            c.stage_changed_at AS enteredStageAt
     FROM deals d
     JOIN companies c ON c.id = d.company_id
     LEFT JOIN users u ON u.id = c.assignee_id
     WHERE c.stage IN ('deal', 'won', 'lost')
     ORDER BY c.stage_changed_at DESC
     LIMIT 500`,
  ).all()
  return c.json({ deals: rows.results })
})

/** One company with its contacts + recent email thread — powers the record drawer. */
apiRoutes.get('/companies/:id/detail', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'bad id' }, 400)
  const company = await c.env.DB.prepare(
    `SELECT c.id, c.name, c.domain, c.website, c.city, c.country, c.timezone,
            c.phone, c.phone_format_valid AS phoneFormatValid, c.phone_confirmed AS phoneConfirmed,
            c.business_type AS businessType, c.stage, c.assignee_id AS assigneeId,
            u.name AS assigneeName, c.created_at AS createdAt
     FROM companies c LEFT JOIN users u ON u.id = c.assignee_id WHERE c.id = ?`,
  )
    .bind(id)
    .first()
  if (!company) return c.json({ error: 'no such company' }, 404)
  const contacts = await c.env.DB.prepare(
    `SELECT id, name, role, email, email_status AS emailStatus FROM contacts WHERE company_id = ? ORDER BY id`,
  )
    .bind(id)
    .all()
  const thread = await c.env.DB.prepare(
    `SELECT direction, subject, body, status, triage, created_at AS createdAt
     FROM email_messages WHERE company_id = ? ORDER BY id DESC LIMIT 20`,
  )
    .bind(id)
    .all()
  const deal = await c.env.DB.prepare(
    `SELECT status, amount_usd_cents AS amountUsdCents FROM deals WHERE company_id = ? ORDER BY id DESC LIMIT 1`,
  )
    .bind(id)
    .first()
  return c.json({ company, contacts: contacts.results, thread: thread.results, deal })
})

/** Chart series for the daily recap: funnel, 14-day sends, reply mix. */
apiRoutes.get('/recap/charts', async (c) => {
  const db = c.env.DB
  const funnelRows = await db.prepare(
    `SELECT stage, COUNT(*) AS n FROM companies WHERE is_demo IN (0, 1) GROUP BY stage`,
  ).all<{ stage: string; n: number }>()
  const funnel = Object.fromEntries(funnelRows.results.map((r) => [r.stage, r.n]))

  const sinceIso = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString()
  const sends = await db
    .prepare(
      `SELECT date(sent_at) AS d, COUNT(*) AS n FROM email_messages
       WHERE status = 'sent' AND sent_at >= ? GROUP BY date(sent_at) ORDER BY d`,
    )
    .bind(sinceIso)
    .all<{ d: string; n: number }>()
  const drafts = await db
    .prepare(
      `SELECT date(created_at) AS d, COUNT(*) AS n FROM email_messages
       WHERE direction = 'outbound' AND created_at >= ? GROUP BY date(created_at) ORDER BY d`,
    )
    .bind(sinceIso)
    .all<{ d: string; n: number }>()
  const replyMix = await db
    .prepare(
      `SELECT COALESCE(triage, 'other') AS t, COUNT(*) AS n FROM email_messages
       WHERE direction = 'inbound' GROUP BY COALESCE(triage, 'other')`,
    )
    .all<{ t: string; n: number }>()

  return c.json({
    funnel,
    sends: sends.results,
    drafts: drafts.results,
    replyMix: replyMix.results,
  })
})

apiRoutes.get('/status', async (c) => {
  const [settings, secrets] = await Promise.all([getSettings(c.env.KV), secretStatus(c.env)])
  return c.json({
    dryRun: c.env.DRY_RUN === 'true',
    subsystems: {
      verifier: secrets.ZEROBOUNCE_API_KEY ? 'live' : 'holding',
      places: secrets.GOOGLE_PLACES_API_KEY ? 'live' : 'holding',
      llm: secrets.OPENROUTER_API_KEY ? 'live' : 'holding',
      gmailClient: secrets.GMAIL_CLIENT_ID && secrets.GMAIL_CLIENT_SECRET ? 'configured' : 'holding',
      crawler: 'live',
      dailySourcing:
        settings.sourcingGeo !== '' && settings.sourcingBusinessType !== ''
          ? 'configured'
          : 'unconfigured',
    },
  })
})

/** Manual sourcing run — fully parameterized by the human triggering it. */
apiRoutes.post('/sourcing/run', async (c) => {
  const body = await c.req.json<{ geo?: string; businessType?: string; count?: number }>()
  const geo = (body.geo ?? '').trim()
  const businessType = (body.businessType ?? '').trim()
  const count = body.count
  if (geo === '' || geo.length > 120 || businessType === '' || businessType.length > 120) {
    return c.json({ error: 'geo and businessType are required (max 120 chars)' }, 400)
  }
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 100) {
    return c.json({ error: 'count must be an integer between 1 and 100' }, 400)
  }

  const places = await getPlaces(c.env)
  if (!places) {
    // Fail-safe, never fake: no key, no sourcing, clear reason.
    return c.json({ error: 'GOOGLE_PLACES_API_KEY unset — sourcing is holding' }, 409)
  }
  const tally = await runSourcing(
    c.env.DB,
    { places, fetchSite: getSiteFetcher(), verifier: await getVerifier(c.env) },
    { geo, businessType, count },
    new Date(),
    `user:${c.get('session').userId}`,
  )
  return c.json({ ok: true, tally })
})

/** Outbound drafts awaiting owner review (first-20 mode and reply drafts). */
apiRoutes.get('/messages/drafts', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT m.id, m.step, m.subject, m.body, m.to_email AS toEmail,
            m.created_at AS createdAt, c.name AS companyName, c.id AS companyId,
            u.name AS senderName
     FROM email_messages m
     JOIN companies c ON c.id = m.company_id
     LEFT JOIN users u ON u.id = m.from_user_id
     WHERE m.status = 'draft' AND m.direction = 'outbound'
     ORDER BY m.created_at
     LIMIT 100`,
  ).all()
  return c.json({ drafts: rows.results })
})

apiRoutes.post('/messages/:id/approve', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'bad id' }, 400)
  const ok = await approveDraft(c.env.DB, id, `user:${c.get('session').userId}`, new Date())
  if (!ok) return c.json({ error: 'not a pending draft' }, 409)
  return c.json({
    ok: true,
    reviewMode: {
      active: await isReviewModeActive(c.env.DB),
      approved: await approvedOutboundCount(c.env.DB),
      threshold: REVIEW_MODE_THRESHOLD,
    },
  })
})

apiRoutes.get('/review-status', async (c) => {
  return c.json({
    active: await isReviewModeActive(c.env.DB),
    approved: await approvedOutboundCount(c.env.DB),
    threshold: REVIEW_MODE_THRESHOLD,
  })
})

apiRoutes.get('/breaker', async (c) => {
  const [state, settings] = await Promise.all([getBreaker(c.env.KV), getSettings(c.env.KV)])
  const verdict = await evaluateBounceRate(c.env.DB, settings, new Date())
  return c.json({ state, verdict })
})

/** Human-only breaker reset after investigation; audited. */
apiRoutes.post('/breaker/reset', async (c) => {
  await resetBreaker(c.env.DB, c.env.KV, `user:${c.get('session').userId}`)
  return c.json({ ok: true })
})

apiRoutes.put('/me/booking-link', async (c) => {
  const { url } = await c.req.json<{ url?: string }>()
  if (url !== '' && url !== undefined) {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:') throw new Error('not https')
    } catch {
      return c.json({ error: 'booking link must be a valid https URL (or blank to clear)' }, 400)
    }
  }
  const userId = c.get('session').userId
  await c.env.DB.prepare('UPDATE users SET booking_link = ? WHERE id = ?')
    .bind(url === '' ? null : (url ?? null), userId)
    .run()
  await logActivity(c.env.DB, {
    entityType: 'user',
    entityId: userId,
    actor: `user:${userId}`,
    kind: 'booking_link_set',
    detail: { set: Boolean(url) },
  })
  return c.json({ ok: true })
})

/** Chat with the CRM agent. It acts only through its tool registry. */
apiRoutes.post('/agent/chat', async (c) => {
  const { message, history, context } = await c.req.json<{
    message?: string
    history?: Array<{ role: 'user' | 'assistant'; text: string }>
    context?: { view?: unknown; record?: { id?: unknown; name?: unknown } }
  }>()
  if (!message || message.trim() === '' || message.length > 4000) {
    return c.json({ error: 'message required (max 4000 chars)' }, 400)
  }
  // Screen context is a UI-provided hint (which view / which lead is open).
  // Sanitised to safe primitives; the agent still re-reads by id before acting.
  const screen: { view?: string; record?: { id: number; name: string } } = {}
  if (typeof context?.view === 'string') screen.view = context.view.slice(0, 40)
  if (context?.record && Number.isInteger(context.record.id) && typeof context.record.name === 'string') {
    screen.record = { id: context.record.id as number, name: context.record.name.slice(0, 200) }
  }
  const turn = await runAgentChat(
    {
      db: c.env.DB,
      kv: c.env.KV,
      llm: await getLlm(c.env),
      userId: c.get('session').userId,
    },
    message,
    Array.isArray(history) ? history : [],
    screen,
  )
  return c.json(turn)
})

/** Owner confirmation for an agent-prepared bulk operation (>20 records). */
apiRoutes.post('/agent/bulk-confirm', async (c) => {
  const { token } = await c.req.json<{ token?: string }>()
  if (!token) return c.json({ error: 'token required' }, 400)
  const result = await confirmBulk(
    c.env.DB, c.env.KV, token, `user:${c.get('session').userId}`,
  )
  return c.json(result, result.ok ? 200 : 410)
})

apiRoutes.get('/inbox', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT m.id, m.subject, m.triage, m.created_at AS createdAt,
            c.name AS companyName, c.id AS companyId,
            ct.email AS fromEmail
     FROM email_messages m
     JOIN companies c ON c.id = m.company_id
     JOIN contacts ct ON ct.id = m.contact_id
     WHERE m.direction = 'inbound'
     ORDER BY m.id DESC LIMIT 100`,
  ).all()
  return c.json({ inbound: rows.results })
})

apiRoutes.get('/drops', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT d.id, d.company_id AS companyId, c.name AS companyName,
            d.reason, d.status, d.created_at AS createdAt
     FROM drop_requests d JOIN companies c ON c.id = d.company_id
     WHERE d.status = 'pending' ORDER BY d.id`,
  ).all()
  return c.json({ drops: rows.results })
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
