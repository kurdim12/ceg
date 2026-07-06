import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { resetDemoData } from '../src/demo/seed'
import { STAGES } from '../src/domain/stages'
import { createOwners, countRows } from './helpers'

describe('demo-data system', () => {
  it('covers every stage, both assignees, and every verification outcome', async () => {
    const [a, b] = await createOwners()
    const result = await resetDemoData(env.DB, [a, b], 'test')
    expect(result.companies).toBe(10)

    for (const stage of STAGES) {
      expect(
        await countRows('companies', `is_demo = 1 AND stage = '${stage}'`),
        `stage ${stage} must be represented`,
      ).toBeGreaterThan(0)
    }
    expect(await countRows('companies', `is_demo = 1 AND assignee_id = ${a}`)).toBeGreaterThan(0)
    expect(await countRows('companies', `is_demo = 1 AND assignee_id = ${b}`)).toBeGreaterThan(0)

    for (const status of ['unverified', 'valid', 'invalid', 'catch_all', 'unknown']) {
      expect(
        await countRows('contacts', `is_demo = 1 AND email_status = '${status}'`),
        `email status ${status} must be represented`,
      ).toBeGreaterThan(0)
    }
    expect(await countRows('meetings', 'is_demo = 1')).toBeGreaterThan(0)
    expect(await countRows('deals', 'is_demo = 1')).toBeGreaterThan(0)
  })

  it('is regenerable: a second reset does not duplicate', async () => {
    const [a, b] = await createOwners()
    await resetDemoData(env.DB, [a, b], 'test')
    await resetDemoData(env.DB, [a, b], 'test')
    expect(await countRows('companies', 'is_demo = 1')).toBe(10)
    // The audit trail keeps both resets — append-only.
    expect(await countRows('activities', "kind = 'demo_reset'")).toBe(2)
  })
})

describe('demo reset clears dependent rows (regression)', () => {
  it('resets cleanly even after a demo lead has a call, email, enrollment, and drop', async () => {
    const [a, b] = await createOwners()
    await resetDemoData(env.DB, [a, b], 'test')
    const co = await env.DB.prepare('SELECT id FROM companies WHERE is_demo = 1 LIMIT 1').first<{ id: number }>()
    const ct = await env.DB.prepare('SELECT id FROM contacts WHERE company_id = ? LIMIT 1').bind(co!.id).first<{ id: number }>()
    // Accumulate exactly the rows that used to trip the foreign key.
    await env.DB.prepare("INSERT INTO call_attempts (company_id, contact_id, by_user_id, outcome) VALUES (?, ?, ?, 'no-answer')").bind(co!.id, ct!.id, a).run()
    await env.DB.prepare("INSERT INTO email_messages (company_id, contact_id, direction, status, to_email) VALUES (?, ?, 'outbound', 'draft', 'x@y.z')").bind(co!.id, ct!.id).run()
    await env.DB.prepare("INSERT INTO sequence_enrollments (company_id, contact_id, status) VALUES (?, ?, 'active')").bind(co!.id, ct!.id).run()
    await env.DB.prepare("INSERT INTO drop_requests (company_id, prepared_by) VALUES (?, 'test')").bind(co!.id).run()

    // Previously threw a FOREIGN KEY constraint failure.
    const result = await resetDemoData(env.DB, [a, b], 'test')
    expect(result.companies).toBe(10)
    expect(await countRows('call_attempts')).toBe(0)
    expect(await countRows('sequence_enrollments')).toBe(0)
    expect(await countRows('companies', 'is_demo = 1')).toBe(10)
  })
})
