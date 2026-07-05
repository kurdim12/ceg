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
  unresponsive_email: 'Unresponsive',
  no_valid_email: 'No valid email',
  dropped: 'Dropped',
}

function esc(text) {
  const div = document.createElement('div')
  div.textContent = text ?? ''
  return div.innerHTML
}

function initials(name) {
  return (name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('')
}

export async function renderLeads(root) {
  let companies = []
  let search = ''
  let stageFilter = null

  root.innerHTML = `
    <div class="stat-row" id="lead-stats"></div>
    <div class="toolbar">
      <input type="search" id="lead-search" placeholder="Search companies…" />
      <div class="filter-chips" id="stage-chips"></div>
    </div>
    <div class="view-actions">
      <button class="secondary" id="run-sourcing">Find new leads…</button>
      <button class="ghost" id="demo-reset">Regenerate demo data</button>
    </div>
    <div id="sourcing-form"></div>
    <div id="lead-table"></div>
    <div id="lead-detail"></div>`

  root.querySelector('#lead-search').addEventListener('input', (e) => {
    search = e.target.value.toLowerCase()
    drawTable()
  })

  root.querySelector('#demo-reset').addEventListener('click', async (e) => {
    e.target.disabled = true
    try {
      const result = await api.post('/api/demo/reset')
      toast(`Demo data regenerated: ${result.companies} companies`, 'success')
      await load()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      e.target.disabled = false
    }
  })

  root.querySelector('#run-sourcing').addEventListener('click', () => {
    const holder = root.querySelector('#sourcing-form')
    if (holder.innerHTML !== '') { holder.innerHTML = ''; return }
    holder.innerHTML = `
      <div class="card form-row">
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
        await load()
      } catch (err) {
        toast(err.message, 'error')
        e.target.disabled = false
      }
    })
  })

  function drawStats() {
    const count = (stages) => companies.filter((c) => stages.includes(c.stage)).length
    const tiles = [
      ['In pipeline', companies.length, 'all leads'],
      ['Active outreach', count(['new', 'email_sequence']), 'new + in sequence'],
      ['Engaged', count(['replied', 'meeting_booked', 'deal']), 'replied → deal'],
      ['Won', count(['won']), 'closed'],
      ['Needs a call', count(['no_valid_email', 'unresponsive_email']), 'in call queues'],
    ]
    root.querySelector('#lead-stats').innerHTML = tiles
      .map(([k, v, c]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div><div class="c">${c}</div></div>`)
      .join('')
  }

  function drawChips() {
    const present = [...new Set(companies.map((c) => c.stage))]
    root.querySelector('#stage-chips').innerHTML = [
      `<button class="${stageFilter === null ? 'on' : ''}" data-stage="">All</button>`,
      ...present.map(
        (s) => `<button class="${stageFilter === s ? 'on' : ''}" data-stage="${s}">${STAGE_LABELS[s] ?? s}</button>`,
      ),
    ].join('')
    root.querySelectorAll('#stage-chips button').forEach((b) => {
      b.addEventListener('click', () => {
        stageFilter = b.dataset.stage === '' ? null : b.dataset.stage
        drawChips()
        drawTable()
      })
    })
  }

  function drawTable() {
    const rows = companies.filter(
      (c) =>
        (stageFilter === null || c.stage === stageFilter) &&
        (search === '' || c.name.toLowerCase().includes(search) || (c.city ?? '').toLowerCase().includes(search)),
    )
    const container = root.querySelector('#lead-table')
    if (companies.length === 0) {
      container.innerHTML = `
        <div class="card empty">
          <div class="glyph">🌱</div>
          <div class="t">No leads yet</div>
          <div class="d">Run sourcing to find businesses, or regenerate the demo data to explore every screen safely.</div>
        </div>`
      return
    }
    if (rows.length === 0) {
      container.innerHTML = '<div class="card empty"><div class="t">Nothing matches</div><div class="d">Try clearing the search or the stage filter.</div></div>'
      return
    }
    container.innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Company</th><th>City</th><th>Stage</th><th>Assignee</th><th>Contacts</th><th>Phone</th>
        </tr></thead>
        <tbody>
          ${rows
            .map(
              (c) => `
            <tr class="clickable" data-id="${c.id}">
              <td><span class="co"><span class="ini">${esc(initials(c.name))}</span><span class="nm">${esc(c.name)}</span>${c.isDemo ? '<span class="demo-tag">DEMO</span>' : ''}</span></td>
              <td>${esc(c.city ?? '—')}</td>
              <td><span class="chip ${esc(c.stage)}">${esc(STAGE_LABELS[c.stage] ?? c.stage)}</span></td>
              <td>${esc(c.assigneeName ?? 'Unassigned')}</td>
              <td class="num">${c.contactCount}</td>
              <td class="num">${esc(c.phone ?? '—')}${c.phoneConfirmed ? ' ✓' : ''}</td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table></div>`
    container.querySelectorAll('tr.clickable').forEach((row) => {
      row.addEventListener('click', () => drawDetail(row.dataset.id))
    })
  }

  async function drawDetail(id) {
    const { activities } = await api.get(`/api/companies/${id}/activities`)
    const company = companies.find((c) => String(c.id) === String(id))
    const detail = root.querySelector('#lead-detail')
    detail.innerHTML = `
      <h2>${esc(company?.name ?? 'Lead')} — activity</h2>
      <div class="card">
        ${
          activities.length === 0
            ? '<div class="hint">No activity yet for this lead.</div>'
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
    detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  async function load() {
    const data = await api.get('/api/companies')
    companies = data.companies
    drawStats()
    drawChips()
    drawTable()
  }

  await load()
}
