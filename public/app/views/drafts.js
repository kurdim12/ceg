import { api } from '../api.js'
import { toast } from '../toast.js'

function esc(text) {
  const div = document.createElement('div')
  div.textContent = text ?? ''
  return div.innerHTML
}

export async function renderDrafts(root, ctx) {
  const [{ drafts }, review] = await Promise.all([
    api.get('/api/messages/drafts'),
    api.get('/api/review-status'),
  ])

  const pct = Math.min(100, Math.round((review.approved / review.threshold) * 100))
  root.innerHTML = `
    <div class="card review-bar">
      ${
        review.active
          ? `<strong>${review.approved} of ${review.threshold} reviewed</strong>
             <span class="hint">— then autopilot. Every email below waits for you until then.</span>
             <div class="track"><div class="fill" style="width:${pct}%"></div></div>`
          : `<strong>Autopilot is on</strong>
             <span class="hint">(${review.approved} reviewed). Sequence emails approve automatically now; reply drafts still wait for you here.</span>`
      }
    </div>
    <div id="draft-list">
      ${
        drafts.length === 0
          ? '<div class="card empty"><div class="t">Nothing waiting for review</div><div class="d">New drafts appear here the moment the engine writes them.</div></div>'
          : drafts
              .map(
                (d) => `
          <div class="card draft" data-id="${d.id}">
            <div class="letter-head">
              <span>to&nbsp;&nbsp;${esc(d.toEmail)}</span>
              <span>re&nbsp;&nbsp;${esc(d.companyName)}${d.step ? ` · step ${d.step}` : ' · reply'}</span>
              ${d.senderName ? `<span>from&nbsp;&nbsp;${esc(d.senderName)}</span>` : ''}
            </div>
            <div class="subject">${esc(d.subject)}</div>
            <pre>${esc(d.body)}</pre>
            <div class="bar"><button class="approve">Approve draft</button></div>
          </div>`,
              )
              .join('')
      }
    </div>`

  root.querySelectorAll('.draft .approve').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('.draft').dataset.id
      btn.disabled = true
      try {
        const result = await api.post(`/api/messages/${id}/approve`)
        toast(
          result.reviewMode.active
            ? `Approved (${result.reviewMode.approved}/${result.reviewMode.threshold} of review mode)`
            : 'Approved',
          'success',
        )
        ctx.reload()
      } catch (err) {
        toast(err.message, 'error')
        btn.disabled = false
      }
    })
  })
}
