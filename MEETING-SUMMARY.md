# Maranasi Outreach Engine — Stabilization Summary

_Prepared 2026-07-06 · branch `claude/maranasi-outreach-system-map-jz0625`_

A pre-meeting stabilization pass: audit first, then fix functionality, then
UI, then verify. The system is a safe B2B outreach engine + CRM on Cloudflare
Workers (Hono + TypeScript strict; D1 · KV · R2; vanilla ES-module frontend,
no build step).

---

## ✅ What works now

**Core CRM**
- **Login / auth** — cookie + KV session, PBKDF2 password hashing, every API
  route gated. Bad credentials and expired sessions handled with clear copy.
- **Leads** — dense list (Twenty-style) + Kanban board with drag-to-restage.
  Search, per-stage filter, inline stage change, delete (with confirm).
- **Add lead** _(new)_ — manual create via a modal: name required, everything
  else optional, assignee picker, duplicate-domain guard. Opens the new record.
- **Edit lead** _(new)_ — the record drawer's Details tab is now editable
  (pencil toggle): name, business type, phone, city, country, website,
  timezone, assignee. Saves via `PATCH`, reflected locally without a reload.
- **Record drawer** — Details / Contacts / Emails / Activity tabs, stage
  dropdown, "Open in call screen", delete.
- **Call queue** — one-screen-per-lead call view: log outcome, book meeting,
  prepare drop (gated: 3 failed attempts spread over 2 weeks, owner confirms).
- **Review drafts** — first-20 review mode; approve drafts before anything sends.
- **Inbox** — inbound replies, auto-classified (reply / OOO / not-interested /
  stop / bounce).
- **Assistant** — full-power agent that reads and acts through a tool registry
  (never executes instructions hidden inside inbound email).
- **Daily recap** — the real metrics dashboard: funnel, 14-day sends, reply mix,
  per-assignee call queues, alarms.
- **Deals** — open / won / lost board with amounts and time-in-stage.
- **Settings** — sending rules, bounce-breaker state, API keys, **Gmail
  connection status** _(new)_, booking link, demo-data reset.

**Design**
- Rebuilt on Twenty CRM's real theme tokens; **dark theme by default** with a
  one-click light toggle (persisted). Consistent spacing, typography (Inter),
  buttons, tags, drawers.

**Quality gates** — `npm run check` is green: TypeScript strict, **110 tests**,
dialog guard (no native dialogs), geo guard (no hardcoded geography).

---

## ⏳ Still pending (not blocking the demo)

- Add-contact and per-lead notes from the UI (the assistant can already do both).
- Bulk actions in the list UI (assistant supports bulk stage moves with a
  >20-record confirmation).
- Real inbound email ingestion needs Gmail connected (below); until then the
  Inbox shows demo/seeded replies.

---

## 🛡️ What is safe because of DRY_RUN

`DRY_RUN = "true"` in `wrangler.toml`. **No real email can leave the system.**
- The send path holds every approved message while DRY_RUN is on (proven by tests).
- Independently, sending is also gated by: per-inbox daily caps, permanent
  suppression, the bounce breaker (warn ≥2% / stop ≥3%), first-20 review mode,
  and lead-local send windows.
- Sourcing, verification, and the assistant "hold" safely when their key is
  unset — they never fabricate results.
- Deleting a lead is the only destructive UI action and always requires an
  explicit in-app confirm.

---

## 🔑 What needs keys / human action before going live

| Action | Where | Effect |
|---|---|---|
| Set `OPENROUTER_API_KEY` | Settings → Connections & keys | Assistant + reply/triage drafting go live |
| Set `GOOGLE_PLACES_API_KEY` | Settings → Connections & keys | "Find new leads" sourcing goes live |
| Set `ZEROBOUNCE_API_KEY` | Settings | Email verification goes live |
| Set `GMAIL_CLIENT_ID` + `GMAIL_CLIENT_SECRET` | Settings | Enables "Connect my Gmail" |
| Each owner connects Gmail | Settings → Connect my Gmail | Sequences can send from their inbox |
| Set owners' real Gmail addresses | (one-time) | Correct from/reply identity |
| **Flip `DRY_RUN` → false** | `wrangler.toml`, after the Flip Gate | Turns on real sending |

Keys are stored in the durable D1-backed secret store, so they survive every
Git-integration deploy. Everything holds fail-safe until each key is set.

---

## 🎯 Suggested next sprint

1. **Go-live checklist** — set the two universal keys (OpenRouter, Places),
   owners connect Gmail, confirm the Flip Gate, then flip `DRY_RUN` off.
2. **UI parity for the assistant's powers** — add-contact, notes, and bulk
   actions as first-class buttons in the list/drawer.
3. **Inbox depth** — thread view + one-click "draft reply" from a message.
4. **Onboarding polish** — empty-state guidance for a fresh (non-demo) account.

---

## Audit note

The pre-work audit found the backend structurally sound — the entire check
pipeline was already green and every wired button had a matching, validated,
auth-gated endpoint. The real gaps were three **missing** CRM flows (create
lead, edit lead, Gmail status) plus one minor event-listener leak, all now
closed. No backend logic was removed and no schema change was required.
