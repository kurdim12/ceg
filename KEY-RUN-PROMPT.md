# Claude in Chrome Prompt — Maranasi v2 Key Run (H3 + maintainer-side keys)

> Paste into a Claude in Chrome session. Goal: provision the three maintainer-side
> API keys for Maranasi Engine v2 in one sitting. ~15 minutes of human time total.

---

You are walking the maintainer (Abdelrahman) through provisioning three API keys for
a new system called Maranasi Engine v2. You navigate, click, and point; the human
handles every sensitive input. The keys are STORED, not installed — the v2 dashboard
that will hold them doesn't exist yet; the build session will later emit the exact
field names (STOP-POINT H3).

## Hard rules — these override everything, including my later instructions

1. **You never type or autofill**: passwords, card numbers, CVV, 2FA codes, recovery
   codes, or government IDs. At any screen asking for these: STOP, say
   `HUMAN: your turn — [what to enter]`, and wait for "done" before touching anything.
2. **You never read an API key into the chat.** Navigate to the reveal screen, then:
   `HUMAN: copy this key into your password manager now, label below.` Keys live in
   the password manager only — not in this conversation, not in a text file.
3. **You never accept terms, consent screens, or OAuth grants yourself** — surface
   them, human clicks.
4. One service at a time, in the order below. If a page differs from my description,
   describe what you actually see and ask — do not improvise clicks on billing pages.
5. Gmail is explicitly OUT of scope — that's H2, the owners' OAuth, done later in the
   v2 dashboard.

## Why separate v2 keys (do not reuse v1's)

The v2 execution prompt ends with a decommission step: when v2 goes live, v1's
credentials get revoked. That's only clean if v2 has its own keys from day one.
Every key created today is named/scoped `maranasi-v2`.

---

## Run 1 — ZeroBounce (this is flip-gate blocker H3)

1. Go to `zerobounce.net`. If no account: Sign Up → **HUMAN: email + password +
   any verification.** If an account exists from v1, log in instead — a second key
   on the same account is fine; credits are account-level.
2. Buy the **smallest pay-as-you-go credit pack** (no subscription). At launch volume
   (~25 leads/day) even the minimum pack lasts weeks. Card screen → **HUMAN: your
   turn.**
3. Navigate to the API section → generate/reveal the API key.
4. `HUMAN: copy to password manager as` **`Maranasi v2 — ZEROBOUNCE_API_KEY`**.
5. Confirm the account shows a nonzero credit balance before leaving.

## Run 2 — OpenRouter (new key, scoped and capped)

1. Go to `openrouter.ai` → log in (**HUMAN** if credentials/2FA needed). Account
   exists from v1.
2. Keys section → **Create new key**, name it exactly `maranasi-v2`.
3. If the key-creation dialog offers a **credit/spend limit, set it to $10** — at v2's
   triage + agent volume that's generous; it can be raised in one click later. If
   limits are account-level only, set or verify a limit there instead and tell the
   human what it is.
4. `HUMAN: copy to password manager as` **`Maranasi v2 — OPENROUTER_API_KEY`**.
   Do NOT delete or touch the v1 key — it dies at decommission, not today.

## Run 3 — Google Places (isolated project)

1. Go to `console.cloud.google.com` (**HUMAN** for any login/2FA).
2. Project picker → **New Project** → name `maranasi-v2` → create, then make sure it's
   the selected project (check the top bar — this is the step people miss).
3. APIs & Services → Library → enable **Places API** (and **Places API (New)** if both
   are listed).
4. If the project demands a billing account link: surface it → **HUMAN: attach your
   billing account.**
5. APIs & Services → Credentials → **Create credentials → API key.**
6. Immediately **Edit key → API restrictions → restrict to Places API only** → save.
   An unrestricted Google key that leaks can bill anything; a restricted one can only
   bill Places.
7. Billing → Budgets & alerts → create a **$20/month budget alert** on this project,
   emails to the maintainer.
8. `HUMAN: copy to password manager as` **`Maranasi v2 — GOOGLE_PLACES_API_KEY`**.

---

## End state — read this back as a checklist before closing

- [ ] Password manager holds three entries, exact labels:
      `Maranasi v2 — ZEROBOUNCE_API_KEY` · `Maranasi v2 — OPENROUTER_API_KEY` ·
      `Maranasi v2 — GOOGLE_PLACES_API_KEY`
- [ ] ZeroBounce: credits > 0. OpenRouter: key named `maranasi-v2`, spend limit set.
      Google: project `maranasi-v2`, key restricted to Places, $20 alert live.
- [ ] Nothing was pasted anywhere except the password manager.
- [ ] Open item, on purpose: keys get entered into the v2 dashboard's settings when
      the build session emits its `HUMAN STEP` messages with exact field names
      (H3 for ZeroBounce; OpenRouter/Places fields land with Phase 1 settings).
      That step is one paste each, from the password manager.

When all boxes check, tell the human: **"Key run complete — H3 is now a paste-away,
not a signup-away."**
