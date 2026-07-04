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
