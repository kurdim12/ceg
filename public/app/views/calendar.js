import { api } from '../api.js'
import { openRecord } from '../drawer.js'

const STAGE_COLORS = {
  new: 'var(--st-new)', email_sequence: 'var(--st-seq)', replied: 'var(--st-replied)',
  meeting_booked: 'var(--st-meeting)', deal: 'var(--st-deal)', won: 'var(--st-won)',
  lost: 'var(--st-lost)', unresponsive_email: 'var(--st-park)', no_valid_email: 'var(--st-park)',
  dropped: 'var(--st-park)',
}

function esc(text) {
  const div = document.createElement('div')
  div.textContent = text ?? ''
  return div.innerHTML
}

/** SQLite stores UTC ("YYYY-MM-DD HH:MM:SS") or ISO ("…Z"); parse to a local Date. */
function toLocal(s) {
  if (!s) return null
  let iso = s.includes('T') ? s : s.replace(' ', 'T')
  if (!/[Zz]|[+-]\d\d:?\d\d$/.test(iso)) iso += 'Z'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? null : d
}

const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })
const agendaFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' })

// Monday-first weekday labels, locale-aware.
const WEEKDAYS = (() => {
  const f = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
  const out = []
  for (let i = 0; i < 7; i++) out.push(f.format(new Date(Date.UTC(2024, 0, 1 + i)))) // 2024-01-01 is a Monday
  return out
})()

export async function renderCalendar(root, ctx) {
  let meetings = []
  const cursor = new Date()
  cursor.setDate(1)
  cursor.setHours(0, 0, 0, 0)

  async function load() {
    const data = await api.get('/api/meetings')
    meetings = (data.meetings ?? []).map((m) => ({ ...m, when: toLocal(m.scheduledAt) }))
    draw()
  }

  function eventsByDay() {
    const map = new Map()
    for (const m of meetings) {
      if (!m.when) continue
      const k = dayKey(m.when)
      if (!map.has(k)) map.set(k, [])
      map.get(k).push(m)
    }
    for (const list of map.values()) list.sort((a, b) => a.when - b.when)
    return map
  }

  function monthGrid(byDay) {
    const year = cursor.getFullYear()
    const month = cursor.getMonth()
    const first = new Date(year, month, 1)
    // Monday-first offset: JS getDay() has Sun=0.
    const lead = (first.getDay() + 6) % 7
    const start = new Date(year, month, 1 - lead)
    const today = new Date()
    const cells = []
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
      const evs = byDay.get(dayKey(d)) ?? []
      const other = d.getMonth() !== month
      const isToday = dayKey(d) === dayKey(today)
      const shown = evs.slice(0, 3)
      cells.push(`
        <div class="cal-cell${other ? ' other' : ''}${isToday ? ' today' : ''}">
          <div class="cal-daynum">${d.getDate()}</div>
          ${shown.map((m) => `
            <button class="cal-ev" data-open="${m.companyId}" title="${esc(m.companyName)} — ${esc(timeFmt.format(m.when))}">
              <span class="dot" style="background:${STAGE_COLORS[m.stage] ?? 'var(--accent)'}"></span>
              <span class="t">${esc(timeFmt.format(m.when))}</span>
              <span class="n">${esc(m.companyName)}</span>
            </button>`).join('')}
          ${evs.length > shown.length ? `<div class="cal-more">+${evs.length - shown.length} more</div>` : ''}
        </div>`)
    }
    // Trim a trailing all-other-month week for a tidier grid.
    const weeks = []
    for (let w = 0; w < 6; w++) weeks.push(cells.slice(w * 7, w * 7 + 7))
    const trimmed = weeks.filter((week, i) => i < 5 || week.some((_, j) => {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i * 7 + j)
      return d.getMonth() === month
    }))
    return `
      <div class="cal-weekdays">${WEEKDAYS.map((w) => `<div>${esc(w)}</div>`).join('')}</div>
      <div class="cal-grid">${trimmed.flat().join('')}</div>`
  }

  function agenda() {
    const now = new Date()
    const upcoming = meetings.filter((m) => m.when && m.when >= now).sort((a, b) => a.when - b.when).slice(0, 8)
    const unscheduled = meetings.filter((m) => !m.when)
    if (upcoming.length === 0 && unscheduled.length === 0) return ''
    return `
      <h2>Upcoming</h2>
      <div class="card">
        ${upcoming.length === 0 ? '<div class="hint">No upcoming meetings.</div>' : upcoming.map((m) => `
          <div class="drop-row" style="cursor:pointer" data-open="${m.companyId}">
            <span><strong>${esc(m.companyName)}</strong>${m.contactName ? ` · ${esc(m.contactName)}` : ''}
              ${m.assigneeName ? `<span class="hint"> · ${esc(m.assigneeName)}</span>` : ''}</span>
            <span class="chip ${esc(m.stage)}" style="pointer-events:none">${esc(agendaFmt.format(m.when))}, ${esc(timeFmt.format(m.when))}</span>
          </div>`).join('')}
        ${unscheduled.length > 0 ? `<div class="drop-row"><span class="hint">${unscheduled.length} meeting${unscheduled.length === 1 ? '' : 's'} booked without a time</span>
          <span>${unscheduled.map((m) => `<button class="chip quiet" data-open="${m.companyId}">${esc(m.companyName)}</button>`).join(' ')}</span></div>` : ''}
      </div>`
  }

  function draw() {
    if (meetings.length === 0) {
      root.innerHTML = `
        <div class="card empty">
          <div class="glyph">📅</div>
          <div class="t">No meetings booked yet</div>
          <div class="d">Meetings you book from a lead's call screen show up here on the calendar.</div>
        </div>`
      return
    }
    const byDay = eventsByDay()
    root.innerHTML = `
      <div class="cal-head">
        <div class="cal-title">${esc(monthFmt.format(cursor))}</div>
        <div class="cal-nav">
          <button class="secondary sm" id="cal-today">Today</button>
          <button class="icon-btn" id="cal-prev" aria-label="Previous month"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6"/></svg></button>
          <button class="icon-btn" id="cal-next" aria-label="Next month"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg></button>
        </div>
      </div>
      <div class="card cal-card">${monthGrid(byDay)}</div>
      ${agenda()}`

    root.querySelector('#cal-prev').addEventListener('click', () => { cursor.setMonth(cursor.getMonth() - 1); draw() })
    root.querySelector('#cal-next').addEventListener('click', () => { cursor.setMonth(cursor.getMonth() + 1); draw() })
    root.querySelector('#cal-today').addEventListener('click', () => {
      const t = new Date(); cursor.setFullYear(t.getFullYear(), t.getMonth(), 1); draw()
    })
    root.querySelectorAll('[data-open]').forEach((el) =>
      el.addEventListener('click', () => openRecord(el.dataset.open, load)))
  }

  await load()
  void ctx
}
