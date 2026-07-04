# Maranasi Outreach Engine

This repository holds the Maranasi Engine v2 (Cloudflare Workers + Hono + TypeScript
strict, D1/KV/R2) **and** its governing documents. The build follows
`EXECUTION-PROMPT.md` under the active keys-later run directive; the repo name is the
prompt's `maranasi-engine` placeholder (owner renames).

Dev: `npm install`, then `npm run check` (typecheck + tests + dialog grep). Tests run
against real D1/KV bindings via the Cloudflare workers pool.

## Governing documents

| File | What it is |
|---|---|
| [`SYSTEM-MAP.md`](SYSTEM-MAP.md) | **System Map v2** (2026-07-04) — the standing brief compiled from the 8-section interrogation, the deployed v1 system, and prior build/QA sessions. Every decision carries its why so nothing gets re-litigated with less context later. |
| [`EXECUTION-PROMPT.md`](EXECUTION-PROMPT.md) | **The active execution prompt — Path B (greenfield rebuild), the decided path.** One self-contained Claude Code prompt to build the engine from scratch in a new repository (`maranasi-engine`, placeholder name), with v1 as read-only reference only. Carries the mandatory port-list (v1's 11 guardrails), the 7-item tool-layer never-list, all 12 config defaults, six build phases ending in the hard-gated `DRY_RUN` flip, and the v1 decommission note. |
| [`KEY-RUN-PROMPT.md`](KEY-RUN-PROMPT.md) | **Claude in Chrome prompt — the key run.** Walks the maintainer through provisioning the three maintainer-side API keys (ZeroBounce = flip-gate blocker H3, OpenRouter, Google Places) as fresh `maranasi-v2`-scoped credentials, human-handles-everything-sensitive. Keys land in the password manager only; they get pasted into the v2 dashboard when the build session emits its `HUMAN STEP` field names. |
| [`archive/EXECUTION-PROMPT-PATH-A.md`](archive/EXECUTION-PROMPT-PATH-A.md) | The superseded Path A (refactor v1) prompt, kept for the record. Do not execute. |

## Status

- **The fork (map §16) is decided: Path B — rebuild from scratch.** The Path B prompt
  above is the governing build document.
- **The gate question (map §15.1) is resolved by that decision**: there is no v1 QA
  fix pass — v1 stays deployed and untouched as read-only reference until v2 passes
  its Flip Gate, then gets decommissioned per the prompt's decommission note. The
  30-minute owner walkthrough survives, retargeted to **v2 on demo data** as a Flip
  Gate checkbox (H1) — the owners see the tool before it goes live.
- Live v1: `https://maranasi-crm.abdalrhmankurdi12.workers.dev` — `DRY_RUN=true`,
  zero real emails ever sent. It stays that way; v2 is born with `DRY_RUN=true` in
  its first commit.
- The key run (above) can happen any time before the maintainer's July travel —
  it front-loads H3 so the flip gate later waits on a paste, not a signup.
- **A run directive (keys-later mode) is ACTIVE in the execution prompt**: the build
  runs all phases in one continuous pass, mock-first behind adapter interfaces, never
  stalling on human steps — accumulating `PENDING-HUMAN` items instead. Phase 6 runs
  as *evaluation*: the run ends at a fully evaluated flip gate in `DRY_RUN`, plus one
  consolidated table of the human actions between it and live. The flip itself still
  requires every box green.

## Precedence

The map remains the decision record — its whys still govern, and the prompt embeds its
defaults verbatim. Where the Path B prompt explicitly supersedes the map (the §16 fork,
the §15.1 gate placement), the prompt wins. For everything else, if the prompt and the
map ever disagree, the map wins and the prompt gets fixed.
