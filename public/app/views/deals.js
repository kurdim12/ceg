import { api } from '../api.js'

const COLUMNS = [
  { stage: 'deal', label: 'Deal', dot: 'var(--stage-deal)' },
  { stage: 'won', label: 'Won', dot: 'var(--stage-won)' },
  { stage: 'lost', label: 'Lost', dot: 'var(--stage-lost)' },
]

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
})

function esc(text) {
  const div = document.createElement('div')
  div.textContent = text ?? ''
  return div.innerHTML
}

function initials(name) {
  return (name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('')
}

function daysIn(enteredStageAt) {
  const ms = Date.now() - new Date(enteredStageAt + 'Z').getTime()
  const days = Math.max(0, Math.floor(ms / 86_400_000))
  return days === 0 ? 'today' : days === 1 ? '1 day' : `${days} days`
}

export async function renderDeals(root) {
  const { deals } = await api.get('/api/deals')

  if (deals.length === 0) {
    root.innerHTML = `
      <div class="card empty">
        <div class="t">No deals yet</div>
        <div class="d">A lead that books a meeting and advances to Deal shows up here with its amount.</div>
      </div>`
    return
  }

  const byStage = Object.fromEntries(COLUMNS.map((c) => [c.stage, []]))
  for (const d of deals) byStage[d.stage]?.push(d)
  const sum = (rows) => rows.reduce((t, d) => t + (d.amountUsdCents ?? 0), 0)
  const openTotal = sum(byStage.deal)

  root.innerHTML = `
    <div class="board-total">
      <span class="eyebrow">Open pipeline</span>
      <span class="v num">${usd.format(openTotal / 100)}</span>
      <span class="hint">across ${byStage.deal.length} open deal${byStage.deal.length === 1 ? '' : 's'} · stage moves happen from the assistant or the lead itself</span>
    </div>
    <div class="board">
      ${COLUMNS.map(
        (col) => `
        <div class="board-col">
          <div class="col-head">
            <span class="dot" style="background:${col.dot}"></span>
            <span>${col.label}</span>
            <span class="cnt num">${byStage[col.stage].length}</span>
            <span class="sum num">${usd.format(sum(byStage[col.stage]) / 100)}</span>
          </div>
          ${
            byStage[col.stage].length === 0
              ? '<div class="hint" style="padding: 4px 8px 8px">Nothing here.</div>'
              : byStage[col.stage]
                  .map(
                    (d) => `
              <div class="deal-card">
                <div class="co-name">${esc(d.companyName)}</div>
                <div class="amt">${d.amountUsdCents !== null ? usd.format(d.amountUsdCents / 100) : 'amount not set'}</div>
                <div class="meta-row">
                  <span class="assignee" title="${esc(d.assigneeName ?? 'Unassigned')}">${esc(initials(d.assigneeName))}</span>
                  <span>${daysIn(d.enteredStageAt)} in stage</span>
                </div>
              </div>`,
                  )
                  .join('')
          }
        </div>`,
      ).join('')}
    </div>`
}
