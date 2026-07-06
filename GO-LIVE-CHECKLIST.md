# Go-Live Checklist — Maranasi Outreach Engine

Work top to bottom. Nothing here sends a real email until the very last step.
The in-app **Settings → Go-live readiness** panel mirrors most of these checks
live (`GET /api/readiness`).

## 0. Prerequisites (one-time)

- [ ] Cloudflare account with the Worker `maranasi-engine` and its bindings
      provisioned: D1 `maranasi-engine`, KV, R2 (see `wrangler.toml`).
- [ ] The two owner accounts exist (created once via the setup route, gated by
      the `SETUP_TOKEN` secret; the route refuses once any user exists).

## 1. Deploy the code

```bash
# from the repo root, on the branch you intend to ship
npm ci
npm run check                       # must be green

# apply migrations to the LIVE database (not automatic on deploy)
npx wrangler d1 migrations apply maranasi-engine --remote

# deploy the Worker
npx wrangler deploy
```

Verify:

```bash
curl -s https://<your-worker-domain>/health
# → {"ok":true,"product":"Maranasi Engine","dryRun":true}
```

`dryRun:true` confirms sending is still disabled. Good.

## 2. Set the API keys (Settings → Connections & keys)

Paste each key; it activates its subsystem immediately and is stored durably
(KV + D1), surviving future deploys.

- [ ] `OPENROUTER_API_KEY` — assistant, triage, drafting
- [ ] `ZEROBOUNCE_API_KEY` — verify-before-send
- [ ] `GOOGLE_PLACES_API_KEY` — lead sourcing _(optional to send; required to source)_
- [ ] `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` — Gmail OAuth client

Each row shows **live** once set.

## 3. Connect Gmail (each owner)

- [ ] In Google Cloud, register the OAuth redirect URI:
      `https://<your-worker-domain>/api/auth/gmail/callback`
- [ ] Owner A: Settings → **Connect my Gmail** → grant → row shows **connected**
- [ ] Owner B: same, signed in as Owner B
- [ ] Confirm each owner's `email` is their real sending address
      (`UPDATE users SET email = ? WHERE id = ?` if it needs correcting).

## 4. Configure sending & sourcing (Settings → Sending)

- [ ] Send cap per inbox per day (default 15 — adjustable, never removable)
- [ ] Send window (default 09:00–16:30 lead-local, weekdays)
- [ ] Daily sourcing: where / business type / how many _(optional)_
- [ ] Set each owner's booking link

## 5. Verify readiness (Settings → Go-live readiness)

- [ ] Every **required** gate reads **ready** (0 blockers):
      OpenRouter, ZeroBounce, Gmail client, both owners connected, not paused,
      breaker armed.
- [ ] Optional gates (Places, sourcing) as desired.

## 6. Prove delivery safely

- [ ] Settings → Emergency controls → **Send test email**.
      While `DRY_RUN` is on it reports the target address and sends nothing.
- [ ] _(Optional dry-run rehearsal)_ Let a lead reach an approved draft; confirm
      Review Drafts shows it and it stays held (nothing sends).

---

## 7. FLIP THE SWITCH — enable real sending

**Do this only after steps 1–6 are all checked.**

1. Edit `wrangler.toml`:
   ```toml
   [vars]
   DRY_RUN = "false"
   ```
2. Redeploy:
   ```bash
   npx wrangler deploy
   ```
3. Verify:
   ```bash
   curl -s https://<your-worker-domain>/health   # → "dryRun":false
   ```
4. Do a **real** single test: Settings → **Send test email** → check your inbox.
5. Watch the first hours: Daily recap, the bounce breaker, and Settings →
   Recent activity. The per-inbox cap and first-20 review mode keep volume low
   at the start.

To pause instantly at any point: Settings → **Pause all sending** (see
[ROLLBACK.md](./ROLLBACK.md)).

---

## Risks still present

- **Deliverability / reputation** — new sending domains warm up slowly. The cap,
  ramp, review mode, and breaker mitigate this but do not eliminate it.
- **Gmail API quotas / token expiry** — a revoked or expired token makes sending
  hold for that owner (audited); reconnect in Settings.
- **Third-party outages** (OpenRouter, ZeroBounce, Places, Google) — each fails
  safe (holds), but features pause until the provider recovers.
- **Migrations are manual** — forgetting step 1's migration apply on a schema
  change will surface as query errors; apply before deploy.
- **Single reviewer for the audit trail** — the app records everything, but
  someone has to read Recent activity / Daily recap to catch anomalies early.
