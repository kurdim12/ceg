-- Phase 2 walking skeleton: sequence enrollments and email messages.

CREATE TABLE sequence_enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
    'active', 'paused', 'replied', 'exhausted', 'stopped'
  )),
  current_step INTEGER NOT NULL DEFAULT 0,
  next_action_at TEXT,
  paused_until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_enroll_due ON sequence_enrollments (status, next_action_at);
-- One active enrollment per contact, structurally.
CREATE UNIQUE INDEX idx_enroll_one_active_per_contact
  ON sequence_enrollments (contact_id) WHERE status = 'active';

CREATE TABLE email_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  enrollment_id INTEGER REFERENCES sequence_enrollments(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  direction TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound', 'inbound')),
  step INTEGER,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'approved', 'queued', 'sent', 'bounced', 'cancelled', 'received'
  )),
  subject TEXT,
  body TEXT,
  to_email TEXT,
  from_user_id INTEGER REFERENCES users(id),
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);
CREATE INDEX idx_email_company ON email_messages (company_id);
CREATE INDEX idx_email_status ON email_messages (status);
