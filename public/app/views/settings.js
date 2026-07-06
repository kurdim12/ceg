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

function timeAgo(iso) {
  if (!iso) return ''
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso + 'Z').getTime()) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export async function renderSettings(root, ctx) {
  const [data, breaker, readiness, sending, audit] = await Promise.all([
    api.get('/api/settings'),
    api.get('/api/breaker'),
    api.get('/api/readiness').catch(() => null),
    api.get('/api/sending/state').catch(() => ({ pause: { paused: false } })),
    api.get('/api/audit').catch(() => ({ events: [] })),
  ])
  // The signed-in owner's own connection state (Gmail + booking link).
  const me = ctx.me ?? (await api.get('/api/me'))
  const gmailConnected = Boolean(me.gmailConnected)
  const paused = Boolean(sending.pause?.paused)

  const AUDIT_LABELS = {
    email_sent: 'Email sent', draft_approved: 'Draft approved', drafts_auto_approved: 'Drafts auto-approved',
    send_held_paused: 'Send held — paused', send_held_breaker: 'Send held — breaker',
    test_email_sent: 'Test email sent', test_email_dry_run: 'Test email (dry run)',
    company_created: 'Lead created', company_deleted: 'Lead deleted', lead_edited: 'Lead edited',
    stage_set_manual: 'Stage changed', secret_set: 'Key set', settings_update: 'Settings changed',
    sending_paused: 'Sending PAUSED', sending_resumed: 'Sending resumed',
    gmail_connected: 'Gmail connected', gmail_disconnected: 'Gmail disconnected',
    breaker_tripped: 'Breaker tripped', breaker_reset: 'Breaker reset',
  }

  root.innerHTML = `
    <div class="card ${data.dryRun ? 'callout' : ''}" style="${data.dryRun ? '' : 'border-color:var(--red);background:var(--red-soft)'}">
      <div class="lbl" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        ${data.dryRun
          ? '<span class="chip holding">DRY RUN</span><strong>No emails leave the system.</strong> Real sending is off until a human flips it.'
          : '<span class="chip lost">LIVE</span><strong>The engine is sending real emails.</strong>'}
      </div>
    </div>

    <h2>Go-live readiness</h2>
    <div class="card">
      ${readiness
        ? `<div class="lbl" style="margin-bottom:10px">${readiness.ready
            ? '<span class="chip ok">All required checks pass</span> Ready to flip DRY_RUN when you choose.'
            : `<span class="chip warn">${readiness.blockers.length} blocker${readiness.blockers.length === 1 ? '' : 's'}</span> Clear these before going live.`}</div>
          <div class="readiness-list">
            ${readiness.gates.map((g) => `
              <div class="secret-row" style="padding:9px 0">
                <span class="lbl">${g.ok ? '<span class="chip ok no-dot">ready</span>' : g.required ? '<span class="chip lost no-dot">blocker</span>' : '<span class="chip holding no-dot">optional</span>'} ${esc(g.label)}</span>
              </div>`).join('')}
          </div>`
        : '<div class="hint">Readiness check unavailable.</div>'}
    </div>

    <h2>Emergency controls</h2>
    <div class="card">
      <div class="secret-row">
        <span class="lbl">${paused
          ? '<span class="chip lost">SENDING PAUSED</span> All outbound email is stopped by hand.'
          : '<span class="chip ok">Sending armed</span> The manual stop is off.'}</span>
        <span class="ctl">
          ${paused
            ? '<button class="secondary" id="sending-resume">Resume sending</button>'
            : '<button class="danger" id="sending-pause">Pause all sending</button>'}
        </span>
      </div>
      <div class="secret-row">
        <span class="lbl">Send a test email to yourself <span class="hint">(never mass-sends; DRY_RUN safe)</span></span>
        <span class="ctl"><button class="secondary" id="send-test">Send test email</button></span>
      </div>
    </div>

    <h2>Sending</h2>
    <div class="card">
      <div class="hint">Dry run is ${data.dryRun ? 'ON — no emails leave the system' : 'OFF — the engine sends for real'}.
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
    <div class="card">
      <div>${breaker.state.tripped
        ? `<span class="chip lost">tripped</span> ${esc(breaker.state.reason ?? '')} — sending is stopped.`
        : `<span class="chip ok">armed</span> ${breaker.verdict.sends} sends this window · ${esc(breaker.verdict.level.replaceAll('_', ' '))}`}</div>
      <div class="breaker-caption">warn ≥ 2% · stop ≥ 3% · floor 25 sends · trailing 7 days</div>
      ${breaker.state.tripped ? '<button class="danger" id="breaker-reset">I investigated — reset the breaker</button>' : ''}
    </div>

    <h2>Connections & keys</h2>
    <div class="card">
      <div class="hint">Paste each key from the password manager entry named
      "Maranasi v2 — (key name)". A key activates its subsystem the moment it is set.</div>
      ${Object.entries(SECRET_LABELS)
        .map(
          ([name, label]) => `
        <div class="secret-row">
          <span class="lbl">${label} ${data.secrets[name] ? '<span class="chip live">live</span>' : '<span class="chip holding">holding</span>'}</span>
          <span class="ctl input-group"><input data-secret="${name}" placeholder="paste ${name}" type="password" />
          <button class="secondary set-secret" data-secret-btn="${name}">Set</button></span>
        </div>`,
        )
        .join('')}
      <div class="secret-row">
        <span class="lbl">Your Gmail (sends your sequences)
          ${gmailConnected ? '<span class="chip live">connected</span>' : '<span class="chip holding">not connected</span>'}</span>
        <span class="ctl">
          <button class="secondary" id="gmail-connect">${gmailConnected ? 'Reconnect' : 'Connect my Gmail'}</button>
          ${gmailConnected ? '<button class="secondary" id="gmail-disconnect">Disconnect</button>' : ''}
        </span>
      </div>
      <div class="secret-row">
        <span class="lbl">Your booking link (goes into replies)</span>
        <span class="ctl input-group"><input id="booking-link" placeholder="https://cal.com/you/15min" value="${esc(me.bookingLink ?? '')}" />
        <button class="secondary" id="save-booking">Save link</button></span>
      </div>
    </div>

    <h2>Demo data</h2>
    <div class="card">
      <button class="secondary" id="demo-reset">Regenerate demo data</button>
    </div>

    <h2>Recent activity</h2>
    <div class="card">
      ${audit.events.length === 0
        ? '<div class="hint">No recorded actions yet.</div>'
        : `<div class="audit-list">${audit.events.slice(0, 30).map((e) => `
            <div class="drop-row" style="padding:8px 0">
              <span><strong>${esc(AUDIT_LABELS[e.kind] ?? e.kind.replaceAll('_', ' '))}</strong>
                <span class="hint">· ${esc(e.actor)}</span></span>
              <span class="hint mono">${esc(timeAgo(e.createdAt))}</span>
            </div>`).join('')}</div>`}
    </div>

    <h2>If it breaks</h2>
    <div class="card break-glass">
      <p><strong>Emails stopped going out?</strong> Check the status strip at the top. A tripped bounce
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

  root.querySelector('#sending-pause')?.addEventListener('click', async () => {
    const go = await confirmModal({
      title: 'Pause all sending?',
      body: 'This is the emergency stop. No outbound email goes out — not sequences, not replies — until someone resumes it here. Nothing is lost; leads wait.',
      confirmLabel: 'Pause sending',
      danger: true,
    })
    if (!go) return
    try {
      await api.post('/api/sending/pause', { reason: 'paused from settings' })
      toast('Sending paused', 'success')
      ctx.reload()
    } catch (err) {
      toast(err.message, 'error')
    }
  })

  root.querySelector('#sending-resume')?.addEventListener('click', async () => {
    try {
      await api.post('/api/sending/resume')
      toast('Sending resumed', 'success')
      ctx.reload()
    } catch (err) {
      toast(err.message, 'error')
    }
  })

  root.querySelector('#send-test')?.addEventListener('click', async (e) => {
    e.target.disabled = true
    e.target.textContent = 'Sending…'
    try {
      const r = await api.post('/api/sending/test')
      toast(
        r.dryRun
          ? `DRY_RUN is on — nothing was sent. A real test would reach ${r.to}.`
          : `Test email sent to ${r.to}. Check your inbox.`,
        'success',
      )
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      e.target.disabled = false
      e.target.textContent = 'Send test email'
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
  root.querySelector('#gmail-disconnect')?.addEventListener('click', async () => {
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
