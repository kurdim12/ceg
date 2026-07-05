import { api } from '../api.js'

function esc(text) {
  const div = document.createElement('div')
  div.textContent = text ?? ''
  return div.innerHTML
}

export async function renderRecap(root) {
  const recap = await api.get('/api/recap')

  const tiles = [
    ['New leads', recap.newLeadsSourced, 'sourced in the last 24h'],
    ['Emails sent', recap.emailsSent, 'across both inboxes'],
    ['Engaged replies', recap.repliesInterested, 'humans wrote back'],
    ['Declines', recap.repliesNotInterested, 'not interested / stop'],
    ['Meetings booked', recap.meetingsBooked, 'in the last 24h'],
    [
      'Bounce rate',
      recap.bounce.ratePct !== undefined ? `${recap.bounce.ratePct}%` : '—',
      `${esc(recap.bounce.level.replaceAll('_', ' '))} · ${recap.bounce.sends} sends in window`,
    ],
  ]

  root.innerHTML = `
    <div class="stat-row">
      ${tiles
        .map(
          ([k, v, c]) => `
        <div class="stat"><div class="k">${k}</div><div class="v">${v}</div><div class="c">${c}</div></div>`,
        )
        .join('')}
    </div>
    ${
      recap.alarms.length > 0
        ? `<h2>Alarms</h2><div class="alert-banner">${recap.alarms
            .map((a) => `<div class="alert ${a.kind === 'breaker_tripped' ? 'critical' : ''}"><span class="ic">${a.kind === 'breaker_tripped' ? '⛔' : '⚠️'}</span><span>${esc(a.message)}</span></div>`)
            .join('')}</div>`
        : '<div class="card"><span class="chip ok">All clear</span> <span class="hint">No alarms in the last 24 hours.</span></div>'
    }
    <h2>Today's call queues</h2>
    ${recap.perAssignee
      .map(
        (s) => `
      <div class="card">
        <h3>${esc(s.assigneeName)} — ${s.callQueue.length} to call</h3>
        ${
          s.callQueue.length === 0
            ? '<div class="hint">Nothing in the queue.</div>'
            : s.callQueue
                .map(
                  (l) =>
                    `<div class="drop-row"><span><strong>${esc(l.name)}</strong> · ${esc(l.city ?? '—')}</span><span class="chip ${esc(l.stage)}">${esc(l.stage.replaceAll('_', ' '))}</span></div>`,
                )
                .join('')
        }
      </div>`,
      )
      .join('')}`
}
