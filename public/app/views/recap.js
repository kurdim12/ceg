import { api } from '../api.js'

function esc(text) {
  const div = document.createElement('div')
  div.textContent = text ?? ''
  return div.innerHTML
}

export async function renderRecap(root) {
  const recap = await api.get('/api/recap')
  root.innerHTML = `
    <div class="recap-grid">
      <div class="panel stat"><div class="num">${recap.newLeadsSourced}</div><div>new leads sourced</div></div>
      <div class="panel stat"><div class="num">${recap.emailsSent}</div><div>emails sent</div></div>
      <div class="panel stat"><div class="num">${recap.repliesInterested}</div><div>replies (engaged)</div></div>
      <div class="panel stat"><div class="num">${recap.repliesNotInterested}</div><div>replies (no)</div></div>
      <div class="panel stat"><div class="num">${recap.meetingsBooked}</div><div>meetings booked</div></div>
      <div class="panel stat"><div class="num">${recap.bounce.ratePct ?? '—'}${recap.bounce.ratePct !== undefined ? '%' : ''}</div>
        <div>bounce rate (${esc(recap.bounce.level.replaceAll('_', ' '))}, ${recap.bounce.sends} sends in window)</div></div>
    </div>
    ${recap.alarms.length > 0
      ? `<h2>Alarms</h2><div class="panel">${recap.alarms.map((a) => `<div>⚠ ${esc(a.message)}</div>`).join('')}</div>`
      : '<div class="panel">No alarms today.</div>'}
    <h2>Today's call queues</h2>
    ${recap.perAssignee
      .map(
        (s) => `
      <div class="panel">
        <h3>${esc(s.assigneeName)} — ${s.callQueue.length} to call</h3>
        ${s.callQueue.length === 0
          ? '<div class="sub">Nothing in the queue.</div>'
          : s.callQueue.map((l) => `<div>${esc(l.name)} · ${esc(l.city ?? '—')} <span class="chip ${esc(l.stage)}">${esc(l.stage.replaceAll('_', ' '))}</span></div>`).join('')}
      </div>`,
      )
      .join('')}`
}
