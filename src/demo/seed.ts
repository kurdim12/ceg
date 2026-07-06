import { logActivity } from '../domain/activities'
import { scoreCandidate, type CandidateSourceType } from '../domain/candidates'
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

interface DemoCandidate {
  sourceType: CandidateSourceType
  name: string
  domain: string | null
  website: string | null
  city: string
  country: string
  phone: string | null
  extractedEmail: string | null
  sourceUrl: string | null
  evidence: Record<string, unknown>
}

/**
 * Source-Intelligence review queue for the walkthrough: a few sourced
 * candidates a human would approve or reject. One deliberately reuses an
 * existing demo domain so "Approve" demonstrates the duplicate guard.
 */
const DEMO_CANDIDATES: DemoCandidate[] = [
  {
    sourceType: 'places', name: 'DEMO Cedar & Co Bakery', domain: 'demo-cedar.example',
    website: 'https://demo-cedar.example', city: 'Lisbon', country: 'PT',
    phone: '+351 21 555 0140', extractedEmail: 'hello@demo-cedar.example',
    sourceUrl: 'https://demo-cedar.example',
    evidence: { emailSource: 'https://demo-cedar.example', emailsFound: ['hello@demo-cedar.example'] },
  },
  {
    sourceType: 'places', name: 'DEMO Northwind Tools', domain: 'demo-northwind.example',
    website: 'https://demo-northwind.example', city: 'Toronto', country: 'CA',
    phone: '+1 416 555 0141', extractedEmail: null,
    sourceUrl: 'https://demo-northwind.example',
    evidence: { crawl: 'no contact email found on the site' },
  },
  {
    sourceType: 'places', name: 'DEMO Riverside Roasters', domain: 'demo-riverside.example',
    website: 'https://demo-riverside.example', city: 'Nairobi', country: 'KE',
    phone: '+254 20 555 0142', extractedEmail: 'amina@demo-riverside.example',
    sourceUrl: 'https://demo-riverside.example',
    evidence: { emailSource: 'https://demo-riverside.example', emailsFound: ['amina@demo-riverside.example'], note: 'matches an existing lead — approval will flag duplicate' },
  },
  {
    sourceType: 'places', name: 'DEMO Plaza Florist', domain: null, website: null,
    city: 'Madrid', country: 'ES', phone: '+34 91 555 0143', extractedEmail: null,
    sourceUrl: null, evidence: { crawl: 'no website on the Places listing' },
  },
]

/** Deletes previous demo rows and re-inserts the full set. Idempotent. */
export async function resetDemoData(
  db: D1Database,
  assigneeIds: readonly [number, number],
  actor: string,
): Promise<{ companies: number; contacts: number; candidates: number }> {
  // FK-safe order: clear everything that references a demo company/contact
  // BEFORE the companies/contacts themselves. Rows accumulated while working
  // demo leads (calls, drafts, enrollments, drops) reference them, so
  // deleting parents first trips a foreign-key constraint. Activities are
  // append-only and stay.
  const demoCompanies = 'SELECT id FROM companies WHERE is_demo = 1'
  await db.batch([
    // Candidates may link a demo company_id — clear them before the companies.
    db.prepare('DELETE FROM lead_candidates WHERE is_demo = 1'),
    db.prepare(`DELETE FROM call_attempts WHERE company_id IN (${demoCompanies})`),
    db.prepare(`DELETE FROM drop_requests WHERE company_id IN (${demoCompanies})`),
    db.prepare(`DELETE FROM email_messages WHERE company_id IN (${demoCompanies})`),
    db.prepare(`DELETE FROM sequence_enrollments WHERE company_id IN (${demoCompanies})`),
    db.prepare(`DELETE FROM meetings WHERE company_id IN (${demoCompanies})`),
    db.prepare(`DELETE FROM deals WHERE company_id IN (${demoCompanies})`),
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

  for (const cand of DEMO_CANDIDATES) {
    const { confidence, reasons } = scoreCandidate(cand)
    await db
      .prepare(
        `INSERT INTO lead_candidates
           (source_type, source_url, name, domain, website, city, country, phone,
            extracted_email, evidence_json, confidence, status, is_demo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 1)`,
      )
      .bind(
        cand.sourceType, cand.sourceUrl, cand.name, cand.domain, cand.website,
        cand.city, cand.country, cand.phone, cand.extractedEmail,
        JSON.stringify({ ...cand.evidence, scoring: reasons }), confidence,
      )
      .run()
  }

  await logActivity(db, {
    entityType: 'system',
    actor,
    kind: 'demo_reset',
    detail: { companies: DEMO_COMPANIES.length, contacts: contactCount, candidates: DEMO_CANDIDATES.length },
  })
  return { companies: DEMO_COMPANIES.length, contacts: contactCount, candidates: DEMO_CANDIDATES.length }
}
