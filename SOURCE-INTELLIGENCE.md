# Source Intelligence — Lead Candidate Review

This is the human-review buffer between machine sourcing and the CRM. It changes
the platform from:

```
scraper → CRM company → email sequence
```

to:

```
source → candidate → evidence → human approval → CRM lead
```

Nothing sourced by a machine enters the CRM — or gets anywhere near the send
engine — until a person reviews the evidence and approves it.

## Why sourcing no longer writes directly to `companies`

Before this change, a daily sourcing run (`runSourcing` → `ingestBusiness`)
inserted each found business straight into `companies`, crawled its site,
verified an email, and **auto-enrolled it into an email sequence**. The only
thing standing between a crawled, unreviewed business and a real cold email was
`DRY_RUN=true`. That is not safe for a production outreach product: flip one
flag and machine-sourced leads start emailing.

Now sourcing produces **candidates** only. A candidate is inert:

- it is not a company,
- it has no contacts, no sequence enrollment, and no draft,
- it can never trigger an email, in any DRY_RUN state.

A human approves a candidate to create a CRM lead. Approval lands the lead at
stage `new` and **does not enroll it** into a sequence — enrolling and sending
remain separate, human/settings-driven steps behind all the existing safety
walls (pause → bounce breaker → suppression → verify-before-send → send window →
per-inbox cap → DRY_RUN → connected inbox).

## The candidate review flow

1. **Source** — `runSourcing` calls `ingestBusiness` for each business. It
   reuses the existing site crawl and domain logic, but writes a
   `lead_candidates` row instead of a company. Nothing is verified or emailed.
2. **Review** — candidates appear on the **Candidates** page (`/api/candidates`),
   sorted by confidence, showing name, location, website/domain, extracted
   email/phone, source URL, an evidence snippet, and the confidence score.
3. **Approve** (`POST /api/candidates/:id/approve`) — the only bridge to the
   CRM. It re-runs the company dedup (`findDuplicateCompany`):
   - **no match** → creates a company via the same safe `createCompany` path
     used for manual entry (stage `new`, timezone resolved from city/country),
     carries the crawled email over as one **unverified** contact, and marks the
     candidate `approved` with `company_id` set.
   - **match** → marks the candidate `duplicate`, links the existing
     `company_id`, and creates **no** second company.
4. **Reject** (`POST /api/candidates/:id/reject`) — terminal, with an audited
   reason.

`new` is the only actionable state. `approved`, `rejected`, `duplicate`, and
`failed` are terminal — a candidate in any of those can never be approved again
(enforced by an atomic claim on the `new` row, so a double-click can't create
two companies).

## Evidence / provenance model

Every candidate stores where it came from and why we trust its fields:

- `source_type` — `places | crawl | manual | import`
- `source_url` — the listing/site the record came from
- `evidence_json` — a provenance blob, e.g. the page an email was found on
  (`emailSource`), the emails found (`emailsFound`), the crawl note when none
  were found, the street address, and the **scoring breakdown**.
- `confidence` — a deterministic 0–100 score (see below).

### Confidence scoring (deterministic + explainable)

`scoreCandidate` is a pure function — same inputs always produce the same score,
and every point is attributed to a named reason kept in the evidence. No model,
no randomness.

| Signal | Points |
|--------|--------|
| Contact email found | +40 |
| Has a website | +20 |
| Has a phone number | +15 |
| Name + city present | +15 |
| Resolvable registrable domain | +10 |

Maximum 100. A reviewer can always see exactly why a candidate scored what it
did.

## Approval safety guarantee

Enforced and covered by tests (`test/candidates.test.ts`,
`test/skeleton.test.ts`):

- Sourcing creates candidates, never companies, contacts, enrollments, or
  emails.
- Approval creates a company **only** on explicit human action.
- Approval **never** enrolls a lead into a sequence or drafts/sends an email.
- A duplicate candidate links the existing company and creates no second one.
- A rejected candidate can never be approved.
- An approved candidate can never be approved twice (no duplicate company).
- Candidate routes require auth; invalid payloads return 400, not 500.
- Every decision (created / approved / rejected / duplicate / failed) is audited
  in the activity trail; approve/reject/duplicate/failed show in the Settings
  audit feed.

`DRY_RUN` stays `true`. This change does not send email — it removes the only
path by which unreviewed, machine-sourced businesses could ever be emailed.

## Data model (`migrations/0008_lead_candidates.sql`)

`lead_candidates`: `id, source_type, source_url, name, domain, website, city,
country, phone, extracted_email, evidence_json, confidence, status, reviewed_by,
reviewed_at, company_id, rejection_reason, is_demo, created_at, updated_at`.
Indexes on `(status, confidence)`, `domain`, and `company_id`.

## What remains future work

- **Enrichment/verification of approved leads** — approval attaches the crawled
  email as *unverified*; verify-before-send still gates any future send, but a
  dedicated post-approval enrichment/verification step is not built yet.
- **Candidate → sequence hand-off UI** — moving an approved lead into a sequence
  is still manual; there is no one-click "approve and enroll" (by design, for
  now).
- **Source-quality benchmarking** — confidence is per-candidate; there is no
  per-source scorecard (approval rate, duplicate rate) yet.
- **Bulk approve/reject** and **duplicate merge** — out of scope here; the review
  screen is one-at-a-time.
- **Manual/import candidate entry UI** — the `manual` and `import` source types
  and the `POST` create path exist in the model, but there is no dedicated UI to
  hand-enter a candidate yet.
