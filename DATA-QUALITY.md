# Data Quality — normalization, dedup, and validation

Three small permissive (MIT) libraries strengthen data quality behind thin,
replaceable adapters. They follow our house rule: **never throw in normal use,
return null / a clean error on bad input** — a bad value degrades to "no match"
or a 400, never a 500 or a fake result. No CRM, email, sequence, or safety
logic changed; DRY_RUN, suppression, caps, the bounce breaker, review mode, and
the audit trail are untouched.

## libphonenumber-js (phone)

- **Adapter:** `PhoneNormalizer` in `src/adapters/normalize.ts`.
- **Used for:** canonicalizing phone numbers to **E.164** and producing a
  digit-only **dedup key** (`phoneKey`). A leading international-dialing `00` is
  treated as `+`, so `+351 21 555 0100`, `00351 21 555 0100`, and
  `(351) 21-555-0100` all collapse to one key.
- **Where:** the phone fallback in `src/domain/dedupe.ts` (`normPhone`).

## tldts (domain)

- **Adapter:** `DomainNormalizer` in `src/adapters/normalize.ts`.
- **Used for:** extracting the **registrable domain (eTLD+1)** from a URL or
  host — `www.example.com → example.com`, `sub.example.co.uk → example.co.uk`,
  `https://example.com/path → example.com`. A tiny URL fallback covers reserved
  hosts tldts can't resolve (e.g. the `*.example` fixtures); malformed input
  returns null.
- **Where:** `domainOf` (`src/crawler/extract.ts`) and `deriveWebsite`
  (`src/domain/manual-ops.ts`), so sourcing and manual create dedupe on the same
  normalized domain.

## zod (validation)

- **Helpers:** `parseBody` + schemas `S.*` in `src/http/validate.ts`;
  `validateArgs` for agent tools.
- **Validates:**
  - Write routes: **create lead** (`POST /companies`), **edit lead**
    (`PATCH /companies/:id`), **stage update** (`PUT /companies/:id/stage`),
    **settings** (`PUT /settings`), **secret set** (`PUT /secrets/:name`),
    **assistant chat** (`POST /agent/chat`).
  - Agent tool args: **`send_email`** and **`bulk_move_stage`**.
- **Guarantees:** malformed JSON → **400** (not 500); invalid/missing fields →
  400 with a `path: message` hint; **submitted values are never echoed** (error
  text is built from zod's field path + generic message only), so a rejected
  secret can't leak. Validation runs *before* the handler and never bypasses a
  safety gate — the existing domain checks (dedup, CAS, verification,
  suppression, DRY_RUN) still run underneath.

## What remains custom (deliberately)

Everything that is our IP and safety model: the CRM data model, the sequence
state machine, the send walls (pause → breaker → suppression → verify → window
→ cap → DRY_RUN → inbox), the agent tool registry + prompt-injection boundary +
human approval, the append-only audit trail, and the D1/KV/R2 storage. The
dedup *orchestration* (`findDuplicateCompany`) is ours; only its normalization
*internals* now call the libraries.

## Why we did not adopt full frameworks

Our architecture — Cloudflare Workers (edge V8 isolates), Hono, D1/KV/R2, a
build-free vanilla-ESM frontend — rules out the heavyweight platforms (Twenty,
Odoo, EspoCRM, Mautic, Postal, Mailcow, n8n, Temporal, Keycloak, Metabase):
they are long-running PHP/Java/Python/Node servers that cannot run in a Worker,
would duplicate or override our safety gates, and add ops + licensing surface
(several are AGPL/SSPL/BUSL/fair-code). The high-leverage, low-risk win is a
thin layer of permissive libraries that sharpen a single seam without changing
the architecture — exactly what this change does. See the full evaluation in
the leverage audit memo.
