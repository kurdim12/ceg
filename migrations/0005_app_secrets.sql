-- Durable, deploy-proof key store. KV survives runtime, but a Git-integrated
-- Workers build resets dashboard variables on every deploy; the database does
-- not. Keys set here are permanent and universal until a human overwrites them.
CREATE TABLE app_secrets (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
