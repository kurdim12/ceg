import { logActivity } from '../domain/activities'
import { isStage, type Stage } from '../domain/stages'
import { readStage, transitionStage } from '../domain/transitions'
import { deleteCompany, setStageManual } from '../domain/manual-ops'
import { getBreaker } from '../sequence/breaker'
import { getPauseState } from '../ops/pause'
import { getSettings } from '../settings/store'
import { draftReply } from '../inbox/draft-reply'
import type { LlmAdapter } from '../adapters/types'

/**
 * The agent's capability surface. The owner chose "no limits" (2026-07),
 * so the agent CAN edit fields, move stages freely, run bulk ops, queue
 * emails for sending, and delete leads. The one guard that remains is NOT
 * a limit on the owner — it protects the owner from strangers: inbound
 * email is classified as data, never executed as instructions (see
 * inbox/triage + the agent loop's injection handling). Sending still flows
 * through the send path's business invariants (suppression, caps, breaker,
 * DRY_RUN) because those protect the owner's sender reputation, not the
 * agent's manners.
 */
export const BULK_CONFIRM_LIMIT = 20

const FIELD_ALLOWLIST = ['name', 'city', 'country', 'timezone', 'phone', 'business_type'] as const

export interface AgentContext {
  db: D1Database
  kv: KVNamespace
  llm: LlmAdapter | null
  /** Owner on whose screen the agent runs; drop/bulk confirmations bind to them. */
  userId: number
}

type ToolResult = Record<string, unknown>

export interface AgentTool {
  name: string
  description: string
  execute(ctx: AgentContext, args: Record<string, unknown>): Promise<ToolResult>
}

function num(args: Record<string, unknown>, key: string): number {
  const v = args[key]
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error(`${key} must be an integer`)
  return v
}

