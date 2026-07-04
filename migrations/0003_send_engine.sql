-- Phase 4: send engine (approval trail, provider ids, bounces, triage)
-- and the agent-prepared / owner-confirmed drop queue.

ALTER TABLE email_messages ADD COLUMN approved_at TEXT;
ALTER TABLE email_messages ADD COLUMN approved_by TEXT;
ALTER TABLE email_messages ADD COLUMN provider_message_id TEXT;
ALTER TABLE email_messages ADD COLUMN bounced_at TEXT;
ALTER TABLE email_messages ADD COLUMN triage TEXT;
ALTER TABLE email_messages ADD COLUMN triage_language TEXT;

CREATE INDEX idx_email_approved ON email_messages (status, approved_at);
CREATE INDEX idx_email_sent_window ON email_messages (status, sent_at);

CREATE TABLE drop_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  prepared_by TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by TEXT
);
CREATE INDEX idx_drop_requests_status ON drop_requests (status);
