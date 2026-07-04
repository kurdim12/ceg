import { api } from '../api.js'
import { toast } from '../toast.js'

const STAGE_LABELS = {
  new: 'New',
  email_sequence: 'In sequence',
  replied: 'Replied',
  meeting_booked: 'Meeting booked',
  deal: 'Deal',
  won: 'Won',
  lost: 'Lost',
  unresponsive_email: 'Unresponsive (email)',
  no_valid_email: 'No valid email',
  dropped: 'Dropped',
}

function esc(text) {
  const div = document.createElement('div')
  div.textContent = text ?? ''
  return div.innerHTML
}

export async function renderLeads(root) {
  root.innerHTML = `
    <div class="view-actions">
      <button class="secondary" id="demo-reset">Regenerate demo data</button>
      <button class="secondary" id="run-sourcing">Find new leads…</button>
    </div>
    <div id="sourcing-form"></div>
    <div id="lead-table">Loading…</div>
    <div id="lead-detail"></div>`

  root.querySelector('#demo-reset').addEventListener('click', async (e) => {
    e.target.disabled = true
    try {
      const result = await api.post('/api/demo/reset')
      toast(`Demo data regenerated: ${result.companies} companies`, 'success')
      await drawTable()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      e.target.disabled = false
    }
  })

  root.querySelector('#run-sourcing').addEventListener('click', () => {
    const holder = root.querySelector('#sourcing-form')
    holder.innerHTML = `
      <div class="panel form-row">
        <label>Where (city or region)<input id="src-geo" placeholder="e.g. Lisbon" /></label>
        <label>Business type<input id="src-type" placeholder="e.g. specialty coffee roasters" /></label>
        <label>How many<input id="src-count" type="number" value="10" min="1" max="100" /></label>
        <button id="src-go">Run sourcing</button>
      </div>`
    holder.querySelector('#src-go').addEventListener('click', async (e) => {
      e.target.disabled = true
      try {
        const result = await api.post('/api/sourcing/run', {
          geo: holder.querySelector('#src-geo').value,
          businessType: holder.querySelector('#src-type').value,
          count: Number(holder.querySelector('#src-count').value),
        })
        toast(`Sourcing done: ${result.tally.created} new, ${result.tally.deduped} duplicates skipped`, 'success')
        holder.innerHTML = ''
        await drawTable()
      } catch (err) {
        toast(err.message, 'error')
        e.target.disabled = false
      }
    })
  })

  async function drawTable() {
    const { companies } = await api.get('/api/companies')
    const container = root.querySelector('#lead-table')
    if (companies.length === 0) {
      container.innerHTML =
        '<div class="panel">No leads yet. Regenerate demo data to explore, or run sourcing.</div>'
      return
    }
    container.innerHTML = `
      <table>
        <thead><tr>
          <th>Company</th><th>City</th><th>Stage</th><th>Assignee</th><th>Contacts</th><th>Phone</th>
        </tr></thead>
        <tbody>
          ${companies
            .map(
              (c) => `
            <tr class="clickable" data-id="${c.id}">
              <td>${esc(c.name)}${c.isDemo ? '<span class="demo-tag">demo</span>' : ''}</td>
              <td>${esc(c.city ?? '—')}</td>
              <td><span class="chip ${esc(c.stage)}">${esc(STAGE_LABELS[c.stage] ?? c.stage)}</span></td>
              <td>${esc(c.assigneeName ?? 'Unassigned')}</td>
              <td>${c.contactCount}</td>
              <td>${esc(c.phone ?? '—')}${c.phoneConfirmed ? ' ✓' : ''}</td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>`
    container.querySelectorAll('tr.clickable').forEach((row) => {
      row.addEventListener('click', () => drawDetail(row.dataset.id))
    })
  }

  async function drawDetail(id) {
    const { activities } = await api.get(`/api/companies/${id}/activities`)
    const detail = root.querySelector('#lead-detail')
    detail.innerHTML = `
      <h2>Activity trail</h2>
      <div class="panel">
        ${
          activities.length === 0
            ? '<div class="sub">No activity yet for this lead.</div>'
            : activities
                .map(
                  (a) => `
          <div class="activity">
            <div>${esc(a.kind.replaceAll('_', ' '))}</div>
            <div class="meta">${esc(a.actor)} · ${esc(a.createdAt)} UTC</div>
          </div>`,
                )
                .join('')
        }
      </div>`
  }

  await drawTable()
}