function str(args: Record<string, unknown>, key: string, maxLen = 500): string {
  const v = args[key]
  if (typeof v !== 'string' || v.trim() === '' || v.length > maxLen) {
    throw new Error(`${key} must be a non-empty string (max ${maxLen})`)
  }
  return v.trim()
}

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: 'search_leads',
    description: 'Search companies by stage and/or name text. Args: stage?, text?, limit? (max 50).',
    async execute(ctx, args) {
      const limit = Math.min(typeof args.limit === 'number' ? args.limit : 20, 50)
      const stage = typeof args.stage === 'string' && isStage(args.stage) ? args.stage : null
      const text = typeof args.text === 'string' ? `%${args.text}%` : null
      const rows = await ctx.db
        .prepare(
          `SELECT id, name, city, stage, assignee_id AS assigneeId FROM companies
           WHERE (? IS NULL OR stage = ?) AND (? IS NULL OR name LIKE ?)
           ORDER BY updated_at DESC LIMIT ?`,
        )
        .bind(stage, stage, text, text, limit)
        .all()
      return { leads: rows.results }
    },
  },
  {
    name: 'get_lead',
    description: 'Full detail for one company: fields, contacts, recent activity. Args: companyId.',
    async execute(ctx, args) {
      const id = num(args, 'companyId')
      const company = await ctx.db.prepare('SELECT * FROM companies WHERE id = ?').bind(id).first()
      if (!company) return { error: 'no such company — this field is empty, do not guess' }
      const contacts = await ctx.db
        .prepare('SELECT id, name, role, email, email_status FROM contacts WHERE company_id = ?')
        .bind(id)
        .all()
      const activities = await ctx.db
        .prepare(
          `SELECT actor, kind, detail, created_at FROM activities
           WHERE entity_type = 'company' AND entity_id = ? ORDER BY id DESC LIMIT 20`,
        )
        .bind(id)
        .all()
      return { company, contacts: contacts.results, recentActivity: activities.results }
    },
  },
  {
    name: 'update_lead_field',
    description: `Update ONE allowed company field (${FIELD_ALLOWLIST.join(', ')}). Args: companyId, field, value.`,
    async execute(ctx, args) {
      const id = num(args, 'companyId')
      const field = str(args, 'field', 40)
      if (!(FIELD_ALLOWLIST as readonly string[]).includes(field)) {
        throw new Error(`field must be one of: ${FIELD_ALLOWLIST.join(', ')}`)
      }
      const value = str(args, 'value')
      await ctx.db
        .prepare(`UPDATE companies SET ${field} = ?, rev = rev + 1, updated_at = datetime('now') WHERE id = ?`)
        .bind(value, id)
        .run()
      await logActivity(ctx.db, {
        entityType: 'company', entityId: id, actor: 'agent',
        kind: 'field_edit', detail: { field, value },
      })
      return { ok: true }
    },
  },
  {
    name: 'move_stage',
    description: 'Move a company to a legal next stage (CAS-safe, audited). Args: companyId, to.',
    async execute(ctx, args) {
      const id = num(args, 'companyId')
      const to = str(args, 'to', 40)
      if (!isStage(to)) throw new Error('unknown stage')
      if (to === 'dropped') {
        throw new Error('drop is gated: use prepare_drop — an owner must confirm every drop')
      }
      const state = await readStage(ctx.db, id)
      if (!state) throw new Error('no such company')
      await transitionStage(ctx.db, {
        companyId: id, from: state.stage, to: to as Stage,
        expectedVersion: state.version, actor: 'agent',
      })
      return { ok: true, from: state.stage, to }
    },
  },
  {
    name: 'set_stage',
    description: 'Set a company to ANY stage directly (manual override, CAS-safe, audited). Args: companyId, to.',
    async execute(ctx, args) {
      const id = num(args, 'companyId')
      const to = str(args, 'to', 40)
      const state = await readStage(ctx.db, id)
      if (!state) throw new Error('no such company')
      const result = await setStageManual(ctx.db, {
        companyId: id, to, expectedVersion: state.version, actor: 'agent',
      })
      return { ok: true, ...result }
    },
  },
  {
    name: 'send_email',
    description:
      'Queue an email to a contact through the SAFE send pipeline (verification, suppression, caps, window, breaker, pause, DRY_RUN all apply). A suppressed contact is refused; an unverified/blocked contact is held as a draft for owner review — never sent directly. Args: companyId, contactId, subject, body.',
    async execute(ctx, args) {
      const companyId = num(args, 'companyId')
      const contactId = num(args, 'contactId')
      const subject = str(args, 'subject', 300)
      const body = str(args, 'body', 20_000)
      const company = await ctx.db
        .prepare('SELECT assignee_id AS assigneeId FROM companies WHERE id = ?')
        .bind(companyId)
        .first<{ assigneeId: number | null }>()
      const contact = await ctx.db
        .prepare('SELECT email, email_status AS emailStatus FROM contacts WHERE id = ? AND company_id = ?')
        .bind(contactId, companyId)
        .first<{ email: string | null; emailStatus: string }>()
      if (!company || !contact?.email) throw new Error('company or contact email not found')
      const email = contact.email.toLowerCase()

      // Suppressed → hard refuse. Never queue, never draft.
      const suppressed = await ctx.db.prepare('SELECT 1 FROM suppression WHERE email = ?').bind(email).first()
      if (suppressed) {
        await logActivity(ctx.db, {
          entityType: 'contact', entityId: contactId, actor: 'agent',
          kind: 'agent_send_blocked', detail: { reason: 'suppressed', email },
        })
        return { blocked: true, reason: 'That address is on the suppression list — nothing was sent or drafted.' }
      }

      // Determine whether it is safe to queue for real sending. Anything short
      // of a verified contact with sending armed is HELD as a draft for review.
      const [breaker, pause] = await Promise.all([getBreaker(ctx.kv), getPauseState(ctx.kv)])
      let holdReason: string | null = null
      if (contact.emailStatus !== 'valid') holdReason = `the contact's email is "${contact.emailStatus}", not verified valid`
      else if (pause.paused) holdReason = 'sending is paused (emergency stop)'
      else if (breaker.tripped) holdReason = 'the bounce breaker is tripped'

      if (holdReason) {
        const row = await ctx.db
          .prepare(
            `INSERT INTO email_messages
               (company_id, contact_id, direction, status, subject, body, to_email, from_user_id)
             VALUES (?, ?, 'outbound', 'draft', ?, ?, ?, ?) RETURNING id`,
          )
          .bind(companyId, contactId, subject, body, contact.email, company.assigneeId)
          .first<{ id: number }>()
        await logActivity(ctx.db, {
          entityType: 'contact', entityId: contactId, actor: 'agent',
          kind: 'agent_send_held', detail: { messageId: row!.id, reason: holdReason },
        })
        return {
          held: true, draftId: row!.id,
          reason: `Held as a draft for owner review because ${holdReason}. Nothing was sent.`,
        }
      }

      // Verified + armed → create an approved message. It still passes every
      // send-path wall (suppression re-check, window, cap, breaker, DRY_RUN).
      const row = await ctx.db
        .prepare(
          `INSERT INTO email_messages
             (company_id, contact_id, direction, status, subject, body, to_email, from_user_id, approved_at, approved_by)
           VALUES (?, ?, 'outbound', 'approved', ?, ?, ?, ?, datetime('now'), 'agent') RETURNING id`,
        )
        .bind(companyId, contactId, subject, body, contact.email, company.assigneeId)
        .first<{ id: number }>()
      await logActivity(ctx.db, {
        entityType: 'contact', entityId: contactId, actor: 'agent',
        kind: 'agent_send_queued', detail: { messageId: row!.id },
      })
      return {
        ok: true, messageId: row!.id,
        note: 'Queued. Verification passed; caps, window, breaker, pause and DRY_RUN still apply before it sends.',
      }
    },
  },
  {
    name: 'delete_lead',
    description: 'Permanently delete a company and all its data. No undo. Args: companyId.',
    async execute(ctx, args) {
      const id = num(args, 'companyId')
      const result = await deleteCompany(ctx.db, id, 'agent')
      if (!result.deleted) throw new Error('no such company')
      return { ok: true, deleted: result.name }
    },
  },
  {
    name: 'bulk_move_stage',
    description: `Move many companies to a stage. More than ${BULK_CONFIRM_LIMIT} requires owner confirmation (returns a preview + token). Args: companyIds[], to.`,
    async execute(ctx, args) {
      const ids = Array.isArray(args.companyIds)
        ? args.companyIds.filter((v): v is number => Number.isInteger(v))
        : []
      if (ids.length === 0) throw new Error('companyIds must be a non-empty integer array')
      const to = str(args, 'to', 40)
      if (!isStage(to) || to === 'dropped') throw new Error('unknown or gated stage')

      if (ids.length > BULK_CONFIRM_LIMIT) {
        const token = crypto.randomUUID()
        await ctx.kv.put(
          `agent:bulk:${token}`,
          JSON.stringify({ companyIds: ids, to, requestedBy: ctx.userId }),
          { expirationTtl: 900 },
        )
        await logActivity(ctx.db, {
          entityType: 'system', actor: 'agent', kind: 'bulk_preview',
          detail: { count: ids.length, to, token },
        })
        return {
          requiresConfirmation: true,
          preview: { count: ids.length, to, sample: ids.slice(0, 10) },
          confirmToken: token,
          note: 'No records were changed. An owner must confirm this bulk operation.',
        }
      }

      const results: Array<{ companyId: number; ok: boolean; error?: string }> = []
      for (const id of ids) {
        try {
          const state = await readStage(ctx.db, id)
          if (!state) throw new Error('no such company')
          await transitionStage(ctx.db, {
            companyId: id, from: state.stage, to: to as Stage,
            expectedVersion: state.version, actor: 'agent',
          })
          results.push({ companyId: id, ok: true })
        } catch (err) {
          results.push({ companyId: id, ok: false, error: (err as Error).message })
        }
      }
      return { results }
    },
  },
  {
    name: 'add_contact',
    description: 'Add a contact to a company. Args: companyId, name?, role?, email?.',
    async execute(ctx, args) {
      const id = num(args, 'companyId')
      const row = await ctx.db
        .prepare(
          `INSERT INTO contacts (company_id, name, role, email) VALUES (?, ?, ?, ?) RETURNING id`,
        )
        .bind(
          id,
          typeof args.name === 'string' ? args.name.slice(0, 200) : null,
          typeof args.role === 'string' ? args.role.slice(0, 200) : null,
          typeof args.email === 'string' ? args.email.toLowerCase().slice(0, 320) : null,
        )
        .first<{ id: number }>()
      await logActivity(ctx.db, {
        entityType: 'contact', entityId: row!.id, actor: 'agent',
        kind: 'contact_added', detail: { companyId: id },
      })
      return { ok: true, contactId: row!.id }
    },
  },
  {
    name: 'log_note',
    description: 'Append a note to a company timeline. Args: companyId, text.',
    async execute(ctx, args) {
      const id = num(args, 'companyId')
      const text = str(args, 'text', 2000)
      await logActivity(ctx.db, {
        entityType: 'company', entityId: id, actor: 'agent', kind: 'note', detail: { text },
      })
      return { ok: true }
    },
  },
  {
    name: 'draft_reply',
    description: 'Draft a reply to the latest inbound email of a company for owner approval. Args: companyId.',
    async execute(ctx, args) {
      const id = num(args, 'companyId')
      const inbound = await ctx.db
        .prepare(
          `SELECT contact_id AS contactId, subject, body, from_user_id AS ownerId,
                  (SELECT email FROM contacts WHERE id = contact_id) AS email
           FROM email_messages WHERE company_id = ? AND direction = 'inbound'
           ORDER BY id DESC LIMIT 1`,
        )
        .bind(id)
        .first<{ contactId: number; subject: string; body: string; ownerId: number | null; email: string }>()
      if (!inbound) return { error: 'no inbound message on this company — nothing to reply to' }
      const draftId = await draftReply(ctx.db, ctx.llm, {
        companyId: id,
        contactId: inbound.contactId,
        inboundSubject: inbound.subject,
        inboundBody: inbound.body,
        toEmail: inbound.email,
        ownerUserId: inbound.ownerId ?? ctx.userId,
      })
      return draftId
        ? { ok: true, draftId, note: 'Draft created; an owner approves before anything sends.' }
        : { held: true, reason: 'LLM key unset — reply drafting is holding' }
    },
  },
  {
    name: 'add_suppression',
    description: 'Add an email to the suppression list (add-only; removal is a human in settings). Args: email.',
    async execute(ctx, args) {
      const email = str(args, 'email', 320).toLowerCase()
      await ctx.db
        .prepare(
          `INSERT OR IGNORE INTO suppression (email, reason, added_by) VALUES (?, 'manual', 'agent')`,
        )
        .bind(email)
        .run()
      await logActivity(ctx.db, {
        entityType: 'suppression', actor: 'agent', kind: 'suppression_added',
        detail: { reason: 'manual' },
      })
      return { ok: true }
    },
  },
  {
    name: 'prepare_drop',
    description: 'Prepare a drop request for owner confirmation — the agent NEVER drops a lead itself. Args: companyId, reason.',
    async execute(ctx, args) {
      const id = num(args, 'companyId')
      const reason = str(args, 'reason', 500)
      const row = await ctx.db
        .prepare(
          `INSERT INTO drop_requests (company_id, prepared_by, reason) VALUES (?, 'agent', ?) RETURNING id`,
        )
        .bind(id, reason)
        .first<{ id: number }>()
      await logActivity(ctx.db, {
        entityType: 'company', entityId: id, actor: 'agent',
        kind: 'drop_prepared', detail: { dropRequestId: row!.id, reason },
      })
      return {
        ok: true,
        dropRequestId: row!.id,
        note: 'Pending owner confirmation. No stage was changed.',
      }
    },
  },
  {
    name: 'get_settings',
    description: 'Read-only snapshot of configuration. The agent cannot change any of it.',
    async execute(ctx) {
      const settings = await getSettings(ctx.kv)
      return { settings, note: 'read-only — changes happen in Settings by a human' }
    },
  },
]

export function getTool(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((t) => t.name === name)
}

/** Executes an owner-confirmed bulk operation prepared by the agent. */
export async function confirmBulk(
  db: D1Database,
  kv: KVNamespace,
  token: string,
  ownerActor: string,
): Promise<{ ok: boolean; moved?: number; error?: string }> {
  const raw = await kv.get(`agent:bulk:${token}`)
  if (!raw) return { ok: false, error: 'confirmation expired or unknown' }
  await kv.delete(`agent:bulk:${token}`)
  const op = JSON.parse(raw) as { companyIds: number[]; to: Stage }
  let moved = 0
  for (const id of op.companyIds) {
    try {
      const state = await readStage(db, id)
      if (!state) continue
      await transitionStage(db, {
        companyId: id, from: state.stage, to: op.to,
        expectedVersion: state.version, actor: ownerActor, detail: { via: 'bulk_confirm' },
      })
      moved++
    } catch {
      // illegal/conflicting rows are skipped; the tally reports what moved
    }
  }
  await logActivity(db, {
    entityType: 'system', actor: ownerActor, kind: 'bulk_confirmed',
    detail: { requested: op.companyIds.length, moved, to: op.to },
  })
  return { ok: true, moved }
}
