-- Source Intelligence: the human-review buffer between machine sourcing and the CRM.
--
-- Before this table, sourcing wrote businesses straight into `companies` and
-- auto-enrolled them into email sequences — the only thing between a crawled
-- business and a real cold email was DRY_RUN. Now the crawler produces
-- *candidates* here, with source provenance + evidence + a deterministic
-- confidence score, and a human must approve one before it becomes a CRM lead.
-- Nothing in this table can ever trigger an email.
--
-- Lifecycle: new → approved (became a company) | rejected | duplicate (matched
-- an existing company) | failed (approval hit an error). Only `new` is
-- actionable; the four others are terminal and can never be approved again.
CREATE TABLE lead_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL CHECK (source_type IN ('places', 'crawl', 'manual', 'import')),
  source_url TEXT,
  name TEXT NOT NULL,
  domain TEXT,
  website TEXT,
  city TEXT,
  country TEXT,
  phone TEXT,
  extracted_email TEXT,
  -- Provenance: where the fields came from and what matched (JSON). Never a lead instruction.
  evidence_json TEXT NOT NULL DEFAULT '{}',
  -- Deterministic 0-100 (see scoreCandidate); explainable, no model.
  confidence INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'approved', 'rejected', 'duplicate', 'failed')),
  reviewed_by TEXT,
  reviewed_at TEXT,
  -- Set when approved (the new company) or duplicate (the existing match).
  company_id INTEGER REFERENCES companies(id),
  rejection_reason TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_candidates_status ON lead_candidates (status, confidence);
CREATE INDEX idx_candidates_domain ON lead_candidates (domain);
CREATE INDEX idx_candidates_company ON lead_candidates (company_id);
