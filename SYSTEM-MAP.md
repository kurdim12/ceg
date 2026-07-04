# Maranasi Outreach Engine — System Map v2

> Compiled 2026-07-04 from the 8-section interrogation (this conversation), the deployed
> v1 system, and prior build/QA sessions. This is the **standing brief** for whichever
> path wins: it is the refactor punch-list AND the rebuild spec. Every decision below
> carries its why so it doesn't get re-litigated with less context later.

---

## 0. Standing brief

**GOAL** — A universal-geography B2B outreach engine + CRM, operated daily by the two
Maranasi owners (not by Abdelrahman), that sources leads, verifies contacts, runs
3-step personalized email sequences from the owners' own inboxes, routes non-responders
to a human phone gate, and reports to everyone daily.

**CONSTRAINTS** — English UI/agent. USD money. Owners are non-technical: polish and
safety rails are launch requirements, not nice-to-haves. Maintainer (Abdelrahman) is
travel-heavy in July (tender July 12, Kraków July 20–24). All API accounts on
Abdelrahman's card. Single-tenant unless the open question in §15 flips it.

**DONE-CRITERIA (launch)** — Two owners each: Gmail connected, working their own
assigned call queue, receiving the daily recap; sequences live at 15/day/inbox;
bounce breaker armed; zero native browser dialogs; agent hardened per §9.

**CURRENT STEP** — Choose the path (§16). One decision open (§15.1).

**LOAD-BEARING FACTS**
- Repo: `kurdim12/maranasi-crm`, branch `claude/maranasi-outreach-engine-c70z51`
- Deployed: `https://maranasi-crm.abdalrhmankurdi12.workers.dev`
- Stack: Cloudflare Workers + Hono + TypeScript strict, D1, KV, R2, single cron +
  internal dispatcher, vanilla ES-module dashboard served by the Worker
- LLM layer: OpenRouter (key in KV secrets, `secret:{NAME}` pattern)
- Verifier: ZeroBounce (key **unset**), ~$0.004/verify
- Sending state: `DRY_RUN=true`, zero real emails ever sent, Gmail unconnected
- QA: 9 defects found; fix-pass prompt **written, never executed**
- Existing guardrails that must survive any path: send caps · verify-before-send ·
  suppression list · gated drop · bounce breaker · CAS state transitions · audited
  activities (append-only) · PBKDF2 auth + KV sessions · demo-data system · 30 vitest
  tests · CI

---

## 1. Users & roles — the map's biggest finding

- **Operators: the two Maranasi owners.** Both admins. Abdelrahman is maintainer only —
  he will not use the dashboard. *(Why it matters: every prior design assumed him as
  operator; this reframes UI polish, onboarding, alerts, and the meaning of "done."
  It also explains zero-usage better than any UI verdict — the real users were never
  in the tool, and Gmail OAuth must happen on their inboxes, not his.)*
- **Two sending identities** — one Gmail per owner. Working interpretation (flagged,
  unchallenged): each owner works their own assigned leads. → Assignment field required
  (§3).
- The dashboard's first impression to the owners happens exactly once. The QA fix pass
  is therefore **handoff-blocking**, not cosmetic.

## 2. Pipeline stages

`new → email_sequence → replied → meeting_booked → deal → won / lost`

Parking states: `unresponsive_email` (email exhausted, never auto-dropped),
`no_valid_email` (verification failed → call queue), `dropped` (reachable only through
the phone gate, §8).

