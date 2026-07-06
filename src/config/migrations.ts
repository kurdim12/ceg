/**
 * The newest migration this code expects to be applied. Bump it whenever you
 * add a file to migrations/. `scripts/check-migrations.sh` (part of
 * `npm run check`) fails the build if this drifts from the migrations folder,
 * and `schemaState()` uses it at runtime to detect a database that is behind
 * the deployed code — the exact gap that broke the live Leads page once.
 */
export const LATEST_MIGRATION = '0007_company_rev.sql'
