#!/usr/bin/env bash
# Operating rule 4: zero native browser dialogs for the life of the repo.
set -u
hits=$(grep -rn "alert(\|confirm(\|prompt(" src/ public/ 2>/dev/null)
if [ -n "$hits" ]; then
  echo "Native dialog calls found:"
  echo "$hits"
  exit 1
fi
echo "check:dialogs OK — zero native dialog calls"
