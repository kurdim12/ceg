#!/usr/bin/env bash
# Phase 3 acceptance: no VN/TH-specific hardcoding anywhere.
# The single allowed exception is src/schedule/timezones.ts, the universal
# all-countries timezone table, which lists VN and TH identically to 60+
# other countries — excluding them there would itself be geo-special-casing.
set -u
hits=$(grep -rniE "vietnam|thailand|Asia/Ho_Chi_Minh|Asia/Bangkok" src/ public/ 2>/dev/null \
  | grep -v "^src/schedule/timezones.ts:")
if [ -n "$hits" ]; then
  echo "Geography hardcoding found outside the universal timezone table:"
  echo "$hits"
  exit 1
fi
echo "check:geo OK — no geography hardcoding"
