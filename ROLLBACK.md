# Rollback & Emergency Procedures

Ordered fastest-first. Prefer the in-app controls — they are instant and need
no deploy.

## 1. Stop sending RIGHT NOW (seconds, no deploy)

**Settings → Emergency controls → Pause all sending.**

- Halts every outbound email immediately — sequences and replies.
- A global **"Sending paused"** pill appears on every screen.
- Nothing is lost: leads and drafts wait. Resume with **Resume sending**.
- Backed by KV; the send path checks it first (`ops/pause.ts`, Wall 0).

API equivalent (authenticated owner session):

```bash
curl -X POST https://<domain>/api/sending/pause \
  -H 'Content-Type: application/json' -b "session=<token>" \
  -d '{"reason":"incident"}'
```

## 2. Disable sending globally (minutes, redeploy)

Return the whole system to fail-safe:

```toml
# wrangler.toml
[vars]
DRY_RUN = "true"
```

```bash
npx wrangler deploy
curl -s https://<domain>/health   # → "dryRun":true
```

All approved messages are held again; nothing sends.

## 3. Roll back the code (minutes)

Every deploy is a Worker version. Roll back to the previous good version:

```bash
# find recent deployments
npx wrangler deployments list

# roll back to a specific version id
npx wrangler rollback [<version-id>]
```

Or redeploy a known-good commit:

```bash
git checkout <good-commit>
npm run check && npx wrangler deploy
```

Static assets (`public/`) ship with the Worker, so a rollback also reverts the
frontend. No separate step.

## 4. A specific owner is sending badly

- Settings → **Disconnect** that owner's Gmail — their sequences hold until they
  reconnect. Other owner is unaffected.

## 5. Bounces spiking

- The **bounce breaker** trips automatically at ≥3% (trailing 7 days, floor 25)
  and stops sending on its own — no action needed to stop the bleed.
- Investigate the list/source, then Settings → **reset the breaker** (human-only).

## What you do NOT need to roll back

- **Data** — nothing is hard-deleted by automation. Every change is in the
  append-only activity trail (per-lead in the drawer; global in Settings →
  Recent activity). A wrong stage/edit is corrected forward, not by restore.
- **Keys** — stored in KV **and** D1; a deploy or rollback never loses them.

## Database recovery (rare)

D1 is the system of record. Use Cloudflare's D1 Time Travel to restore to a
point in time if data is ever corrupted:

```bash
npx wrangler d1 time-travel info maranasi-engine
npx wrangler d1 time-travel restore maranasi-engine --timestamp <iso8601>
```

Restoring rewinds all tables; only do this for genuine corruption, and pause
sending (step 1) first.

## After any incident

1. Confirm `dryRun`/pause state via `/health` and the topbar.
2. Read Settings → Recent activity for the sequence of events.
3. Write down the cause before resuming; the breaker/pause exist so you can take
   that time safely.