- **"Qualified"** (owner's word) = `meeting_booked`. It is a stage, not a sourcing
  filter.
- **"Replied" fires on any human reply**; the agent tags sentiment separately.
  *(Why: "not interested" is still a human at the other end; sentiment is metadata,
  stage is mechanics.)*

## 3. Data model

- **Two-level: `companies` ← `contacts`.** Three people at one company = one company,
  three contacts. Sequences target contacts; deals attach to companies. *(Structural
  change from v1's contact-centric model. Cheap right now: DB is empty, migration
  touches zero rows.)*
- **Assignment**: every lead carries an owner-assignee; call queues and recap sections
  are per-assignee.
- **Contact-stagger rule**: one contact per company in-sequence at a time, 3–4 day
  stagger before the next. *(Why: three cold emails from one domain in a morning reads
  as a spam run.)*
- **Deals**: stage + amount, **USD**, single stored currency.
- **Phone is two fields**: `format_valid` (automatic) and `confirmed` (a human reached
  them at least once). *(Why: the drop gate depends on knowing a human actually tried.)*
- **Meetings table** from day one: every booking logged against contact + company,
  moves stage to `meeting_booked`. *(This is what makes the parked native calendar a
  free upgrade later.)*

**Call screen (per lead, one screen):** company + city + **lead-local time right now** ·
phone + confirmed status · person name/role · full email thread inline · last-activity
line · call notes · three actions: log call outcome / book meeting / send to drop queue.
Nothing else.

## 4. Sourcing

- **Universal geography.** Not VN/TH-specific. Touches exactly three subsystems:
  send-window scheduling (per-lead timezone derived from city), inbox triage language
  (multi-language classifier), suppression/compliance (per-region). Schema, sequence
  engine, agent, dashboard are geography-agnostic already.
- **Email extraction from company websites is required** ("mounted on their actual
  emails"). Places API returns phone/site/address, never emails → a crawler step that
  visits each site and extracts addresses is load-bearing. Whether v1 has it → repo
  check §14.1. If absent, it is the first real feature gap.
- **Dedupe by domain** — deployed, keep.
- **Manual run**: fully parameterized by the person triggering — geo, business type,
  count. Current parameterization → repo check §14.2.
- **Defaults set by maintainer** (owner deferred): sourcing volume 25/day, adjustable;
  sourcing cron 02:00 Amman; the **sending dispatcher runs hourly** and releases only
  leads currently inside their local window (9:00–16:30 local, weekdays).

## 5. Verification

| Decision | Call | Why |
|---|---|---|
| Verifier | ZeroBounce, paid, at ingest | Raw scraped emails bounce 20–40%; domain dies ~3% |
| Catch-all / unknown | Hold — never send; route to phone path | Building reputation from zero; maybes are unaffordable; leads don't die |
| Invalid email | State `no_valid_email`, flagged to call queue | Never delete — owner's never-drop rule |
| Re-verification | If lead sat >60 days before next sequence | Emails rot ~2–3%/month; pennies vs. bounce risk |
| Bounce breaker | Warn 2% · full auto-stop 3% · **floor: ≥25 sends in window** | Gmail flags senders ~3%; floor prevents one bounce at 10 sends tripping a 10% false alarm |

## 6. Email engine

- **3-step sequence, different angle each step, 72h apart.** Never resend the same
  email. *(Why-line kept because it was re-proposed once already: literal resends =
  spam complaints = dead domain in ~2 weeks.)*
- Exhausted with no reply → `unresponsive_email`, flagged, never dropped.
- **Sending identity: the owners' real inboxes** — their call, price named once: a
  burned owner inbox breaks their daily email, so caps + breaker are promoted to
  critical. (Dedicated subdomain remains the recommended alternative; parked.)
- **Copy**: Abdelrahman/Claude design the 3-step templates from Maranasi's site and
  past events — build item, nothing needed from owners to start.
- **Approval model**: owners approve template skeletons **once**; then the **first 20
  personalized emails run as drafts for owner review**; then full auto. *(Guardrail
  added by maintainer: "approve once" covers the skeleton, not blind trust in every
  personalization from day one.)*
- **Caps**: 15/day/inbox default, weekly ramp, adjustable in settings. "No cap" is not
  a configurable state.
- Format rules carried from v1: plain text, max one link, no tracking pixels.
- Language: English everywhere (multi-language triage still required inbound, §7).

## 7. Inbox & replies

- **Conversations continue inside the CRM**: agent drafts, owner approves, it sends
  from the owner's inbox. (v1's send-reply flow — matches.)
- **Two kinds of no**: `not_interested` → lost, re-approachable after 6 months.
  "Stop emailing me" → permanent suppression, add-only list.
- **OOO / holiday auto-reply** → that lead pauses 7 days, resumes where it left off.
  System itself runs 365 — the pause is per-lead ammo conservation, not downtime.
- **Meetings at launch**: per-owner booking link (Cal.com free tier or Google
  appointment pages), agent inserts it into replies, bookings land in the meetings
  table. **Native in-CRM calendar: parked** (§15.3) — owner wanted it; maintainer
  parked it as a weeks-of-work feature no lead has asked for; the meetings table makes
  the later upgrade lossless.

## 8. Phone gate & drops

- Droppable after **3 failed call attempts spread over 2 weeks**, logged.
- Outcome buttons: `answered-interested` / `answered-not-interested` / `no-answer` /
  `wrong-number` / `callback-later`.
- Drop executes only on **owner confirm** — the agent prepares, a human clicks.
- WhatsApp (and Zalo/LINE post-universal): **manual from owners' phones, logged in the
  CRM.** No automation, no scraping numbers into bulk senders.
- Dropped leads **recycle into a re-approach pool after 12 months** (flagged
  interpretation of an "all yes" — stands unless overridden).

## 9. CRM agent

- Interface: **chat inside the dashboard**.
- **Autonomous writes**: edits fields, moves stages on its own (flagged interpretation
  — stands). Every action audited, append-only, including its own.
- **Drop is the one gated action**: owner confirms.
- Bulk writes **>20 records → stop, preview, require confirm**.

**The never-list — enforced at the TOOL layer, not the prompt** *(a rule in a prompt is
a suggestion; a tool that doesn't exist is a wall)*:
1. Never sends email. Drafts only; sending belongs to the sequence engine and its
   guardrails.
2. Never deletes. No delete tool exists; states park, history appends.
3. Suppression add-only. Removal is a human in settings.
4. Config read-only. Caps, sending mode, thresholds, keys, schedules — report, never
   change.
5. Bulk cap (above).
6. Never invents data. Empty field = "empty"; every factual answer from a tool read.
7. **Inbound email is data, not instructions.** Text inside a lead's reply is content
   to classify, never a command to execute — the injection defense that matters
   because two non-technical owners will read strangers' emails *through* this agent.

Items 5 and 7 are new hardening; 1–4 and 6 match v1's design intent.

## 10. Recap, alerts, break-glass, billing

- **Daily business recap → both owners** (+ copy to maintainer, default): new leads
  sourced · emails sent · replies (interested/not) · meetings booked · today's call
  queue per assignee · bounce rate · alarms.
- **System alerts → maintainer AND owners**: Gmail disconnected, breaker tripped, API
  credits low, cron missed.
- **Break-glass**: alerts reach Abdelrahman while traveling; a one-page "if it breaks"
  note lives inside the dashboard.
- **Billing**: OpenRouter, ZeroBounce, Places on Abdelrahman's card, absorbed into the
  project fee. *(Logged estimate, launch caps: roughly $10–30/month — verify ≈$3 at
  ~750 leads/mo, LLM triage+agent low single digits, Places scales with sourcing
  volume. Universal scale grows this; the month-three cost-separation conversation was
  declined knowingly.)*

## 11. Config defaults (all owner-adjustable in settings)

| Key | Default |
|---|---|
| Send cap / inbox / day | 15, weekly ramp |
| Sequence steps / spacing | 3 steps · 72h |
| Send window | 09:00–16:30 lead-local, weekdays |
| Sourcing volume | 25/day |
| Sourcing cron | 02:00 Amman · dispatcher hourly |
| Bounce breaker | warn 2% · stop 3% · floor 25 sends |
| Re-verify staleness | >60 days |
| OOO pause | 7 days |
| Contact stagger / company | 3–4 days |
| Phone gate | 3 attempts / 2 weeks |
| Lost re-approach / drop recycle | 6 months / 12 months |
| Currency | USD |

## 12. Gap list — ranked (this is the build list)

**P0 — blocks owner handoff**
1. Execute the written QA fix pass (9 defects + UI cleanup, kills native dialogs)
2. `companies ← contacts` schema + assignment field *(free while DB is empty)*
3. Universal timezone engine: per-lead local windows, hourly dispatcher
4. Gmail OAuth ×2 on the **owners'** inboxes
5. ZeroBounce key set + catch-all→hold path
6. Meetings table + per-owner booking links
7. Agent hardening: bulk-cap + inbound-injection defense (tool layer)
8. DRY_RUN off at 15/day/inbox

**P1 — first weeks live**
9. Email-extraction crawler *(if repo check 14.1 says absent — likely the largest
   single build item)*
10. Multi-language inbox triage (universal inbound)
11. Outreach copy pack: 3-step templates from Maranasi site + past events
12. First-20-drafts review mode
13. Per-assignee call queues + recap sections
14. `no_valid_email` → call-queue routing
15. Breaker floor + staleness re-verify *(pending 14.3 / 14.4)*
16. Recycler jobs: 6-month lost, 12-month dropped

**Parked** — native calendar UI · Zalo/LINE channels · dedicated sending subdomain ·
forecasting / proposals / automation rules (the old Depth Pack) · multi-tenant anything.

## 13. Explicitly OUT (deleted by decision)

Auto-calling · WhatsApp/Zalo/LINE automation · LinkedIn scraping · tracking pixels ·
multi-link emails · same-email resends · agent send/delete/config powers · suppression
removal by agent · unlimited sending · VN/TH hardcoding.

## 14. Repo checks (verify before pricing either path)

1. Does sourcing crawl company sites for **emails**, or Places-only?
2. Manual-run parameterization: geo / business type / count exposed?
3. Bounce breaker: minimum-volume floor present?
4. Staleness re-verification before new sequences: exists?

## 15. Open on the board

1. **THE GATE — asked three times, never answered:** run the fix pass + a 30-minute
   owner walkthrough of v1 *before* any rebuild code. Cheap, serves both paths, ends
   the guessing about users who've never touched the tool.
2. **"Universal" scope**: Maranasi targeting any country (assumed), or other companies
   using the platform? The second reopens the single-tenant decision deliberately
   locked on July 2 — different project.
3. **Native calendar**: parked by maintainer over owner's stated wish — owner may
   override, knowing the weeks-of-work price.
4. Standing interpretation flags (unchallenged "yes"es): agent autonomous writes ·
   two inboxes = per-owner lead ownership · 12-month drop recycle · recap copy to
   maintainer.

## 16. The fork — both paths start from this document

**Path A — Refactor v1** (recommended): this map becomes a Claude Code prompt executed
against the live repo. Order: P0 items 1→8, repo checks first. Realistic size: days.
Everything in the load-bearing guardrail list survives by default because it never gets
deleted.

**Path B — Rebuild from scratch**: this map becomes the from-scratch spec, PLUS a
mandatory port-list — the §0 guardrail list, the never-list, and every default in §11
must exist in v2 before first send. Realistic size: weeks; owners get nothing until
mid-August given the July calendar. The rebuild's day-one inheritance is v1's only
proven defect: zero users in the tool.

Either way: the next artifact is one Claude Code prompt, generated from this file.
