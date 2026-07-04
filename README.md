# Maranasi Outreach Engine — Standing Brief

This repository holds the governing documents for the Maranasi B2B outreach engine + CRM.

| File | What it is |
|---|---|
| [`SYSTEM-MAP.md`](SYSTEM-MAP.md) | **System Map v2** (2026-07-04) — the standing brief compiled from the 8-section interrogation, the deployed v1 system, and prior build/QA sessions. It is both the refactor punch-list and the rebuild spec; every decision carries its why so nothing gets re-litigated with less context later. |
| [`EXECUTION-PROMPT.md`](EXECUTION-PROMPT.md) | The one Claude Code prompt generated from the map (its stated "next artifact"). Written for **Path A — refactor v1** (the map's recommended path), to be executed against `kurdim12/maranasi-crm` on branch `claude/maranasi-outreach-engine-c70z51`. Carries a Path B port-list appendix so it still governs if the fork decision flips to a rebuild. |

## Status

- **Current step** (map §0): choose the path (§16). One decision open (§15.1 — the gate: run the QA fix pass + a 30-minute owner walkthrough of v1 before any rebuild code).
- The execution prompt does not pre-empt that decision: its first phases (repo checks §14, then the QA fix pass) are explicitly path-neutral per the map itself.
- Live system: `https://maranasi-crm.abdalrhmankurdi12.workers.dev` — `DRY_RUN=true`, zero real emails ever sent, Gmail unconnected.

The map is the source of truth. If the prompt and the map ever disagree, the map wins and the prompt gets fixed.
