import type { Settings } from '../config/defaults'
import { evaluateBounceRate } from '../sequence/breaker'
import { evaluateAlerts, type Alert } from './alerts'

export interface AssigneeSection {
  assigneeId: number
  assigneeName: string
  callQueue: Array<{ companyId: number; name: string; city: string | null; stage: string }>
}

export interface DailyRecap {
  date: string
  newLeadsSourced: number
  emailsSent: number
  repliesInterested: number
  repliesNotInterested: number
  meetingsBooked: number
  bounce: { level: string; ratePct?: number; sends: number }
  perAssignee: AssigneeSection[]
  alarms: Alert[]
}

const CALL_STAGES = ['no_valid_email', 'unresponsive_email'] as const

/**
 * The daily business recap (map §10): new leads sourced · emails sent ·
 * replies (interested/not) · meetings booked · today's call queue per
 * assignee · bounce rate · alarms. Goes to both owners + maintainer copy.
 */
export async function buildDailyRecap(
  db: D1Database,
  kv: KVNamespace,
  settings: Settings,
  now: Date,
): Promise<DailyRecap> {
  const since = new Date(now.getTime() - 24 * 3600 * 1000).toISOString()

  const count = async (sql: string, ...binds: unknown[]) =>
    (await db.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0

  const newLeadsSourced = await count(
    `SELECT COUNT(*) AS n FROM companies WHERE created_at >= ? AND is_demo = 0`,
    since,
  )
  const emailsSent = await count(
    `SELECT COUNT(*) AS n FROM email_messages WHERE status = 'sent' AND sent_at >= ?`,
    since,
  )
  const repliesInterested = await count(
    `SELECT COUNT(*) AS n FROM email_messages
     WHERE direction = 'inbound' AND created_at >= ? AND triage IN ('reply', 'other')`,
    since,
  )
  const repliesNotInterested = await count(
    `SELECT COUNT(*) AS n FROM email_messages
     WHERE direction = 'inbound' AND created_at >= ? AND triage IN ('not_interested', 'stop')`,
    since,
  )
  const meetingsBooked = await count(
    `SELECT COUNT(*) AS n FROM meetings WHERE created_at >= ? AND is_demo = 0`,
    since,
  )

  const owners = await db
    .prepare(`SELECT id, name FROM users WHERE role = 'owner_admin' ORDER BY id`)
    .all<{ id: number; name: string }>()
  const perAssignee: AssigneeSection[] = []
  for (const owner of owners.results) {
    const queue = await db
      .prepare(
        `SELECT id AS companyId, name, city, stage FROM companies
         WHERE assignee_id = ? AND stage IN (${CALL_STAGES.map(() => '?').join(',')})
         ORDER BY stage_changed_at LIMIT 25`,
      )
      .bind(owner.id, ...CALL_STAGES)
      .all<{ companyId: number; name: string; city: string | null; stage: string }>()
    perAssignee.push({
      assigneeId: owner.id,
      assigneeName: owner.name,
      callQueue: queue.results,
    })
  }

  const bounceVerdict = await evaluateBounceRate(db, settings, now)
  const alarms = await evaluateAlerts(db, kv, settings, now)

  return {
    date: now.toISOString().slice(0, 10),
    newLeadsSourced,
    emailsSent,
    repliesInterested,
    repliesNotInterested,
    meetingsBooked,
    bounce: {
      level: bounceVerdict.level,
      ratePct: 'ratePct' in bounceVerdict ? Number(bounceVerdict.ratePct.toFixed(2)) : undefined,
      sends: bounceVerdict.sends,
    },
    perAssignee,
    alarms,
  }
}
