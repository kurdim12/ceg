export interface Env {
  DB: D1Database
  KV: KVNamespace
  R2: R2Bucket
  /** "true" until the Phase 6 Flip Gate passes with every box green. */
  DRY_RUN: string
  PRODUCT_NAME: string
  /** Wrangler secret gating the one-time owner-account bootstrap. Unset = setup disabled. */
  SETUP_TOKEN?: string
  /** API keys may also arrive as Cloudflare secrets (Variables page /
      `wrangler secret put`). Dashboard-pasted KV values take precedence. */
  ZEROBOUNCE_API_KEY?: string
  OPENROUTER_API_KEY?: string
  GOOGLE_PLACES_API_KEY?: string
  GMAIL_CLIENT_ID?: string
  GMAIL_CLIENT_SECRET?: string
}
