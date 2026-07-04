import { api, ApiError } from './api.js'
import { renderLogin } from './views/login.js'
import { renderLeads } from './views/leads.js'

const app = document.getElementById('app')

export async function boot() {
  try {
    const me = await api.get('/api/me')
    renderLeads(app, me, boot)
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      renderLogin(app, boot)
    } else {
      app.textContent = 'Something went wrong loading the dashboard. Refresh to retry.'
    }
  }
}

boot()
