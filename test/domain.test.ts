import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import {
  IllegalTransitionError,
  TransitionConflictError,
  readStage,
  transitionStage,
} from '../src/domain/transitions'
import { isLegalTransition } from '../src/domain/stages'
import { createCompany, countRows } from './helpers'

describe('stage machine', () => {
  it('encodes the map §2 pipeline edges', () => {
    expect(isLegalTransition('new', 'email_sequence')).toBe(true)
    expect(isLegalTransition('email_sequence', 'replied')).toBe(true)
    expect(isLegalTransition('replied', 'meeting_booked')).toBe(true)
    expect(isLegalTransition('meeting_booked', 'deal')).toBe(true)
    expect(isLegalTransition('deal', 'won')).toBe(true)
    // Parking states never auto-drop; drop is only reachable from the phone-gate states.
    expect(isLegalTransition('email_sequence', 'dropped')).toBe(false)
    expect(isLegalTransition('new', 'dropped')).toBe(false)
    expect(isLegalTransition('unresponsive_email', 'dropped')).toBe(true)
    expect(isLegalTransition('no_valid_email', 'dropped')).toBe(true)
    // Terminal and nonsense edges.
    expect(isLegalTransition('won', 'lost')).toBe(false)
    expect(isLegalTransition('new', 'won')).toBe(false)
  })

  it('performs a CAS transition and writes exactly one audit row', async () => {
    const id = await createCompany({ stage: 'new' })
    await transitionStage(env.DB, {
      companyId: id,
      from: 'new',
      to: 'email_sequence',
      expectedVersion: 0,
      actor: 'test',
    })
    const state = await readStage(env.DB, id)
    expect(state).toEqual({ stage: 'email_sequence', version: 1 })
    expect(
      await countRows('activities', `entity_id = ${id} AND kind = 'stage_change'`),
    ).toBe(1)
  })

  it('rejects illegal transitions without touching the row', async () => {
    const id = await createCompany({ stage: 'new' })
    await expect(
      transitionStage(env.DB, {
        companyId: id,
        from: 'new',
        to: 'won',
        expectedVersion: 0,
        actor: 'test',
      }),
    ).rejects.toBeInstanceOf(IllegalTransitionError)
    expect(await readStage(env.DB, id)).toEqual({ stage: 'new', version: 0 })
    expect(await countRows('activities', `entity_id = ${id}`)).toBe(0)
  })

  it('a stale writer conflicts and leaves no false stage_change audit', async () => {
    const id = await createCompany({ stage: 'new' })
    await transitionStage(env.DB, {
      companyId: id,
      from: 'new',
      to: 'email_sequence',
      expectedVersion: 0,
      actor: 'writer-1',
    })
    // writer-2 read the same version-0 state and lost the race.
    await expect(
      transitionStage(env.DB, {
        companyId: id,
        from: 'new',
        to: 'no_valid_email',
        expectedVersion: 0,
        actor: 'writer-2',
      }),
    ).rejects.toBeInstanceOf(TransitionConflictError)

    expect(await readStage(env.DB, id)).toEqual({ stage: 'email_sequence', version: 1 })
    expect(
      await countRows('activities', `entity_id = ${id} AND kind = 'stage_change'`),
    ).toBe(1)
    expect(
      await countRows('activities', `entity_id = ${id} AND kind = 'stage_change_conflict'`),
    ).toBe(1)
  })
})

describe('append-only guarantees (structural, not conventional)', () => {
  it('rejects UPDATE on activities', async () => {
    const id = await createCompany()
    await transitionStage(env.DB, {
      companyId: id,
      from: 'new',
      to: 'email_sequence',
      expectedVersion: 0,
      actor: 'test',
    })
    await expect(
      env.DB.prepare("UPDATE activities SET kind = 'forged' WHERE entity_id = ?").bind(id).run(),
    ).rejects.toThrow(/append-only/)
  })

  it('rejects DELETE on activities', async () => {
    const id = await createCompany()
    await transitionStage(env.DB, {
      companyId: id,
      from: 'new',
      to: 'email_sequence',
      expectedVersion: 0,
      actor: 'test',
    })
    await expect(
      env.DB.prepare('DELETE FROM activities WHERE entity_id = ?').bind(id).run(),
    ).rejects.toThrow(/append-only/)
  })

  it('rejects UPDATE on suppression rows', async () => {
    await env.DB.prepare(
      "INSERT INTO suppression (email, reason, added_by) VALUES ('x@example.com', 'stop_request', 'test')",
    ).run()
    await expect(
      env.DB.prepare("UPDATE suppression SET email = 'y@example.com'").run(),
    ).rejects.toThrow(/immutable/)
  })

  it('rejects unknown stages at the schema layer', async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO companies (name, stage) VALUES ('Bad Stage Co', 'imaginary_stage')",
      ).run(),
    ).rejects.toThrow()
  })
})
