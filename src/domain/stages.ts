export const STAGES = [
  'new',
  'email_sequence',
  'replied',
  'meeting_booked',
  'deal',
  'won',
  'lost',
  'unresponsive_email',
  'no_valid_email',
  'dropped',
] as const

export type Stage = (typeof STAGES)[number]

/**
 * Legal pipeline edges (map §2). Parking states never auto-drop: `dropped`
 * is reachable only from the phone-gate states, and only via the gated,
 * owner-confirmed drop action. `won` is terminal.
 */
const LEGAL: Record<Stage, readonly Stage[]> = {
  new: ['email_sequence', 'no_valid_email'],
  email_sequence: ['replied', 'unresponsive_email', 'no_valid_email'],
  replied: ['meeting_booked', 'lost'],
  meeting_booked: ['deal', 'lost'],
  deal: ['won', 'lost'],
  won: [],
  // Recyclers re-open parked/lost leads; late replies and phone wins move
  // parked leads forward without resurrecting the email sequence.
  lost: ['email_sequence', 'new'],
  unresponsive_email: ['replied', 'meeting_booked', 'dropped', 'email_sequence'],
  no_valid_email: ['replied', 'meeting_booked', 'dropped', 'email_sequence'],
  dropped: ['new'],
}

export function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value)
}

export function isLegalTransition(from: Stage, to: Stage): boolean {
  return LEGAL[from].includes(to)
}
