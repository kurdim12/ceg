import { api } from '../api.js'
import { toast } from '../toast.js'
import { timeChip } from '../timechip.js'
import { confirmModal } from '../modal.js'
import { openRecord } from '../drawer.js'

const STAGES = [
  ['new', 'New'],
  ['email_sequence', 'In sequence'],
  ['replied', 'Replied'],
  ['meeting_booked', 'Meeting booked'],
  ['deal', 'Deal'],
  ['won', 'Won'],
  ['lost', 'Lost'],
  ['unresponsive_email', 'Unresponsive'],
  ['no_valid_email', 'No valid email'],
  ['dropped', 'Dropped'],
]
const STAGE_LABELS = Object.fromEntries(STAGES)

const EMPTY_BY_STAGE = {
  unresponsive_email: 'No leads are unresponsive. Good.',
  no_valid_email: 'Every lead has a working email right now.',
  lost: 'Nothing lost. Keep it that way.',
  dropped: 'The drop pool is empty.',
}

const AVATAR_HUES = ['#2563EB', '#7C5CFC', '#0EA5B5', '#0EA371', '#D9820A', '#E5484D']

function esc(text) {
  const div = document.createElement('div')
  div.textContent = text ?? ''
  return div.innerHTML
}
function initials(name) {
  return (name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('')
}
function hue(id) {
  return AVATAR_HUES[id % AVATAR_HUES.length]
}

export async function renderLeads(root, ctx) {
  let companies = []
  let search = ''
  let stageFilter = null

  root.innerHTML = `
    <div class="stat-row" id="lead-stats"></div>
    <div class="toolbar">
      <input type="search" id="lead-search" placeholder="Search companies…" aria-label="Search companies" />
      <div class="segmented" id="stage-chips"></div>
    </div>
    <div class="view-actions">
      <button id="run-sourcing">Find new leads</button>
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
      toast(`Demo data regenerated — ${result.companies} companies`, 'success')
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
        toast(`Sourcing done — ${result.tally.created} new, ${result.tally.deduped} duplicates skipped`, 'success')
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
      ['In pipeline', companies.length, 'all leads', true],
      ['Active outreach', count(['new', 'email_sequence']), 'new + in sequence'],
      ['Engaged', count(['replied', 'meeting_booked', 'deal']), 'replied through deal'],
      ['Won', count(['won']), 'closed'],
      ['Needs a call', count(['no_valid_email', 'unresponsive_email']), 'in call queues'],
    ]
    root.querySelector('#lead-stats').innerHTML = tiles
      .map(([k, v, c, accent]) => `<div class="stat${accent ? ' accent' : ''}"><div class="k">${k}</div><div class="v">${v}</div><div class="c">${c}</div></div>`)
      .join('')
  }

  function drawChips() {
    const present = [...new Set(companies.map((c) => c.stage))]
    root.querySelector('#stage-chips').innerHTML = [
      `<button class="${stageFilter === null ? 'on' : ''}" data-stage="">All</button>`,
      ...present.map((s) => `<button class="${stageFilter === s ? 'on' : ''}" data-stage="${s}">${STAGE_LABELS[s] ?? s}</button>`),
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
          <div class="glyph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2v20M2 12h20"/></svg></div>
          <div class="t">No leads yet</div>
          <div class="d">Run sourcing to find businesses, or regenerate the demo data to explore every screen safely.</div>
          <button id="empty-source">Find new leads</button>
        </div>`
      container.querySelector('#empty-source').addEventListener('click', () => root.querySelector('#run-sourcing').click())
      return
    }
    if (rows.length === 0) {
      const line = (stageFilter && EMPTY_BY_STAGE[stageFilter]) || 'Nothing matches. Clear the search or pick another stage.'
      container.innerHTML = `<div class="card empty"><div class="t">${line}</div></div>`
      return
    }
    container.innerHTML = `
      <div class="table-wrap"><div class="table-scroll"><table class="leads-table">
        <thead><tr>
          <th>Company</th><th>City</th><th>Stage</th><th>Their time</th><th>Assignee</th><th class="num">Contacts</th><th class="num">Phone</th><th></th>
        </tr></thead>
        <tbody>
          ${rows.map((c) => `
            <tr data-id="${c.id}">
              <td><span class="co"><span class="ini" style="background:${hue(c.id)}">${esc(initials(c.name))}</span><span class="nm link" data-open="${c.id}">${esc(c.name)}</span>${c.isDemo ? '<span class="demo-tag">demo</span>' : ''}</span></td>
              <td class="hide-m">${esc(c.city ?? '—')}</td>
              <td>
                <span class="stage-select">
                  <select data-stage-for="${c.id}" aria-label="Change stage">
                    ${STAGES.map(([v, l]) => `<option value="${v}" ${v === c.stage ? 'selected' : ''}>${l}</option>`).join('')}
                  </select>
                </span>
              </td>
              <td class="hide-m">${timeChip(c.timezone)}</td>
              <td class="hide-m">${esc(c.assigneeName ?? 'Unassigned')}</td>
              <td class="num hide-m">${c.contactCount}</td>
              <td class="num">${esc(c.phone ?? '—')}${c.phoneConfirmed ? ' ✓' : ''}</td>
              <td><span class="row-actions"><button class="icon-btn" data-del="${c.id}" title="Delete lead" aria-label="Delete lead"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button></span></td>
            </tr>`).join('')}
        </tbody>
      </table></div></div>`

    container.querySelectorAll('[data-open]').forEach((el) =>
      el.addEventListener('click', () => openRecord(el.dataset.open, load)))

    container.querySelectorAll('select[data-stage-for]').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const id = sel.dataset.stageFor
        try {
          await api.put(`/api/companies/${id}/stage`, { stage: sel.value })
          const c = companies.find((x) => String(x.id) === String(id))
          if (c) c.stage = sel.value
          toast(`Moved to ${STAGE_LABELS[sel.value]}`, 'success')
          drawStats()
        } catch (err) {
          toast(err.message, 'error')
          await load()
        }
      })
    })

    container.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.del
        const c = companies.find((x) => String(x.id) === String(id))
        const go = await confirmModal({
          title: `Delete ${c?.name ?? 'this lead'}?`,
          body: 'This permanently removes the company and everything attached to it — contacts, emails, calls, deals. There is no undo.',
          confirmLabel: 'Delete permanently',
          danger: true,
        })
        if (!go) return
        try {
          await api.delete(`/api/companies/${id}`)
          toast('Lead deleted', 'success')
          await load()
        } catch (err) {
          toast(err.message, 'error')
        }
      })
    })
  }

  async function load() {
    const data = await api.get('/api/companies')
    companies = data.companies
    drawStats()
    drawChips()
    drawTable()
  }

  await load()
  void ctx
}
