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

const VIEWS = {
  leads: { label: 'Leads', render: renderLeads },
  calls: { label: 'Call queue', render: renderCalls },
  drafts: { label: 'Review drafts', render: renderDrafts },
  inbox: { label: 'Inbox', render: renderInbox },
  agent: { label: 'Assistant', render: renderAgent },
  recap: { label: 'Daily recap', render: renderRecap },
  settings: { label: 'Settings', render: renderSettings },
}

let current = 'leads'

function esc(text) {
  const div = document.createElement('div')
  div.textContent = text ?? ''
  return div.innerHTML
}

async function renderShell(me) {
  const status = await api.get('/api/status').catch(() => null)
  const alerts = await api.get('/api/alerts').catch(() => ({ alerts: [] }))

  app.innerHTML = `
    <div class="topbar">
      <div>
        <h1>Maranasi Engine ${status?.dryRun ? '<span class="chip dry-run">DRY RUN — no emails go out</span>' : ''}</h1>
        <div class="who">Signed in as ${esc(me.name)}</div>
      </div>
      <button class="secondary" id="logout">Sign out</button>
    </div>
    ${alerts.alerts.length > 0
      ? `<div class="alert-banner">${alerts.alerts.map((a) => `<div>⚠ ${esc(a.message)}</div>`).join('')}</div>`
      : ''}
    <nav class="tabs">
      ${Object.entries(VIEWS)
        .map(([key, v]) => `<button class="tab ${key === current ? 'active' : ''}" data-view="${key}">${v.label}</button>`)
        .join('')}
    </nav>
    <div id="view"></div>`

  app.querySelector('#logout').addEventListener('click', async () => {
    await api.post('/api/auth/logout')
    boot()
  })
  app.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      current = tab.dataset.view
      renderShell(me)
    })
  })

  const viewRoot = app.querySelector('#view')
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
      app.textContent = 'Something went wrong loading the dashboard. Refresh to retry.'
    }
  }
}

boot()
