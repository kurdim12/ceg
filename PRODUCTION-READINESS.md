# Production Readiness — Maranasi Outreach Engine

_Status: technically production-ready. Real email sending is disabled
(`DRY_RUN="true"`) until a human completes the [Go-Live Checklist](./GO-LIVE-CHECKLIST.md)._

## What this is

A universal-geography B2B outreach engine + CRM for the two Maranasi owners.
Cloudflare Worker (Hono, TypeScript strict) with D1 (SQLite), KV, and R2. The
frontend is vanilla ES-module JavaScript served from `public/` — no build step,
no framework, no bundler.

## Quality gates (all green)

```
npm run check   # typecheck + tests + dialog guard + geo guard
```

- **TypeScript strict** — `tsc --noEmit` clean.
- **120 tests** (vitest + `@cloudflare/vitest-pool-workers`) covering auth,
  the send path, caps, suppression, bounce breaker, review mode, sourcing,
  inbox triage, the agent tool registry, lead CRUD, the emergency pause, the
  test-email flow, readiness, and the audit feed.
- **Dialog guard** — no native `alert/confirm/prompt`; all confirmations are
  in-app modals.
- **Geo guard** — no hardcoded geography; sourcing targets are owner-configured.

## Safety model — why nothing sends by accident

`processApprovedSends` in `src/sequence/send.ts` is the **only** code path that
sends an email. Every message must clear all of these walls in order, each one
independently sufficient to stop the send:

1. **Manual pause** — the emergency stop (`ops/pause.ts`). A human halted all
   sending; nothing goes out until a human resumes.
2. **Bounce breaker** — trips automatically at ≥3% bounces (warn ≥2%, floor 25
   sends, trailing 7 days). Human-only reset.
3. **Suppression** — checked at send time; a stop/unsubscribe that arrives after
   approval still wins.
4. **Verify-before-send** — a sequence email only goes to a contact whose email
   verified `valid`.
5. **Send window** — lead-local business hours, weekdays only.
6. **Per-inbox daily cap** — 15/day default, weekly ramp; validation makes an
   uncapped state unconfigurable.
7. **DRY_RUN** — while on, approved messages are held, never simulated, never
   sent.
8. **Connected inbox** — no connected Gmail for the owner → hold, audited.

Independently, **first-20 review mode** holds the first 20 personalized emails
for human approval before any auto-approval begins.

## Fail-safe by design

Every external dependency **holds** when its key is missing rather than
faking a result:

| Subsystem | Key | Missing → |
|---|---|---|
| Email verification | `ZEROBOUNCE_API_KEY` | verification holds; unverified never sends |
| Assistant / triage / drafting | `OPENROUTER_API_KEY` | assistant + drafting hold |
| Lead sourcing | `GOOGLE_PLACES_API_KEY` | sourcing holds (manual + cron) |
| Gmail send/read | `GMAIL_CLIENT_ID` + `GMAIL_CLIENT_SECRET` + owner connect | sending holds |

Keys resolve **KV → D1 (`app_secrets`) → env binding**, so keys stored in the
database survive every Git-integration deploy (a dashboard-variable reset never
touches D1).

## Go-live controls (in the app: Settings)

- **Go-live readiness (Flip Gate)** — live checklist of every precondition for
  turning sending on; `GET /api/readiness`.
- **Emergency pause** — one click halts all sending; a global "Sending paused"
  pill shows on every screen.
- **Test email** — sends exactly one message to your own address, never a lead;
  reports the target and sends nothing while DRY_RUN is on.
- **Recent activity** — audit feed of sends, approvals, deletes, key/setting
  changes, pause/resume, breaker events.

## Security posture

See [SECURITY-NOTES.md](./SECURITY-NOTES.md). In brief: PBKDF2 password hashing,
128-bit random session tokens in KV with a 7-day TTL, `httpOnly`+`secure`+
`SameSite=Lax` cookies, every `/api` route behind `requireAuth`, all SQL
parameterized (dynamic columns come from fixed allowlists only), secrets never
echoed or logged, and inbound email treated strictly as data — never as agent
instructions.

## Known human-gated items (by design, not gaps)

- `DRY_RUN` stays `true` until a human flips it in `wrangler.toml`.
- D1 migrations are applied by a human (`wrangler d1 migrations apply … --remote`),
  not automatically on deploy.
- API keys and each owner's Gmail connection are set by a human in Settings.

## Remaining risks

See the "Risks still present" section of [GO-LIVE-CHECKLIST.md](./GO-LIVE-CHECKLIST.md).
