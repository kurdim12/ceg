import { logActivity } from '../domain/activities'
import type { Stage } from '../domain/stages'

interface DemoContact {
  name: string
  role: string
  email: string | null
  status: 'unverified' | 'valid' | 'invalid' | 'catch_all' | 'unknown'
}

interface DemoCompany {
  name: string
  domain: string
  city: string
  country: string
  timezone: string
  stage: Stage
  phone: string | null
  phoneFormatValid: boolean
  phoneConfirmed: boolean
  contacts: DemoContact[]
  dealUsdCents?: number
  dealStatus?: 'open' | 'won' | 'lost'
  hasMeeting?: boolean
}

/**
 * One company per pipeline stage, both assignees exercised, every email
 * verification outcome present, timezones spread across continents —
 * the owner walkthrough runs on exactly this data.
 */
const DEMO_COMPANIES: DemoCompany[] = [
  {
    name: 'DEMO Riverside Roasters', domain: 'demo-riverside.example', city: 'Nairobi',
    country: 'KE', timezone: 'Africa/Nairobi', stage: 'new', phone: '+254 20 555 0101',
    phoneFormatValid: true, phoneConfirmed: false,
    contacts: [{ name: 'Amina Odhiambo', role: 'Owner', email: 'amina@demo-riverside.example', status: 'unverified' }],
  },
  {
    name: 'DEMO Harbor Textiles', domain: 'demo-harbor.example', city: 'Sao Paulo',
    country: 'BR', timezone: 'America/Sao_Paulo', stage: 'email_sequence', phone: '+55 11 5550 0102',
    phoneFormatValid: true, phoneConfirmed: false,
    contacts: [
      { name: 'Beatriz Lima', role: 'Managing Director', email: 'beatriz@demo-harbor.example', status: 'valid' },
      { name: 'Rafael Souza', role: 'Procurement', email: 'rafael@demo-harbor.example', status: 'valid' },
    ],
  },
  {
    name: 'DEMO Vistula Logistics', domain: 'demo-vistula.example', city: 'Warsaw',
    country: 'PL', timezone: 'Europe/Warsaw', stage: 'replied', phone: '+48 22 555 0103',
    phoneFormatValid: true, phoneConfirmed: true,
    contacts: [{ name: 'Marek Kowalski', role: 'CEO', email: 'marek@demo-vistula.example', status: 'valid' }],
  },
  {
    name: 'DEMO Hudson Interiors', domain: 'demo-hudson.example', city: 'New York',
    country: 'US', timezone: 'America/New_York', stage: 'meeting_booked', phone: '+1 212 555 0104',
    phoneFormatValid: true, phoneConfirmed: true, hasMeeting: true,
    contacts: [{ name: 'Dana Weiss', role: 'Head of Ops', email: 'dana@demo-hudson.example', status: 'valid' }],
  },
  {
    name: 'DEMO Atlas Trading', domain: 'demo-atlas.example', city: 'Amman',
    country: 'JO', timezone: 'Asia/Amman', stage: 'deal', phone: '+962 6 555 0105',
    phoneFormatValid: true, phoneConfirmed: true, dealUsdCents: 450_000, dealStatus: 'open',
    contacts: [{ name: 'Omar Haddad', role: 'GM', email: 'omar@demo-atlas.example', status: 'valid' }],
  },
  {
    name: 'DEMO Sakura Imports', domain: 'demo-sakura.example', city: 'Osaka',
    country: 'JP', timezone: 'Asia/Tokyo', stage: 'won', phone: '+81 6 5555 0106',
    phoneFormatValid: true, phoneConfirmed: true, dealUsdCents: 1_200_000, dealStatus: 'won',
    contacts: [{ name: 'Yuki Mori', role: 'Buyer', email: 'yuki@demo-sakura.example', status: 'valid' }],
  },
  {
    name: 'DEMO Baltic Furniture', domain: 'demo-baltic.example', city: 'Gdansk',
    country: 'PL', timezone: 'Europe/Warsaw', stage: 'lost', phone: '+48 58 555 0107',
    phoneFormatValid: true, phoneConfirmed: true, dealUsdCents: 300_000, dealStatus: 'lost',
    contacts: [{ name: 'Ewa Nowak', role: 'Owner', email: 'ewa@demo-baltic.example', status: 'valid' }],
  },
  {
    name: 'DEMO Mekong Crafts', domain: 'demo-mekong.example', city: 'Auckland',
    country: 'NZ', timezone: 'Pacific/Auckland', stage: 'unresponsive_email', phone: '+64 9 555 0108',
    phoneFormatValid: true, phoneConfirmed: false,
    contacts: [{ name: 'Sophie Ngata', role: 'Director', email: 'sophie@demo-mekong.example', status: 'catch_all' }],
  },
  {
    name: 'DEMO Andes Coffee Co', domain: 'demo-andes.example', city: 'Bogota',
    country: 'CO', timezone: 'America/Bogota', stage: 'no_valid_email', phone: '+57 1 555 0109',
    phoneFormatValid: true, phoneConfirmed: false,
    contacts: [
      { name: 'Camila Rojas', role: 'Founder', email: 'camila@demo-andes.example', status: 'invalid' },
      { name: 'Front desk', role: 'Reception', email: null, status: 'unverified' },
    ],
  },
  {
    name: 'DEMO Outback Supplies', domain: 'demo-outback.example', city: 'Perth',
    country: 'AU', timezone: 'Australia/Perth', stage: 'dropped', phone: '+61 8 5550 0110',
    phoneFormatValid: false, phoneConfirmed: false,
    contacts: [{ name: 'Jack Miller', role: 'Manager', email: 'jack@demo-outback.example', status: 'unknown' }],
  },
]

