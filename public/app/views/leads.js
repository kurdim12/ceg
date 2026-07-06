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
const STAGE_COLORS = {
  new: '#2563EB', email_sequence: '#D9820A', replied: '#0EA371', meeting_booked: '#0EA5B5',
  deal: '#7C5CFC', won: '#0A7A55', lost: '#C13438',
  unresponsive_email: '#8A93A2', no_valid_email: '#D9820A', dropped: '#8A93A2',
}

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

  let mode = 'list'

  root.innerHTML = `
    <div class="toolbar">
      <input type="search" id="lead-search" placeholder="Search companies…" aria-label="Search companies" />
      <div class="segmented" id="stage-chips"></div>
      <div class="segmented view-toggle" id="view-toggle" style="margin-left:auto">
        <button class="on" data-mode="list" aria-label="List view"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg> List</button>
        <button data-mode="board" aria-label="Board view"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="11" rx="1"/><rect x="17" y="4" width="4" height="14" rx="1"/></svg> Board</button>
      </div>
    </div>
    <div class="view-actions">
      <button id="add-lead">Add lead</button>
      <button class="secondary" id="run-sourcing">Find new leads</button>
      <button class="ghost" id="demo-reset">Regenerate demo data</button>
    </div>
    <div id="sourcing-form"></div>
    <div id="lead-table"></div>
    <div id="lead-detail"></div>`

  root.querySelector('#lead-search').addEventListener('input', (e) => {
    search = e.target.value.toLowerCase()
    render()
  })

  root.querySelectorAll('#view-toggle button').forEach((b) => {
    b.addEventListener('click', () => {
      mode = b.dataset.mode
      root.querySelectorAll('#view-toggle button').forEach((x) => x.classList.toggle('on', x === b))
      root.querySelector('#stage-chips').style.display = mode === 'board' ? 'none' : ''
      root.querySelector('#lead-detail').innerHTML = ''
      render()
    })
  })

  function render() {
    if (mode === 'board') drawBoard()
    else drawTable()
  }

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

  root.querySelector('#add-lead').addEventListener('click', () => openAddLead(async (id) => {
    await load()
    if (id) openRecord(String(id), load)
  }))

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
        toast(
          `Sourcing done — ${result.tally.candidates} candidate${result.tally.candidates === 1 ? '' : 's'} to review, ${result.tally.deduped} already queued. Open Candidates to approve.`,
          'success',
        )
        holder.innerHTML = ''
        window.dispatchEvent(new CustomEvent('goto-view', { detail: 'candidates' }))
      } catch (err) {
        toast(err.message, 'error')
        e.target.disabled = false
      }
    })
  })

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
          await api.delete(`/api/companies/${id}?rev=${c?.rev ?? 0}`)
          toast('Lead deleted', 'success')
          await load()
        } catch (err) {
          toast(err.message, 'error')
          await load() // a 409 means it changed underneath — refresh to current
        }
      })
    })
  }

  const BOARD_ORDER = STAGES.map(([v]) => v)

  function drawBoard() {
    const container = root.querySelector('#lead-table')
    const filtered = companies.filter(
      (c) => search === '' || c.name.toLowerCase().includes(search) || (c.city ?? '').toLowerCase().includes(search),
    )
    if (companies.length === 0) {
      container.innerHTML = `<div class="card empty"><div class="t">No leads yet</div><div class="d">Run sourcing or regenerate demo data to fill the board.</div></div>`
      return
    }
    const byStage = Object.fromEntries(BOARD_ORDER.map((s) => [s, []]))
    for (const c of filtered) (byStage[c.stage] ??= []).push(c)
    // Only show columns that are core pipeline or currently hold a lead.
    const CORE = ['new', 'email_sequence', 'replied', 'meeting_booked', 'deal', 'won', 'lost']
    const cols = BOARD_ORDER.filter((s) => CORE.includes(s) || byStage[s].length > 0)

    container.innerHTML = `<div class="kanban">${cols.map((s) => `
      <div class="lane" data-stage="${s}">
        <div class="lane-head"><span class="dot" style="background:${STAGE_COLORS[s]}"></span>${STAGE_LABELS[s]}<span class="cnt">${byStage[s].length}</span></div>
        <div class="lane-body" data-stage="${s}">
          ${byStage[s].map((c) => `
            <div class="kanban-card" draggable="true" data-id="${c.id}">
              <div class="kc-top"><span class="ini" style="background:${hue(c.id)}">${esc(initials(c.name))}</span><span class="kc-name">${esc(c.name)}</span></div>
              <div class="kc-meta">${esc(c.city ?? '—')}${c.assigneeName ? ' · ' + esc(c.assigneeName) : ''}</div>
              ${c.timezone ? `<div class="kc-time">${timeChip(c.timezone)}</div>` : ''}
            </div>`).join('')}
        </div>
      </div>`).join('')}</div>`

    let dragId = null
    container.querySelectorAll('.kanban-card').forEach((card) => {
      card.addEventListener('click', () => openRecord(card.dataset.id, load))
      card.addEventListener('dragstart', (e) => { dragId = card.dataset.id; card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move' })
      card.addEventListener('dragend', () => card.classList.remove('dragging'))
    })
    container.querySelectorAll('.lane-body').forEach((lane) => {
      lane.addEventListener('dragover', (e) => { e.preventDefault(); lane.classList.add('drop') })
      lane.addEventListener('dragleave', () => lane.classList.remove('drop'))
      lane.addEventListener('drop', async (e) => {
        e.preventDefault()
        lane.classList.remove('drop')
        const to = lane.dataset.stage
        const c = companies.find((x) => String(x.id) === String(dragId))
        if (!c || c.stage === to) return
        const from = c.stage
        c.stage = to
        drawBoard()
        try {
          await api.put(`/api/companies/${dragId}/stage`, { stage: to })
          toast(`${c.name} → ${STAGE_LABELS[to]}`, 'success')
        } catch (err) {
          c.stage = from
          drawBoard()
          toast(err.message, 'error')
        }
      })
    })
  }

  async function load() {
    const data = await api.get('/api/companies')
    companies = data.companies
    drawChips()
    render()
  }

  await load()
  void ctx
}

/**
 * "Add lead" modal — a manual company create. Name is required; every other
 * field is optional. Assignees come from /api/users. onDone(newId) fires on
 * a successful create.
 */
async function openAddLead(onDone = () => {}) {
  let users = []
  try {
    users = (await api.get('/api/users')).users
  } catch {
    /* assignee stays optional if the list can't load */
  }
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal panel" role="dialog" aria-modal="true" aria-label="Add lead">
      <h2>Add a lead</h2>
      <form id="add-lead-form">
        <label>Company name <span style="color:var(--red)">*</span>
          <input id="al-name" required maxlength="200" placeholder="e.g. Harbor Textiles" autocomplete="off" />
        </label>
        <div class="form-grid">
          <label>Business type<input id="al-type" placeholder="e.g. textile manufacturer" /></label>
          <label>Phone<input id="al-phone" placeholder="+1 212 555 0100" /></label>
          <label>City<input id="al-city" placeholder="e.g. New York" /></label>
          <label>Country<input id="al-country" placeholder="e.g. US" /></label>
        </div>
        <label>Website<input id="al-website" placeholder="example.com" /></label>
        <label>Assignee
          <select id="al-assignee">
            <option value="">Unassigned</option>
            ${users.map((u) => `<option value="${u.id}">${escAttr(u.name)}</option>`).join('')}
          </select>
        </label>
        <p class="error-text" id="al-error"></p>
        <div class="modal-actions">
          <button type="button" class="secondary" id="al-cancel">Cancel</button>
          <button type="submit" id="al-save">Create lead</button>
        </div>
      </form>
    </div>`
  document.body.appendChild(overlay)
  const err = overlay.querySelector('#al-error')
  const close = () => overlay.remove()
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
  overlay.querySelector('#al-cancel').addEventListener('click', close)
  overlay.querySelector('#al-name').focus()

  overlay.querySelector('#add-lead-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    err.textContent = ''
    const name = overlay.querySelector('#al-name').value.trim()
    if (!name) { err.textContent = 'A company name is required.'; return }
    const assignee = overlay.querySelector('#al-assignee').value
    const save = overlay.querySelector('#al-save')
    save.disabled = true
    save.textContent = 'Creating…'
    try {
      const res = await api.post('/api/companies', {
        name,
        businessType: overlay.querySelector('#al-type').value.trim() || undefined,
        phone: overlay.querySelector('#al-phone').value.trim() || undefined,
        city: overlay.querySelector('#al-city').value.trim() || undefined,
        country: overlay.querySelector('#al-country').value.trim() || undefined,
        website: overlay.querySelector('#al-website').value.trim() || undefined,
        assigneeId: assignee ? Number(assignee) : undefined,
      })
      toast(`${name} added`, 'success')
      close()
      onDone(res.id)
    } catch (e2) {
      err.textContent = e2.message
      save.disabled = false
      save.textContent = 'Create lead'
    }
  })
}

function escAttr(text) {
  const div = document.createElement('div')
  div.textContent = text ?? ''
  return div.innerHTML
}
