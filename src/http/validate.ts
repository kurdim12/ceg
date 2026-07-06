import { z } from 'zod'
import type { Context } from 'hono'

/**
 * Parse + validate a JSON request body. Returns a discriminated result and
 * NEVER throws: a malformed body yields a clean 400 instead of a 500. Error
 * messages are built from zod's field paths + generic messages only — the
 * submitted values (which may include secrets) are never echoed back.
 */
export async function parseBody<T extends z.ZodTypeAny>(
  c: Context,
  schema: T,
): Promise<{ ok: true; data: z.infer<T> } | { ok: false; error: string }> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return { ok: false, error: 'request body must be valid JSON' }
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) }
  return { ok: true, data: parsed.data }
}

/** First zod issue as "path: message" (or just the message) — no submitted values. */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  const message = issue?.message ?? 'invalid input'
  const path = issue?.path?.length ? issue.path.join('.') : ''
  return path ? `${path}: ${message}` : message
}

const optStr = (max: number) => z.string().max(max).nullable().optional()

/** Schemas for the write routes and agent tools we validate up front. */
export const S = {
  createCompany: z.object({
    name: z.string().trim().min(1, 'a company name is required').max(200),
    website: z.string().max(500).optional(),
    city: optStr(200),
    country: optStr(200),
    timezone: optStr(120),
    phone: optStr(100),
    businessType: optStr(200),
    assigneeId: z.number().int().positive().optional(),
  }),

  editCompany: z.object({
    name: z.string().trim().min(1, 'name cannot be empty').max(200).optional(),
    website: optStr(500),
    city: optStr(200),
    country: optStr(200),
    timezone: optStr(120),
    phone: optStr(100),
    businessType: optStr(200),
    assigneeId: z.number().int().positive().nullable().optional(),
    expectedRev: z.number().int().nonnegative().optional(),
  }),

  stageUpdate: z.object({ stage: z.string().min(1).max(40) }),

  rejectCandidate: z.object({ reason: z.string().max(500).optional() }),

  settingsPatch: z.record(z.string(), z.unknown()),

  secretPut: z.object({ value: z.string().min(1, 'value required').max(8000) }),

  agentChat: z.object({
    message: z.string().min(1).max(4000),
    history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string() })).optional(),
    context: z.unknown().optional(),
  }),

  // Agent tool argument schemas (validated inside the tools).
  agentSendEmail: z.object({
    companyId: z.number().int().positive(),
    contactId: z.number().int().positive(),
    subject: z.string().trim().min(1).max(300),
    body: z.string().trim().min(1).max(20_000),
  }),

  agentBulkMoveStage: z.object({
    companyIds: z.array(z.number().int().positive()).min(1),
    to: z.string().min(1).max(40),
  }),
}

/** Validate a plain object (e.g. agent tool args) and throw a clear error on failure. */
export function validateArgs<T extends z.ZodTypeAny>(schema: T, args: unknown): z.infer<T> {
  const parsed = schema.safeParse(args)
  if (!parsed.success) throw new Error(firstIssue(parsed.error))
  return parsed.data
}
