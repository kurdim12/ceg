-- Phase 1 foundation: companies ← contacts, deals, meetings, suppression,
-- append-only activities, users. Born-native — no legacy shapes.

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner_admin' CHECK (role IN ('owner_admin')),
  password_hash TEXT NOT NULL,
  booking_link TEXT,
  gmail_connected INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  domain TEXT UNIQUE,
  website TEXT,
  city TEXT,
  country TEXT,
  timezone TEXT,
  phone TEXT,
  phone_format_valid INTEGER NOT NULL DEFAULT 0,
  phone_confirmed INTEGER NOT NULL DEFAULT 0,
  address TEXT,
  business_type TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'places')),
  assignee_id INTEGER REFERENCES users(id),
  stage TEXT NOT NULL DEFAULT 'new' CHECK (stage IN (
    'new', 'email_sequence', 'replied', 'meeting_booked', 'deal', 'won', 'lost',
    'unresponsive_email', 'no_valid_email', 'dropped'
  )),
  stage_version INTEGER NOT NULL DEFAULT 0,
  stage_changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_companies_stage ON companies (stage);
CREATE INDEX idx_companies_assignee ON companies (assignee_id);

CREATE TABLE contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT,
  role TEXT,
  email TEXT,
  email_status TEXT NOT NULL DEFAULT 'unverified' CHECK (email_status IN (
    'unverified', 'valid', 'invalid', 'catch_all', 'unknown'
  )),
  email_verified_at TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_contacts_company ON contacts (company_id);
CREATE INDEX idx_contacts_email ON contacts (email);

CREATE TABLE deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost')),
  -- USD is the single stored currency (map §3); integer cents, no float money.
  amount_usd_cents INTEGER,
  notes TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_deals_company ON deals (company_id);

CREATE TABLE meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  scheduled_at TEXT,
  source TEXT NOT NULL DEFAULT 'booking_link' CHECK (source IN ('booking_link', 'manual')),
  notes TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_meetings_company ON meetings (company_id);

-- Add-only by design: rows are immutable (trigger below); the only removal
-- path in code is the human settings route, which audits. The agent tool
-- layer has no suppression-remove capability at all.
CREATE TABLE suppression (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL CHECK (reason IN ('stop_request', 'hard_bounce', 'manual')),
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER suppression_no_update
BEFORE UPDATE ON suppression
BEGIN
  SELECT RAISE(ABORT, 'suppression rows are immutable');
END;

-- Append-only audit trail. UPDATE and DELETE are unrepresentable: the
-- triggers make the guarantee structural, not conventional.
CREATE TABLE activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type IN (
    'company', 'contact', 'deal', 'meeting', 'user', 'suppression', 'settings', 'system'
  )),
  entity_id INTEGER,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_activities_entity ON activities (entity_type, entity_id);

CREATE TRIGGER activities_no_update
BEFORE UPDATE ON activities
BEGIN
  SELECT RAISE(ABORT, 'activities are append-only');
END;

CREATE TRIGGER activities_no_delete
BEFORE DELETE ON activities
BEGIN
  SELECT RAISE(ABORT, 'activities are append-only');
END;
