import { api, ApiError } from './api.js'
import { renderLogin } from './views/login.js'
import { renderLeads } from './views/leads.js'
import { renderCalls } from './views/calls.js'
import { renderDrafts } from './views/drafts.js'
import { renderInbox } from './views/inbox.js'
import { renderAgent } from './views/agent.js'
import { renderRecap } from './views/recap.js'
import { renderSettings } from './views/settings.js'

const app = document.getElementById('app')

const ICONS = {
  leads: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h18M3 12h18M3 17h12"/></svg>',
  calls: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.2a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>',
  drafts: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>',
  inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z"/></svg>',
  agent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.3-.7L3 21l1.8-5.7A8.4 8.4 0 1 1 21 11.5z"/></svg>',
  recap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M7 13l4-4 4 4 5-6"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.5 1z"/></svg>',
}

const VIEWS = {
  leads: { label: 'Leads', icon: 'leads', title: 'Leads', sub: 'Every company in the pipeline, newest activity first.', render: renderLeads },
  calls: { label: 'Call queue', icon: 'calls', title: 'Call queue', sub: 'Leads that need a phone call — one screen per lead.', render: renderCalls },
  drafts: { label: 'Review drafts', icon: 'drafts', title: 'Review drafts', sub: 'Emails waiting for your approval before anything sends.', render: renderDrafts },
  inbox: { label: 'Inbox', icon: 'inbox', title: 'Inbox', sub: 'Replies from leads, classified automatically.', render: renderInbox },
  agent: { label: 'Assistant', icon: 'agent', title: 'Assistant', sub: 'Ask about your pipeline in plain language.', render: renderAgent },
  recap: { label: 'Daily recap', icon: 'recap', title: 'Daily recap', sub: 'The last 24 hours at a glance.', render: renderRecap },
  settings: { label: 'Settings', icon: 'settings', title: 'Settings', sub: 'Sending rules, connections, keys, and safety switches.', render: renderSettings },
}

let current = 'leads'
let draftCount = 0

function esc(text) {
  const div = document.createElement('div')
  div.textContent = text ?? ''
  return div.innerHTML
}

function initials(name) {
  return (name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('')
}

async function renderShell(me) {
  const [status, alerts, drafts] = await Promise.all([
    api.get('/api/status').catch(() => null),
    api.get('/api/alerts').catch(() => ({ alerts: [] })),
    api.get('/api/messages/drafts').catch(() => ({ drafts: [] })),
  ])
  draftCount = drafts.drafts?.length ?? 0

  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="mark">M</div>
          <div>
            <div class="name">Maranasi</div>
            <div class="env">Outreach engine</div>
          </div>
        </div>
        <nav class="nav">
          ${Object.entries(VIEWS)
            .map(
              ([key, v]) => `
            <button class="${key === current ? 'active' : ''}" data-view="${key}">
              ${ICONS[v.icon]}<span>${v.label}</span>
              ${key === 'drafts' && draftCount > 0 ? `<span class="badge">${draftCount}</span>` : ''}
            </button>`,
            )
            .join('')}
        </nav>
        ${status?.dryRun ? '<div class="dry-pill">⏸ Dry run — no emails leave the system</div>' : ''}
        <div class="user-box">
          <div class="avatar">${esc(initials(me.name))}</div>
          <div class="who">
            <div class="n">${esc(me.name)}</div>
            <div class="e">${esc(me.email)}</div>
          </div>
          <button class="out" id="logout" title="Sign out" aria-label="Sign out">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>
          </button>
        </div>
      </aside>
      <main class="content">
        ${
          alerts.alerts.length > 0
            ? `<div class="alert-banner">${alerts.alerts
                .map((a) => `<div class="alert ${a.kind === 'breaker_tripped' ? 'critical' : ''}"><span class="ic">${a.kind === 'breaker_tripped' ? '⛔' : '⚠️'}</span><span>${esc(a.message)}</span></div>`)
                .join('')}</div>`
            : ''
        }
        <div class="page-head">
          <h1>${VIEWS[current].title}</h1>
          <div class="sub">${VIEWS[current].sub}</div>
        </div>
        <div id="view"></div>
      </main>
    </div>`

  app.querySelector('#logout').addEventListener('click', async () => {
    await api.post('/api/auth/logout')
    boot()
  })
  app.querySelectorAll('.nav button').forEach((tab) => {
    tab.addEventListener('click', () => {
      current = tab.dataset.view
      renderShell(me)
    })
  })

  const viewRoot = app.querySelector('#view')
  viewRoot.innerHTML = '<div class="skeleton"></div>'
  await VIEWS[current].render(viewRoot, { me, reload: () => renderShell(me) })
}

export async function boot() {
  try {
    const me = await api.get('/api/me')
    await renderShell(me)
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      renderLogin(app, boot)
    } else {
      app.innerHTML = '<div class="empty"><div class="glyph">🔌</div><div class="t">Could not load the dashboard</div><div class="d">Refresh the page to retry.</div></div>'
    }
  }
}

boot()
