-- Idempotent send lifecycle. The send path now claims a message
-- (approved -> sending) before calling the provider, then resolves it
-- (sending -> sent | failed | needs_review). SQLite cannot ALTER a CHECK
-- constraint, so rebuild email_messages with the expanded status set and two
-- bookkeeping columns. Nothing in the schema references email_messages, so
-- the drop/rename is safe.

CREATE TABLE email_messages_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  enrollment_id INTEGER REFERENCES sequence_enrollments(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  direction TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound', 'inbound')),
  step INTEGER,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'approved', 'sending', 'queued', 'sent', 'failed',
    'needs_review', 'bounced', 'cancelled', 'received'
  )),
  subject TEXT,
  body TEXT,
  to_email TEXT,
  from_user_id INTEGER REFERENCES users(id),
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  approved_at TEXT,
  approved_by TEXT,
  provider_message_id TEXT,
  bounced_at TEXT,
  triage TEXT,
  triage_language TEXT,
  send_claimed_at TEXT,
  send_failure_reason TEXT
);

INSERT INTO email_messages_new (
  id, enrollment_id, company_id, contact_id, direction, step, status,
  subject, body, to_email, from_user_id, is_demo, created_at, sent_at,
  approved_at, approved_by, provider_message_id, bounced_at, triage, triage_language
)
SELECT
  id, enrollment_id, company_id, contact_id, direction, step, status,
  subject, body, to_email, from_user_id, is_demo, created_at, sent_at,
  approved_at, approved_by, provider_message_id, bounced_at, triage, triage_language
FROM email_messages;

DROP TABLE email_messages;
ALTER TABLE email_messages_new RENAME TO email_messages;

CREATE INDEX idx_email_company ON email_messages (company_id);
CREATE INDEX idx_email_status ON email_messages (status);
CREATE INDEX idx_email_approved ON email_messages (status, approved_at);
CREATE INDEX idx_email_sent_window ON email_messages (status, sent_at);
