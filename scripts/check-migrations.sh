#!/usr/bin/env bash
# Fails if src/config/migrations.ts is out of sync with the migrations/ folder,
# so you can never add a migration file and forget to bump LATEST_MIGRATION
# (which is what schemaState/deploy rely on).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
newest="$(ls "$root/migrations"/*.sql | sort | tail -1 | xargs basename)"
declared="$(grep -oE "LATEST_MIGRATION = '[^']+'" "$root/src/config/migrations.ts" | sed "s/.*'\(.*\)'/\1/")"

if [ "$newest" != "$declared" ]; then
  echo "check:migrations FAIL — newest file is '$newest' but LATEST_MIGRATION is '$declared'."
  echo "  Bump LATEST_MIGRATION in src/config/migrations.ts to '$newest'."
  exit 1
fi

echo "check:migrations OK — LATEST_MIGRATION matches migrations/ ($newest)"
