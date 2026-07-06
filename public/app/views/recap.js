import { api } from '../api.js'

const STAGE_ORDER = [
  ['new', 'New', '#2563EB'],
  ['email_sequence', 'In sequence', '#D9820A'],
  ['replied', 'Replied', '#0EA371'],
  ['meeting_booked', 'Meeting booked', '#0EA5B5'],
  ['deal', 'Deal', '#7C5CFC'],
  ['won', 'Won', '#0A7A55'],
  ['lost', 'Lost', '#C13438'],
  ['unresponsive_email', 'Unresponsive', '#8A93A2'],
  ['no_valid_email', 'No valid email', '#D9820A'],
  ['dropped', 'Dropped', '#8A93A2'],
]
const REPLY_COLORS = {
  reply: '#0EA371', other: '#2563EB', not_interested: '#C13438',
  stop: '#8A93A2', ooo: '#D9820A', bounce: '#E5484D',
}

function esc(text) {
  const div = document.createElement('div')
  div.textContent = text ?? ''
  return div.innerHTML
}

/** A smooth-ish area sparkline from a list of {label, value}. */
function sparkline(points, color) {
  const w = 320, h = 110, pad = 6
  if (points.length === 0) return '<div class="hint">No data yet.</div>'
  const max = Math.max(1, ...points.map((p) => p.value))
  const n = points.length
  const x = (i) => (n === 1 ? w / 2 : pad + (i * (w - 2 * pad)) / (n - 1))
  const y = (v) => h - pad - (v / max) * (h - 2 * pad)
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')
  const area = `${line} L${x(n - 1).toFixed(1)},${h - pad} L${x(0).toFixed(1)},${h - pad} Z`
  const dots = points.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="2.5" fill="${color}"/>`).join('')
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="trend">
    <path d="${area}" fill="${color}" opacity="0.1"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}
  </svg>`
}

/** Build a 14-day series filling gaps with zero. */
function fill14(rows) {
  const byDate = Object.fromEntries(rows.map((r) => [r.d, r.n]))
  const out = []
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
    out.push({ label: d.slice(5), value: byDate[d] ?? 0 })
  }
  return out
}

export async function renderRecap(root) {
  const [recap, charts] = await Promise.all([api.get('/api/recap'), api.get('/api/recap/charts')])

  const tiles = [
    ['New leads', recap.newLeadsSourced, 'last 24h', true],
    ['Emails sent', recap.emailsSent, 'both inboxes'],
    ['Engaged replies', recap.repliesInterested, 'humans wrote back'],
    ['Declines', recap.repliesNotInterested, 'not interested / stop'],
    ['Meetings', recap.meetingsBooked, 'booked in 24h'],
    ['Bounce rate', recap.bounce.ratePct !== undefined ? `${recap.bounce.ratePct}%` : '—', `${esc(recap.bounce.level.replaceAll('_', ' '))} · ${recap.bounce.sends} sends`],
  ]

  const funnelMax = Math.max(1, ...STAGE_ORDER.map(([s]) => charts.funnel[s] ?? 0))
  const sends14 = fill14(charts.sends)
  const drafts14 = fill14(charts.drafts)
  const totalReplies = charts.replyMix.reduce((t, r) => t + r.n, 0)

  root.innerHTML = `
    <div class="stat-row">
      ${tiles.map(([k, v, c, accent]) => `<div class="stat${accent ? ' accent' : ''}"><div class="k">${k}</div><div class="v">${v}</div><div class="c">${c}</div></div>`).join('')}
    </div>

    <div class="chart-grid">
      <div class="chart-card">
        <div class="ttl">Pipeline funnel</div>
        <div class="sub">Where every lead sits right now</div>
        ${STAGE_ORDER.filter(([s]) => (charts.funnel[s] ?? 0) > 0).map(([s, label, color]) => {
          const n = charts.funnel[s] ?? 0
          return `<div class="funnel-row">
            <span>${label}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${Math.max(3, (n / funnelMax) * 100)}%;background:${color}"></span></span>
            <span class="cnt">${n}</span>
          </div>`
        }).join('') || '<div class="hint">No leads yet.</div>'}
      </div>

      <div class="chart-card">
        <div class="ttl">Emails over 14 days</div>
        <div class="sub">Drafts written vs. actually sent</div>
        ${sparkline(drafts14, '#2563EB')}
        <div class="legend">
          <span class="li"><span class="sw" style="background:#2563EB"></span>Drafts written (${drafts14.reduce((t, p) => t + p.value, 0)})</span>
          <span class="li"><span class="sw" style="background:#0EA371"></span>Sent (${sends14.reduce((t, p) => t + p.value, 0)})</span>
        </div>
      </div>

      <div class="chart-card">
        <div class="ttl">Reply mix</div>
        <div class="sub">${totalReplies === 0 ? 'No replies yet' : `${totalReplies} inbound, classified`}</div>
        ${totalReplies === 0
          ? '<div class="hint">Replies appear here once inboxes are connected and leads write back.</div>'
          : `<div style="display:flex;height:26px;border-radius:7px;overflow:hidden;margin-bottom:14px">
              ${charts.replyMix.map((r) => `<div style="width:${(r.n / totalReplies) * 100}%;background:${REPLY_COLORS[r.t] ?? '#8A93A2'}" title="${esc(r.t)}: ${r.n}"></div>`).join('')}
            </div>
            <div class="legend">${charts.replyMix.map((r) => `<span class="li"><span class="sw" style="background:${REPLY_COLORS[r.t] ?? '#8A93A2'}"></span>${esc(r.t.replaceAll('_', ' '))} (${r.n})</span>`).join('')}</div>`}
      </div>
    </div>

    ${recap.alarms.length > 0
      ? `<h2>Alarms</h2><div class="card">${recap.alarms.map((a) => `<div class="drop-row"><span class="chip ${a.kind === 'breaker_tripped' ? 'lost' : 'holding'}">${a.kind === 'breaker_tripped' ? 'breaker' : 'holding'}</span><span class="hint" style="flex:1">${esc(a.message)}</span></div>`).join('')}</div>`
      : '<div class="card" style="margin-top:24px"><span class="chip ok">All clear</span> <span class="hint" style="margin-left:8px">No alarms in the last 24 hours.</span></div>'}

    <h2>Today's call queues</h2>
    <div class="chart-grid">
      ${recap.perAssignee.map((s) => `
        <div class="chart-card">
          <div class="ttl">${esc(s.assigneeName)}</div>
          <div class="sub">${s.callQueue.length} lead${s.callQueue.length === 1 ? '' : 's'} to call</div>
          ${s.callQueue.length === 0
            ? '<div class="hint">Nothing in the queue.</div>'
            : s.callQueue.map((l) => `<div class="drop-row"><span><strong>${esc(l.name)}</strong> · ${esc(l.city ?? '—')}</span><span class="chip ${esc(l.stage)}">${esc(l.stage.replaceAll('_', ' '))}</span></div>`).join('')}
        </div>`).join('')}
    </div>`
}
