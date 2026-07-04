/**
 * Reference A — config defaults (map §11, verbatim values). All
 * owner-adjustable in settings; the agent reads these, never writes them.
 * "No cap" is not a configurable state — validation rejects it.
 */
export interface Settings {
  /** Send cap / inbox / day: 15, weekly ramp */
  sendCapPerInboxPerDay: number
  weeklyRampEnabled: boolean
  /** Operational ramp size; owner-adjustable like everything else. */
  weeklyRampIncrement: number
  /** Sequence steps / spacing: 3 steps · 72h */
  sequenceSteps: number
  sequenceSpacingHours: number
  /** Send window: 09:00–16:30 lead-local, weekdays */
  sendWindowStartLocal: string
  sendWindowEndLocal: string
  sendWeekdaysOnly: boolean
  /** Sourcing volume: 25/day */
  sourcingVolumePerDay: number
  /** Sourcing cron: 02:00 Amman (UTC+3, no DST) = 23:00 UTC · dispatcher hourly */
  sourcingUtcHour: number
  /** Daily sourcing targets — owner-set, nothing geographic is baked in.
      Blank = daily sourcing pauses (audited skip); manual runs always work. */
  sourcingGeo: string
  sourcingBusinessType: string
  /** Daily recap generation hour (UTC); default 05:00 UTC = 08:00 Amman. */
  recapUtcHour: number
  /** Bounce breaker: warn 2% · stop 3% · floor 25 sends */
  bounceWarnPct: number
  bounceStopPct: number
  bounceFloorSends: number
  /** Re-verify staleness: >60 days */
  reverifyStalenessDays: number
  /** OOO pause: 7 days */
  oooPauseDays: number
  /** Contact stagger / company: 3–4 days */
  contactStaggerMinDays: number
  contactStaggerMaxDays: number
  /** Phone gate: 3 attempts / 2 weeks */
  phoneGateAttempts: number
  phoneGateWindowDays: number
  /** Lost re-approach / drop recycle: 6 months / 12 months */
  lostReapproachMonths: number
  dropRecycleMonths: number
  /** Currency: USD (single stored currency) */
  currency: 'USD'
}

export const DEFAULT_SETTINGS: Settings = {
  sendCapPerInboxPerDay: 15,
  weeklyRampEnabled: true,
  weeklyRampIncrement: 5,
  sequenceSteps: 3,
  sequenceSpacingHours: 72,
  sendWindowStartLocal: '09:00',
  sendWindowEndLocal: '16:30',
  sendWeekdaysOnly: true,
  sourcingVolumePerDay: 25,
  sourcingUtcHour: 23,
  sourcingGeo: '',
  sourcingBusinessType: '',
  recapUtcHour: 5,
  bounceWarnPct: 2,
  bounceStopPct: 3,
  bounceFloorSends: 25,
  reverifyStalenessDays: 60,
  oooPauseDays: 7,
  contactStaggerMinDays: 3,
  contactStaggerMaxDays: 4,
  phoneGateAttempts: 3,
  phoneGateWindowDays: 14,
  lostReapproachMonths: 6,
  dropRecycleMonths: 12,
  currency: 'USD',
}

export class SettingsValidationError extends Error {}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

function requirePositiveInt(value: unknown, field: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw new SettingsValidationError(`${field} must be an integer between 1 and ${max}`)
  }
  return value
}

/**
 * Validates a full settings object. The send cap is the load-bearing rule:
 * zero, blank, negative, non-numeric, or absurdly large ("effectively
 * unlimited") values are all rejected — there is no way to configure
 * uncapped sending.
 */
