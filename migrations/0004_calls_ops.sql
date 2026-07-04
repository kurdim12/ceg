-- Phase 5: the phone side of the funnel. Outcomes are the five buttons
-- on the call screen, nothing else (map §8).

CREATE TABLE call_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  contact_id INTEGER REFERENCES contacts(id),
  by_user_id INTEGER NOT NULL REFERENCES users(id),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'answered-interested', 'answered-not-interested', 'no-answer',
    'wrong-number', 'callback-later'
  )),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_calls_company ON call_attempts (company_id, created_at);
