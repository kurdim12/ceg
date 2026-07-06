import { api } from './api.js'
import { toast } from './toast.js'
import { confirmModal } from './modal.js'
import { timeChip } from './timechip.js'

// Frappe-style all-in-one record drawer: slides in from the right with
// tabs (Details · Contacts · Emails · Activity). Opened from any list.

const STAGES = [
  ['new', 'New'], ['email_sequence', 'In sequence'], ['replied', 'Replied'],
  ['meeting_booked', 'Meeting booked'], ['deal', 'Deal'], ['won', 'Won'],
  ['lost', 'Lost'], ['unresponsive_email', 'Unresponsive'],
  ['no_valid_email', 'No valid email'], ['dropped', 'Dropped'],
]
const STAGE_LABELS = Object.fromEntries(STAGES)
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

function esc(text) {
  const div = document.createElement('div')
  div.textContent = text ?? ''
  return div.innerHTML
}
function initials(name) {
  return (name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('')
}

/** Opens the record drawer for a company. onChange() fires after any mutation. */
export async function openRecord(companyId, onChange = () => {}) {
  const host = document.createElement('div')
  host.className = 'drawer-overlay'
  host.innerHTML = '<div class="drawer" role="dialog" aria-modal="true"><div class="drawer-loading">Loading…</div></div>'
  document.body.appendChild(host)
  const panel = host.querySelector('.drawer')

  function close() {
    host.classList.add('closing')
    setTimeout(() => host.remove(), 160)
  }
  host.addEventListener('click', (e) => { if (e.target === host) close() })
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc) }
  })

  let data
  try {
    data = await api.get(`/api/companies/${companyId}/detail`)
  } catch (err) {
    panel.innerHTML = `<div class="drawer-loading">${esc(err.message)}</div>`
    return
  }
  const { company, contacts, thread, deal } = data
  let tab = 'details'

  function detailsTab() {
    const rows = [
      ['Stage', `<span class="chip ${esc(company.stage)}">${esc(STAGE_LABELS[company.stage] ?? company.stage)}</span>`],
      ['City', esc(company.city ?? '—')],
      ['Country', esc(company.country ?? '—')],
      ['Their time', company.timezone ? timeChip(company.timezone) : '—'],
      ['Phone', `<span class="mono">${esc(company.phone ?? '—')}</span>${company.phoneConfirmed ? ' <span class="chip ok no-dot">confirmed</span>' : ''}`],
      ['Website', company.website ? `<a href="${esc(company.website)}" target="_blank" rel="noopener" class="link">${esc(company.domain ?? company.website)}</a>` : '—'],
      ['Business type', esc(company.businessType ?? '—')],
      ['Assignee', esc(company.assigneeName ?? 'Unassigned')],
      ['Added', `<span class="mono">${esc(company.createdAt)}</span>`],
    ]
    if (deal) rows.splice(1, 0, ['Deal', `${esc(deal.status)} · <span class="mono">${deal.amountUsdCents != null ? usd.format(deal.amountUsdCents / 100) : 'no amount'}</span>`])
    return `<dl class="rec-fields">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`
  }
  function contactsTab() {
    if (contacts.length === 0) return '<div class="hint" style="padding:8px 0">No contacts on record.</div>'
    return contacts.map((p) => `
      <div class="rec-contact">
        <span class="ini" style="background:var(--accent)">${esc(initials(p.name ?? p.email))}</span>
        <div><div class="nm">${esc(p.name ?? '(no name)')}</div><div class="hint">${esc(p.role ?? '')} · <span class="mono">${esc(p.email ?? 'no email')}</span></div></div>
        <span class="chip quiet">${esc((p.emailStatus ?? '').replaceAll('_', ' '))}</span>
      </div>`).join('')
  }
  function emailsTab() {
    if (thread.length === 0) return '<div class="hint" style="padding:8px 0">No emails yet.</div>'
    return thread.map((m) => `
      <div class="thread-msg ${esc(m.direction)}">
        <div class="meta">${m.direction === 'outbound' ? 'We wrote' : 'They wrote'} · ${esc(m.createdAt)} · ${esc(m.status)}${m.triage ? ' · ' + esc(m.triage) : ''}</div>
        <div class="subject">${esc(m.subject ?? '(no subject)')}</div>
        <pre>${esc(m.body ?? '')}</pre>
      </div>`).join('')
  }
  async function activityTab() {
    const { activities } = await api.get(`/api/companies/${companyId}/activities`)
    return activities.length === 0
      ? '<div class="hint" style="padding:8px 0">No activity yet.</div>'
      : activities.map((a) => `<div class="activity"><div>${esc(a.kind.replaceAll('_', ' '))}</div><div class="meta">${esc(a.actor)} · ${esc(a.createdAt)}</div></div>`).join('')
  }

  const TABS = [['details', 'Details'], ['contacts', `Contacts · ${contacts.length}`], ['emails', `Emails · ${thread.length}`], ['activity', 'Activity']]

  async function render() {
    panel.innerHTML = `
      <div class="drawer-head">
        <div class="rec-title">
          <span class="ini" style="background:var(--accent)">${esc(initials(company.name))}</span>
          <div>
            <div class="nm">${esc(company.name)}</div>
            <div class="hint">${esc(company.city ?? '—')}${company.country ? ', ' + esc(company.country) : ''}</div>
          </div>
        </div>
        <div class="drawer-head-actions">
          <span class="stage-select"><select id="rec-stage" aria-label="Change stage">
            ${STAGES.map(([v, l]) => `<option value="${v}" ${v === company.stage ? 'selected' : ''}>${l}</option>`).join('')}
          </select></span>
          <button class="icon-btn" id="rec-close" aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </div>
      <div class="drawer-tabs">${TABS.map(([k, l]) => `<button class="${k === tab ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
      <div class="drawer-body" id="rec-body"></div>
      <div class="drawer-foot">
        <button class="secondary" id="rec-call">Open in call screen</button>
        <button class="danger" id="rec-delete">Delete lead</button>
      </div>`

    const body = panel.querySelector('#rec-body')
    body.innerHTML = tab === 'details' ? detailsTab()
      : tab === 'contacts' ? contactsTab()
      : tab === 'emails' ? emailsTab()
      : '<div class="hint">Loading…</div>'
    if (tab === 'activity') body.innerHTML = await activityTab()

    panel.querySelector('#rec-close').addEventListener('click', close)
    panel.querySelectorAll('.drawer-tabs button').forEach((b) =>
      b.addEventListener('click', () => { tab = b.dataset.tab; render() }))

    panel.querySelector('#rec-stage').addEventListener('change', async (e) => {
      const to = e.target.value
      try {
        await api.put(`/api/companies/${companyId}/stage`, { stage: to })
        company.stage = to
        toast(`Moved to ${STAGE_LABELS[to] ?? to}`, 'success')
        onChange()
        if (tab === 'details') render()
      } catch (err) {
        toast(err.message, 'error')
        e.target.value = company.stage
      }
    })
    panel.querySelector('#rec-delete').addEventListener('click', async () => {
      const go = await confirmModal({
        title: `Delete ${company.name}?`,
        body: 'This permanently removes the lead, its contacts, and its emails. This cannot be undone.',
        confirmLabel: 'Delete lead', danger: true,
      })
      if (!go) return
      try {
        await api.delete(`/api/companies/${companyId}`)
        toast('Lead deleted', 'success')
        close()
        onChange()
      } catch (err) {
        toast(err.message, 'error')
      }
    })
    panel.querySelector('#rec-call').addEventListener('click', () => {
      close()
      window.dispatchEvent(new CustomEvent('goto-view', { detail: 'calls' }))
    })
  }
  await render()
}
