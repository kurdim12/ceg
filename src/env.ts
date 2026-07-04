export interface Env {
  DB: D1Database
  KV: KVNamespace
  R2: R2Bucket
  /** "true" until the Phase 6 Flip Gate passes with every box green. */
  DRY_RUN: string
  PRODUCT_NAME: string
}
