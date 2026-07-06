# Deploy — and the migration-order rule

## How this deploys

The Worker is connected to GitHub via Cloudflare's Git integration. **Every
push to the production branch auto-deploys the code.** There is no separate
"push to prod" step — merging/pushing *is* the deploy.

## The one rule: migrations before code

The Cloudflare build **does not apply D1 migrations**. So if you add a
migration and push, the new *code* goes live immediately while the *database*
stays behind — and any screen that reads a new column errors. (This is exactly
what happened once: `companies.rev` shipped in code before the migration was
applied, and the Leads list started 500ing.)

**Always apply migrations to the remote DB before (or with) the deploy.**

### The safe deploy command

```bash
npm run deploy      # = wrangler d1 migrations apply maranasi-engine --remote && wrangler deploy
```

- Run it locally (with Cloudflare credentials), **or**
- set the Cloudflare Workers Build **deploy command** to `npm run deploy` so the
  Git build applies migrations first.

Apply migrations alone with `npm run migrate:remote`.

### If you don't have wrangler credentials

Apply the pending migration files' SQL directly against the remote D1 (Cloudflare
dashboard → D1 → console, or an authenticated D1 API/MCP call), then record each
in the ledger so nothing double-applies:

```sql
-- after running the migration's statements:
INSERT INTO d1_migrations (name) VALUES ('000X_your_migration.sql');
```

## Guards that now catch drift

1. **CI:** `npm run check` runs `check:migrations`, which fails if
   `src/config/migrations.ts` (`LATEST_MIGRATION`) doesn't match the newest file
   in `migrations/`. You can't add a migration and forget to declare it.
2. **Runtime:** `schemaState()` compares the applied ledger to `LATEST_MIGRATION`.
   - `GET /health` returns `"schema": "pending"` when the DB is behind (good for
     uptime monitors).
   - The dashboard status strip shows a **"Database update pending"** alert
     (`schema_pending`) so an owner sees it immediately.

## Adding a migration (checklist)

1. Write `migrations/000X_*.sql`.
2. Bump `LATEST_MIGRATION` in `src/config/migrations.ts` to the new filename.
3. `npm run check` (green — includes `check:migrations`).
4. Deploy with `npm run deploy` **or** apply the migration to remote D1 first,
   then push.
5. Confirm `GET /health` shows `"schema": "ok"`.