/** Deletes previous demo rows and re-inserts the full set. Idempotent. */
export async function resetDemoData(
  db: D1Database,
  assigneeIds: readonly [number, number],
  actor: string,
): Promise<{ companies: number; contacts: number }> {
  // FK-safe order; activities are append-only and stay.
  await db.batch([
    db.prepare('DELETE FROM meetings WHERE is_demo = 1'),
    db.prepare('DELETE FROM deals WHERE is_demo = 1'),
    db.prepare('DELETE FROM contacts WHERE is_demo = 1'),
    db.prepare('DELETE FROM companies WHERE is_demo = 1'),
  ])

  let contactCount = 0
  for (let i = 0; i < DEMO_COMPANIES.length; i++) {
    const spec = DEMO_COMPANIES[i]!
    const assignee = assigneeIds[i % 2]!
    const companyRow = await db
      .prepare(
        `INSERT INTO companies
           (name, domain, website, city, country, timezone, phone,
            phone_format_valid, phone_confirmed, source, assignee_id, stage, is_demo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, 1)
         RETURNING id`,
      )
      .bind(
        spec.name, spec.domain, `https://${spec.domain}`, spec.city, spec.country,
        spec.timezone, spec.phone, spec.phoneFormatValid ? 1 : 0,
        spec.phoneConfirmed ? 1 : 0, assignee, spec.stage,
      )
      .first<{ id: number }>()
    const companyId = companyRow!.id

    let firstContactId: number | null = null
    for (const contact of spec.contacts) {
      const contactRow = await db
        .prepare(
          `INSERT INTO contacts (company_id, name, role, email, email_status, is_demo)
           VALUES (?, ?, ?, ?, ?, 1) RETURNING id`,
        )
        .bind(companyId, contact.name, contact.role, contact.email, contact.status)
        .first<{ id: number }>()
      firstContactId ??= contactRow!.id
      contactCount++
    }

    if (spec.dealStatus) {
      await db
        .prepare(
          `INSERT INTO deals (company_id, status, amount_usd_cents, is_demo)
           VALUES (?, ?, ?, 1)`,
        )
        .bind(companyId, spec.dealStatus, spec.dealUsdCents ?? null)
        .run()
    }
    if (spec.hasMeeting && firstContactId !== null) {
      await db
        .prepare(
          `INSERT INTO meetings (company_id, contact_id, scheduled_at, source, is_demo)
           VALUES (?, ?, datetime('now', '+3 days'), 'booking_link', 1)`,
        )
        .bind(companyId, firstContactId)
        .run()
    }
  }

  await logActivity(db, {
    entityType: 'system',
    actor,
    kind: 'demo_reset',
    detail: { companies: DEMO_COMPANIES.length, contacts: contactCount },
  })
  return { companies: DEMO_COMPANIES.length, contacts: contactCount }
}