export function validateSettings(input: Record<string, unknown>): Settings {
  const s = { ...DEFAULT_SETTINGS, ...input } as Record<string, unknown>

  const out: Settings = {
    sendCapPerInboxPerDay: requirePositiveInt(s.sendCapPerInboxPerDay, 'sendCapPerInboxPerDay', 200),
    weeklyRampEnabled: Boolean(s.weeklyRampEnabled),
    weeklyRampIncrement: requirePositiveInt(s.weeklyRampIncrement, 'weeklyRampIncrement', 50),
    sequenceSteps: requirePositiveInt(s.sequenceSteps, 'sequenceSteps', 10),
    sequenceSpacingHours: requirePositiveInt(s.sequenceSpacingHours, 'sequenceSpacingHours', 24 * 30),
    sendWindowStartLocal: String(s.sendWindowStartLocal),
    sendWindowEndLocal: String(s.sendWindowEndLocal),
    sendWeekdaysOnly: Boolean(s.sendWeekdaysOnly),
    sourcingVolumePerDay: requirePositiveInt(s.sourcingVolumePerDay, 'sourcingVolumePerDay', 500),
    sourcingUtcHour: (() => {
      const v = s.sourcingUtcHour
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 23) {
        throw new SettingsValidationError('sourcingUtcHour must be an integer between 0 and 23')
      }
      return v
    })(),
    sourcingGeo: (() => {
      const v = s.sourcingGeo
      if (typeof v !== 'string' || v.length > 120) {
        throw new SettingsValidationError('sourcingGeo must be a string of at most 120 chars')
      }
      return v.trim()
    })(),
    sourcingBusinessType: (() => {
      const v = s.sourcingBusinessType
      if (typeof v !== 'string' || v.length > 120) {
        throw new SettingsValidationError('sourcingBusinessType must be a string of at most 120 chars')
      }
      return v.trim()
    })(),
    recapUtcHour: (() => {
      const v = s.recapUtcHour
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 23) {
        throw new SettingsValidationError('recapUtcHour must be an integer between 0 and 23')
      }
      return v
    })(),
    bounceWarnPct: requirePositiveInt(s.bounceWarnPct, 'bounceWarnPct', 100),
    bounceStopPct: requirePositiveInt(s.bounceStopPct, 'bounceStopPct', 100),
    bounceFloorSends: requirePositiveInt(s.bounceFloorSends, 'bounceFloorSends', 10_000),
    reverifyStalenessDays: requirePositiveInt(s.reverifyStalenessDays, 'reverifyStalenessDays', 3650),
    oooPauseDays: requirePositiveInt(s.oooPauseDays, 'oooPauseDays', 365),
    contactStaggerMinDays: requirePositiveInt(s.contactStaggerMinDays, 'contactStaggerMinDays', 365),
    contactStaggerMaxDays: requirePositiveInt(s.contactStaggerMaxDays, 'contactStaggerMaxDays', 365),
    phoneGateAttempts: requirePositiveInt(s.phoneGateAttempts, 'phoneGateAttempts', 100),
    phoneGateWindowDays: requirePositiveInt(s.phoneGateWindowDays, 'phoneGateWindowDays', 365),
    lostReapproachMonths: requirePositiveInt(s.lostReapproachMonths, 'lostReapproachMonths', 120),
    dropRecycleMonths: requirePositiveInt(s.dropRecycleMonths, 'dropRecycleMonths', 120),
    currency: 'USD',
  }

  if (!TIME_RE.test(out.sendWindowStartLocal) || !TIME_RE.test(out.sendWindowEndLocal)) {
    throw new SettingsValidationError('send window times must be HH:MM')
  }
  if (out.sendWindowStartLocal >= out.sendWindowEndLocal) {
    throw new SettingsValidationError('send window must start before it ends')
  }
  if (out.bounceWarnPct >= out.bounceStopPct) {
    throw new SettingsValidationError('bounce warn threshold must be below the stop threshold')
  }
  if (out.contactStaggerMinDays > out.contactStaggerMaxDays) {
    throw new SettingsValidationError('contact stagger min must not exceed max')
  }
  if (s.currency !== undefined && s.currency !== 'USD') {
    throw new SettingsValidationError('USD is the single stored currency')
  }
  return out
}
