import { api, ApiError } from './api.js'
import { tickTimeChips } from './timechip.js'
import { renderLogin } from './views/login.js'
import { renderLeads } from './views/leads.js'
import { renderCandidates } from './views/candidates.js'
import { renderCalls } from './views/calls.js'
import { renderDrafts } from './views/drafts.js'
import { renderInbox } from './views/inbox.js'
import { renderCalendar } from './views/calendar.js'
import { mountAssistant, setAssistantContext, openAssistant } from './assistant.js'
import { renderRecap } from './views/recap.js'
import { renderSettings } from './views/settings.js'
import { renderDeals } from './views/deals.js'

const app = document.getElementById('app')

const I = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`
const ICONS = {
  leads: I('<path d="M3 7h18M3 12h18M3 17h12"/>'),
  candidates: I('<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
  calls: I('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.2a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.8.7a2 2 0 0 1 1.7 2z"/>'),
  drafts: I('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/>'),
  inbox: I('<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z"/>'),
  calendar: I('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'),
  agent: I('<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.3-.7L3 21l1.8-5.7A8.4 8.4 0 1 1 21 11.5z"/>'),
  recap: I('<path d="M3 3v18h18"/><path d="M7 13l4-4 4 4 5-6"/>'),
  deals: I('<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="10" rx="1"/><rect x="17" y="4" width="4" height="13" rx="1"/>'),
  settings: I('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/>'),
  more: I('<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>'),
}

const VIEWS = {
  leads: { label: 'Leads', icon: 'leads', group: 'Work', title: 'Leads', sub: 'Every company in the pipeline, newest activity first.', render: renderLeads },
  candidates: { label: 'Candidates', icon: 'candidates', group: 'Work', title: 'Lead candidates', sub: 'Sourced businesses awaiting your review. Approve to create a CRM lead — never sends email.', render: renderCandidates },
  calls: { label: 'Call queue', icon: 'calls', group: 'Work', title: 'Call queue', sub: 'Leads that need a phone call — one screen per lead.', render: renderCalls },
  drafts: { label: 'Review drafts', icon: 'drafts', group: 'Work', title: 'Review drafts', sub: 'Emails waiting for your approval before anything sends.', render: renderDrafts },
  inbox: { label: 'Inbox', icon: 'inbox', group: 'Work', title: 'Inbox', sub: 'Replies from leads, classified automatically.', render: renderInbox },
  calendar: { label: 'Calendar', icon: 'calendar', group: 'Work', title: 'Calendar', sub: 'Every booked meeting, laid out by day.', render: renderCalendar },
  agent: { label: 'Assistant', icon: 'agent', group: 'Intelligence', title: 'Assistant', sub: 'Ask about your pipeline in plain language.', render: (root) => { root.innerHTML = ''; openAssistant() } },
  recap: { label: 'Daily recap', icon: 'recap', group: 'Intelligence', title: 'Daily recap', sub: 'The last 24 hours at a glance.', render: renderRecap },
  deals: { label: 'Deals', icon: 'deals', group: 'System', title: 'Deals', sub: 'Open, won, and lost deals with amounts.', render: renderDeals },
  settings: { label: 'Settings', icon: 'settings', group: 'System', title: 'Settings', sub: 'Sending rules, connections, keys, and safety switches.', render: renderSettings },
}
const GROUPS = ['Work', 'Intelligence', 'System']
const TABBAR = ['leads', 'calls', 'drafts', 'recap']

let current = 'leads'
let ticker = null
let gotoHandler = null

function esc(text) {
  const div = document.createElement('div')
  div.textContent = text ?? ''
  return div.innerHTML
}

function initials(name) {
  return (name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('')
}

function statusStrip(alerts) {
  const keyAlert = alerts.find((a) => a.kind === 'api_key_missing')
  const others = alerts.filter((a) => a.kind !== 'api_key_missing')
  const pendingKeys = keyAlert ? (keyAlert.message.match(/[A-Z_]{6,}/g) ?? []) : []

  const summaryBits = []
  if (pendingKeys.length > 0) summaryBits.push(`<span class="pill hold">${pendingKeys.length} connection${pendingKeys.length === 1 ? '' : 's'} pending</span> <span>everything fail-safe</span>`)
  if (others.length > 0) summaryBits.push(`<span class="alarm-line">${others.length} alarm${others.length === 1 ? '' : 's'}</span>`)
  if (summaryBits.length === 0) return `<div class="status-strip"><span class="pill ok">All systems go</span></div>`

  return `
    <details class="status-strip">
      <summary>${summaryBits.join(' · ')} <svg class="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg></summary>
      <div class="pop">
        ${others.map((a) => `<div class="row alarm-line">${esc(a.message)}</div>`).join('')}
        ${pendingKeys.map((k) => `<div class="row"><span class="k">${esc(k)}</span><span class="chip holding">holding</span></div>`).join('')}
        ${pendingKeys.length > 0 ? '<div class="row hint">Each subsystem waits safely until its key is set in Settings.</div>' : ''}
      </div>
    </details>`
}

function navButton(key, active) {
  const v = VIEWS[key]
  return `<button class="${active ? 'active' : ''}" data-view="${key}">
    ${ICONS[v.icon]}<span>${v.label}</span>
    ${key === 'drafts' && navButton.draftCount > 0 ? `<span class="count">${navButton.draftCount}</span>` : ''}
  </button>`
}
navButton.draftCount = 0

async function renderShell(me) {
  const [status, alerts, drafts] = await Promise.all([
    api.get('/api/status').catch(() => null),
    api.get('/api/alerts').catch(() => ({ alerts: [] })),
    api.get('/api/messages/drafts').catch(() => ({ drafts: [] })),
  ])
  navButton.draftCount = drafts.drafts?.length ?? 0

  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand"><div class="mark">M</div><div><div class="name">Maranasi</div><div class="env">Outreach engine</div></div></div>
        <nav class="nav">
          ${GROUPS.map(
            (g) => `
            <div class="group">${g}</div>
            ${Object.keys(VIEWS).filter((k) => VIEWS[k].group === g).map((k) => navButton(k, k === current)).join('')}`,
          ).join('')}
        </nav>
        <div class="user-box">
          <div class="avatar">${esc(initials(me.name))}</div>
          <div class="who"><div class="n">${esc(me.name)}</div><div class="e">${esc(me.email)}</div></div>
          <button class="out" id="theme-toggle" title="Toggle theme" aria-label="Toggle light or dark theme"></button>
          <button class="out" id="logout" title="Sign out" aria-label="Sign out">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>
          </button>
        </div>
      </aside>
      <main class="content">
        <div class="topbar">
          ${statusStrip(alerts.alerts)}
          <span class="topbar-flags">
            ${status?.sendingPaused ? '<span class="pill danger" title="A human paused all outbound email">Sending paused</span>' : ''}
            ${status?.dryRun ? '<span class="pill hold" title="No emails leave the system while dry run is on">Dry run</span>' : '<span class="pill ok">Live</span>'}
          </span>
        </div>
        <div class="content-inner">
          <div class="page-head">
            <h1>${VIEWS[current].title}</h1>
            <div class="sub">${VIEWS[current].sub}</div>
          </div>
          <div id="view"></div>
        </div>
      </main>
    </div>
    <nav class="tabbar">
      ${TABBAR.map(
        (k) => `<button class="${k === current ? 'active' : ''}" data-view="${k}">${ICONS[VIEWS[k].icon]}<span>${VIEWS[k].label.split(' ')[0]}</span></button>`,
      ).join('')}
      <button id="more-tab">${ICONS.more}<span>More</span></button>
    </nav>`

  const SUN = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
  const MOON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>'
  const themeBtn = app.querySelector('#theme-toggle')
  const paintTheme = () => { themeBtn.innerHTML = document.documentElement.dataset.theme === 'dark' ? SUN : MOON }
  paintTheme()
  themeBtn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    try { localStorage.setItem('theme', next) } catch { /* private mode: session-only */ }
    paintTheme()
  })

  app.querySelector('#logout').addEventListener('click', async () => {
    await api.post('/api/auth/logout')
    boot()
  })
  // Records can ask to jump to another view (e.g. "Open in call screen").
  // One stable handler, replaced each render — never stacked.
  if (gotoHandler) window.removeEventListener('goto-view', gotoHandler)
  gotoHandler = (e) => { if (VIEWS[e.detail]) { current = e.detail; renderShell(me) } }
  window.addEventListener('goto-view', gotoHandler)
  app.querySelectorAll('[data-view]').forEach((tab) => {
    tab.addEventListener('click', () => {
      // The assistant is global — open it in place, don't navigate away.
      if (tab.dataset.view === 'agent') { openAssistant(); return }
      current = tab.dataset.view
      renderShell(me)
    })
  })
  app.querySelector('#more-tab')?.addEventListener('click', () => {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    overlay.innerHTML = `
      <div class="modal">
        <h2>More</h2>
        <div class="sheet-list">
          ${['candidates', 'inbox', 'calendar', 'agent', 'deals', 'settings']
            .map((k) => `<button data-view="${k}">${ICONS[VIEWS[k].icon]}<span>${VIEWS[k].label}</span></button>`)
            .join('')}
        </div>
      </div>`
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove()
      const btn = e.target.closest('[data-view]')
      if (btn) {
        overlay.remove()
        if (btn.dataset.view === 'agent') { openAssistant(); return }
        current = btn.dataset.view
        renderShell(me)
      }
    })
    document.body.appendChild(overlay)
  })

  // The assistant lives above every screen; keep it aware of where we are.
  mountAssistant()
  setAssistantContext({ view: current, record: null })

  const viewRoot = app.querySelector('#view')
  viewRoot.innerHTML = '<div class="skeleton"></div>'
  try {
    await VIEWS[current].render(viewRoot, { me, reload: () => renderShell(me) })
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return boot() // session ended → re-login
    viewRoot.innerHTML = `
      <div class="card empty">
        <div class="t">This screen couldn't load</div>
        <div class="d">${esc(err.message ?? 'Something went wrong.')}</div>
        <button id="view-retry">Try again</button>
      </div>`
    viewRoot.querySelector('#view-retry').addEventListener('click', () => renderShell(me))
  }

  clearInterval(ticker)
  ticker = setInterval(() => tickTimeChips(), 30_000)
}

export async function boot() {
  try {
    const me = await api.get('/api/me')
    await renderShell(me)
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      clearInterval(ticker)
      renderLogin(app, boot)
    } else {
      app.innerHTML = '<div class="empty"><div class="t">Could not load the dashboard</div><div class="d">Refresh the page to retry.</div></div>'
    }
  }
}

boot()
