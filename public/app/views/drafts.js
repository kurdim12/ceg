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

  root.innerHTML = `
    ${review.active
      ? `<div class="panel review-counter">Review mode is ON: you have approved
         <strong>${review.approved} of ${review.threshold}</strong> emails. Every email below waits
         for you. After ${review.threshold} approvals, sequence emails send automatically.</div>`
      : `<div class="panel review-counter">Review mode finished (${review.approved} approved) —
         sequence emails are approved automatically now. Reply drafts still wait for you here.</div>`}
    <div id="draft-list">
      ${drafts.length === 0
        ? '<div class="panel">Nothing waiting for review.</div>'
        : drafts.map((d) => `
          <div class="panel draft" data-id="${d.id}">
            <div class="meta">To ${esc(d.toEmail)} · ${esc(d.companyName)} ${d.step ? `· sequence step ${d.step}` : '· reply'} ${d.senderName ? `· from ${esc(d.senderName)}'s inbox` : ''}</div>
            <div class="subject">${esc(d.subject)}</div>
            <pre>${esc(d.body)}</pre>
            <button class="approve">Approve for sending</button>
          </div>`).join('')}
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
