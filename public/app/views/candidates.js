import { api } from '../api.js'
import { toast } from '../toast.js'

function esc(text) {
  const div = document.createElement('div')
  div.textContent = text ?? ''
  return div.innerHTML
}

const STATUS_TABS = [
  ['new', 'To review'],
  ['approved', 'Approved'],
  ['duplicate', 'Duplicates'],
  ['rejected', 'Rejected'],
  ['all', 'All'],
]

const STATUS_CHIP = {
  new: 'holding', approved: 'ok', rejected: 'quiet', duplicate: 'dropped', failed: 'lost',
}

/** Compact, human-readable evidence line from the stored provenance blob. */
function evidenceText(ev) {
  if (!ev || typeof ev !== 'object') return ''
  const bits = []
  if (Array.isArray(ev.emailsFound) && ev.emailsFound.length) {
    bits.push(`email${ev.emailsFound.length > 1 ? 's' : ''} on ${ev.emailSource ?? 'site'}: ${ev.emailsFound.join(', ')}`)
  } else if (typeof ev.crawl === 'string') {
    bits.push(ev.crawl)
  }
  if (Array.isArray(ev.scoring) && ev.scoring.length) bits.push(`score: ${ev.scoring.join(', ')}`)
  if (ev.address) bits.push(`address: ${ev.address}`)
  return bits.join(' · ')
}

function confidenceClass(n) {
  if (n >= 70) return 'ok'
  if (n >= 40) return 'holding'
  return 'quiet'
}

export async function renderCandidates(root, ctx) {
  let status = 'new'

  async function load() {
    const { candidates } = await api.get(`/api/candidates?status=${status}`)
    draw(candidates)
  }

  function card(cand) {
    const loc = [cand.city, cand.country].filter(Boolean).join(', ')
    const contact = cand.extractedEmail || cand.phone || '—'
    const ev = evidenceText(cand.evidence)
    const actionable = cand.status === 'new'
    return `
      <div class="card candidate" data-id="${cand.id}">
        <div class="cand-top">
          <div>
            <div class="cand-name">${esc(cand.name)}</div>
            <div class="hint">${esc(loc || 'location unknown')} · ${esc(cand.sourceType)}${cand.status !== 'new' ? '' : ''}</div>
          </div>
          <div class="cand-right">
            <span class="chip ${confidenceClass(cand.confidence)}" title="Deterministic 0-100 confidence">conf ${cand.confidence}</span>
            <span class="chip ${STATUS_CHIP[cand.status] ?? 'quiet'}">${esc(cand.status)}</span>
          </div>
        </div>
        <div class="cand-fields">
          ${cand.domain || cand.website ? `<div><span class="k">web</span> ${esc(cand.website || cand.domain)}</div>` : ''}
          <div><span class="k">contact</span> ${esc(contact)}</div>
          ${cand.sourceUrl ? `<div><span class="k">source</span> ${esc(cand.sourceUrl)}</div>` : ''}
        </div>
        ${ev ? `<div class="cand-evidence hint">${esc(ev)}</div>` : ''}
        ${cand.status === 'duplicate' && cand.companyId ? `<div class="hint">Matched existing lead #${cand.companyId}.</div>` : ''}
        ${cand.status === 'rejected' && cand.rejectionReason ? `<div class="hint">Reason: ${esc(cand.rejectionReason)}</div>` : ''}
        ${cand.status === 'approved' && cand.companyId ? `<div class="hint">Became lead #${cand.companyId}.</div>` : ''}
        ${actionable ? `
          <div class="cand-actions">
            <button class="approve" data-id="${cand.id}">Approve → create lead</button>
            <button class="secondary reject-toggle" data-id="${cand.id}">Reject</button>
          </div>
          <div class="reject-form" data-id="${cand.id}" hidden>
            <input class="reject-reason" placeholder="Reason (optional)" maxlength="500" />
            <button class="danger reject-confirm" data-id="${cand.id}">Confirm reject</button>
          </div>` : ''}
      </div>`
  }

  function draw(candidates) {
    root.innerHTML = `
      <div class="segmented" id="cand-tabs">
        ${STATUS_TABS.map(([k, label]) => `<button class="${status === k ? 'on' : ''}" data-status="${k}">${label}</button>`).join('')}
      </div>
      <div class="hint" style="margin:4px 0 12px">
        Sourced businesses land here for review. Approving one creates a CRM lead — it never sends email on its own.
      </div>
      <div id="cand-list">
        ${
          candidates.length === 0
            ? `<div class="card empty"><div class="t">Nothing here</div><div class="d">${status === 'new' ? 'No candidates waiting for review. Run sourcing from Leads to gather some.' : 'No candidates with this status.'}</div></div>`
            : candidates.map(card).join('')
        }
      </div>`

    root.querySelectorAll('#cand-tabs button').forEach((b) =>
      b.addEventListener('click', () => { status = b.dataset.status; load() }))

    root.querySelectorAll('.candidate .approve').forEach((btn) =>
      btn.addEventListener('click', async () => {
        btn.disabled = true
        try {
          const res = await api.post(`/api/candidates/${btn.dataset.id}/approve`)
          toast(
            res.status === 'duplicate'
              ? `Already a lead — matched by ${res.matchedBy} (lead #${res.companyId}). Marked duplicate.`
              : `Approved — created lead #${res.companyId}.`,
            res.status === 'duplicate' ? 'info' : 'success',
          )
          await load()
        } catch (err) {
          toast(err.message, 'error')
          btn.disabled = false
        }
      }))

    root.querySelectorAll('.candidate .reject-toggle').forEach((btn) =>
      btn.addEventListener('click', () => {
        const form = root.querySelector(`.reject-form[data-id="${btn.dataset.id}"]`)
        if (form) form.hidden = !form.hidden
      }))

    root.querySelectorAll('.candidate .reject-confirm').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const form = root.querySelector(`.reject-form[data-id="${btn.dataset.id}"]`)
        const reason = form?.querySelector('.reject-reason')?.value ?? ''
        btn.disabled = true
        try {
          await api.post(`/api/candidates/${btn.dataset.id}/reject`, reason ? { reason } : {})
          toast('Rejected.', 'success')
          await load()
        } catch (err) {
          toast(err.message, 'error')
          btn.disabled = false
        }
      }))
  }

  await load()
  void ctx
}
