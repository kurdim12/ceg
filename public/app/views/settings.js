import { api } from '../api.js'
import { toast } from '../toast.js'
import { confirmModal } from '../modal.js'

function esc(text) {
  const div = document.createElement('div')
  div.textContent = text ?? ''
  return div.innerHTML
}

const SECRET_LABELS = {
  ZEROBOUNCE_API_KEY: 'ZeroBounce (email verification)',
  OPENROUTER_API_KEY: 'OpenRouter (assistant + triage)',
  GOOGLE_PLACES_API_KEY: 'Google Places (lead sourcing)',
  GMAIL_CLIENT_ID: 'Gmail OAuth client ID',
  GMAIL_CLIENT_SECRET: 'Gmail OAuth client secret',
}

const FIELD_LABELS = [
  ['sendCapPerInboxPerDay', 'Send cap per inbox per day'],
  ['sourcingGeo', 'Daily sourcing: where'],
  ['sourcingBusinessType', 'Daily sourcing: business type'],
  ['sourcingVolumePerDay', 'Daily sourcing: how many'],
  ['sendWindowStartLocal', 'Send window opens (lead-local)'],
  ['sendWindowEndLocal', 'Send window closes (lead-local)'],
  ['sequenceSpacingHours', 'Hours between sequence steps'],
  ['oooPauseDays', 'Pause after out-of-office (days)'],
]

export async function renderSettings(root, ctx) {
  const data = await api.get('/api/settings')
  const breaker = await api.get('/api/breaker')

  root.innerHTML = `
    <h2>Sending</h2>
    <div class="panel">
      <div class="sub">Dry run is ${data.dryRun ? 'ON — no emails leave the system' : 'OFF — the engine sends for real'}.
      The send cap can be adjusted but never removed.</div>
      <div class="form-grid" id="settings-form">
        ${FIELD_LABELS.map(
          ([key, label]) => `
          <label>${label}
            <input data-key="${key}" value="${esc(String(data.settings[key]))}" />
          </label>`,
        ).join('')}
      </div>
      <button id="save-settings">Save settings</button>
    </div>

    <h2>Bounce breaker</h2>
    <div class="panel">
      <div>${breaker.state.tripped
        ? `⚠ TRIPPED: ${esc(breaker.state.reason ?? '')} — sending is stopped.`
        : `Armed. Current window: ${breaker.verdict.sends} sends, level "${esc(breaker.verdict.level.replaceAll('_', ' '))}".`}</div>
      ${breaker.state.tripped ? '<button class="danger" id="breaker-reset">I investigated — reset the breaker</button>' : ''}
    </div>

    <h2>Connections & keys</h2>
    <div class="panel">
      <div class="sub">Paste each key from the password manager entry named
      "Maranasi v2 — (key name)". A key activates its subsystem instantly — no other steps.</div>
      ${Object.entries(SECRET_LABELS)
        .map(
          ([name, label]) => `
        <div class="secret-row">
          <span>${label} ${data.secrets[name] ? '<span class="chip ok">set</span>' : '<span class="chip warn">holding</span>'}</span>
          <span><input data-secret="${name}" placeholder="paste ${name}" type="password" />
          <button class="secondary set-secret" data-secret-btn="${name}">Set</button></span>
        </div>`,
        )
        .join('')}
      <div class="secret-row">
        <span>Your Gmail (sends your sequences)</span>
        <span>
          <button class="secondary" id="gmail-connect">Connect my Gmail</button>
          <button class="secondary" id="gmail-disconnect">Disconnect</button>
        </span>
      </div>
      <div class="secret-row">
        <span>Your booking link (goes into replies)</span>
        <span><input id="booking-link" placeholder="https://cal.com/you/15min" />
        <button class="secondary" id="save-booking">Save</button></span>
      </div>
    </div>

    <h2>Demo data</h2>
    <div class="panel">
      <button class="secondary" id="demo-reset">Regenerate demo data</button>
    </div>

    <h2>If it breaks</h2>
    <div class="panel break-glass">
      <p><strong>Emails stopped going out?</strong> Check the banner at the top. A tripped bounce
      breaker or a disconnected Gmail stops sending on purpose — nothing is lost, leads wait.
      Reset the breaker above only after reading why it tripped.</p>
      <p><strong>Something looks wrong with a lead?</strong> Nothing is ever deleted. Every change
      is in the lead's activity trail (Leads → click the lead). The assistant can explain any entry.</p>
      <p><strong>A key stopped working?</strong> The affected part holds safely and shows
      "holding" above. Paste a fresh key and it resumes by itself.</p>
      <p><strong>Still stuck?</strong> Message Abdelrahman (maintainer). Include what the banner
      says. The system keeps holding safely meanwhile — nothing sends while broken.</p>
    </div>`

  root.querySelector('#save-settings').addEventListener('click', async () => {
    const patch = {}
    root.querySelectorAll('#settings-form input').forEach((input) => {
      const raw = input.value.trim()
      const key = input.dataset.key
      patch[key] = /^\d+$/.test(raw) ? Number(raw) : raw
    })
    try {
      await api.put('/api/settings', patch)
      toast('Settings saved', 'success')
      ctx.reload()
    } catch (err) {
      toast(err.message, 'error')
    }
  })

  root.querySelector('#breaker-reset')?.addEventListener('click', async () => {
    const go = await confirmModal({
      title: 'Reset the bounce breaker?',
      body: 'Only reset after understanding why it tripped — a bad list burns the inboxes that send your daily email.',
      confirmLabel: 'Reset breaker',
      danger: true,
    })
    if (!go) return
    await api.post('/api/breaker/reset')
    toast('Breaker reset', 'success')
    ctx.reload()
  })

  root.querySelectorAll('.set-secret').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.secretBtn
      const input = root.querySelector(`input[data-secret="${name}"]`)
      if (!input.value.trim()) return toast('Paste the key first', 'error')
      try {
        await api.put(`/api/secrets/${name}`, { value: input.value.trim() })
        toast(`${name} set — subsystem is live`, 'success')
        ctx.reload()
      } catch (err) {
        toast(err.message, 'error')
      }
    })
  })

  root.querySelector('#gmail-connect').addEventListener('click', async () => {
    try {
      const { url } = await api.get('/api/gmail/connect')
      window.open(url, '_blank', 'noopener')
    } catch (err) {
      toast(err.message, 'error')
    }
  })
  root.querySelector('#gmail-disconnect').addEventListener('click', async () => {
    const go = await confirmModal({
      title: 'Disconnect Gmail?',
      body: 'Your sequences hold until you reconnect.',
      confirmLabel: 'Disconnect',
      danger: true,
    })
    if (!go) return
    await api.post('/api/gmail/disconnect')
    toast('Disconnected', 'success')
    ctx.reload()
  })

  root.querySelector('#save-booking').addEventListener('click', async () => {
    try {
      await api.put('/api/me/booking-link', { url: root.querySelector('#booking-link').value.trim() })
      toast('Booking link saved', 'success')
    } catch (err) {
      toast(err.message, 'error')
    }
  })

  root.querySelector('#demo-reset').addEventListener('click', async (e) => {
    e.target.disabled = true
    try {
      const result = await api.post('/api/demo/reset')
      toast(`Demo data regenerated: ${result.companies} companies`, 'success')
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      e.target.disabled = false
    }
  })
}
