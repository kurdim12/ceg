-- Optimistic-concurrency version for company field edits and deletes. Bumped
-- on every manual field edit; the edit/delete paths compare-and-swap on it so
-- a stale writer loses instead of silently clobbering a colleague's change.
-- (Stage changes keep their own stage_version; this guards the other fields.)
ALTER TABLE companies ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
