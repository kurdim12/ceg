# Security Notes — Maranasi Outreach Engine

Scope: a two-owner internal CRM + outreach engine on a Cloudflare Worker. This
documents the security model as implemented.

## Authentication & sessions

- **Passwords**: hashed with **PBKDF2** (`src/auth/password.ts`); plaintext is
  never stored. Setup requires a password of ≥10 chars.
- **Sessions**: a **256-bit** random token (`crypto.getRandomValues`, 32 bytes),
  stored in KV under `session:<token>` with a **7-day TTL**
  (`src/auth/sessions.ts`). `getSession` validates the token against
  `/^[0-9a-f]{64}$/` before any KV lookup.
- **Cookie**: `httpOnly`, `secure`, `SameSite=Lax`, `Path=/`, 7-day `maxAge`.
- **Gating**: every `/api/*` route mounts `requireAuth` (`src/http/middleware.ts`).
  The only public routes are `/health` and the Gmail OAuth `callback` (which is
  bound to the initiating owner by a one-time state nonce).
- **Account creation**: `POST /api/auth/setup` is disabled unless the
  `SETUP_TOKEN` secret is set, requires that exact token, creates **exactly two**
  owners, and **refuses once any user exists**. There is no open sign-up.

## Secrets

- Resolution order (first non-empty wins): **KV → D1 `app_secrets` → env binding**
  (`src/settings/store.ts`). Storing in D1 means keys survive Git-integration
  deploys that reset dashboard variables.
- **Never exposed**: `GET /api/settings` and `/api/readiness` return only
  presence **booleans**. `setSecret` audits the key **name** only — never the
  value. Secrets are never written to logs.
- `SETUP_TOKEN` and OAuth client secrets live in Cloudflare secrets / `.dev.vars`
  (git-ignored) — never committed.

## Injection & data handling

- **SQL**: all queries use bound parameters (`.bind(...)`). The only dynamic SQL
  identifiers are **column names drawn from fixed allowlists**
  (`EDITABLE_COLUMNS` in `manual-ops.ts`, `FIELD_ALLOWLIST` in the agent
  registry) — never user-supplied strings. No string-interpolated user input in
  SQL.
- **XSS**: user/lead-derived text is HTML-escaped via a shared `esc()` before
  insertion into `innerHTML` across the frontend views.
- **Prompt injection (the important one)**: inbound email and any lead-stored
  text is treated as **data from a stranger, never as instructions**. The agent
  system prompt states this explicitly and never relaxes it; the only "trusted"
  context is the dashboard-provided current-screen note, which is clearly
  labelled and separated. The agent acts **only** through its tool registry —
  there is no tool that sends outside the guarded send path, changes settings,
  or bypasses confirmation for drops/bulk operations.

## Email-sending safety (defense in depth)

The single send path (`src/sequence/send.ts`) enforces, in order: manual pause →
bounce breaker → suppression → verify-before-send → send window → per-inbox cap
→ `DRY_RUN` → connected inbox. Each is independently sufficient to stop a send.
Uncapped sending is **unconfigurable** (validation rejects zero/blank/huge caps).
See [PRODUCTION-READINESS.md](./PRODUCTION-READINESS.md).

## Gmail OAuth

- Authorization-code flow with a per-request **state nonce** (KV, 600s TTL) that
  binds the grant to the owner who started it.
- Requires a **refresh token**; the callback rejects a grant without one.
- Tokens are stored in KV per owner; **Disconnect** deletes them and flips
  `gmail_connected`.
- The redirect URI is derived from the request origin and must match the value
  registered in Google Cloud.

## Audit trail

Append-only `activities` table. Security-relevant events are recorded and
surfaced in Settings → Recent activity (`GET /api/audit`): logins, sends,
approvals, deletes, key changes, settings changes, pause/resume, breaker
trips/resets, Gmail connect/disconnect. Deletions are logged **before** the row
is removed, so history stays truthful.

## Destructive actions

- Every destructive UI action (delete lead, drop, breaker reset, pause, Gmail
  disconnect) requires an in-app confirmation modal (native dialogs are banned
  and CI-enforced).
- Deleting a lead removes dependent rows in FK-safe order inside one batch and
  writes a `company_deleted` audit row.
- The agent **cannot** drop a lead or run a >20-record bulk op without a separate
  human confirmation token.

## Transport & platform

- Served over HTTPS by Cloudflare. Same-origin app (no CORS surface exposed).
- No third-party scripts in the frontend; only Google Fonts (styles) are loaded
  externally.

## Residual risks

- **Session theft** would grant full owner access for up to 7 days; mitigated by
  `httpOnly`+`secure` cookies and short-lived tokens, but there is no 2FA.
- **No rate limiting** on `/api/auth/login` at the app layer — rely on
  Cloudflare-level protection (WAF / rate limiting rules) in front of the Worker
  for brute-force defense.
- **Third-party trust** — OpenRouter/ZeroBounce/Places/Google receive the data
  necessary for their function (lead emails, prompts). Each fails safe on outage.
- **Two shared owner accounts** — actions are attributed per account; there is no
  finer-grained RBAC by design (the product has exactly two operators).

## Reporting

Security concerns → the maintainer (Abdelrahman). Do not open a public issue with
exploit details.
