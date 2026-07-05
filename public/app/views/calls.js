import { api } from '../api.js'
import { toast } from '../toast.js'
import { confirmModal } from '../modal.js'
import { timeChip } from '../timechip.js'

const OUTCOMES = [
  ['answered-interested', 'Answered — interested'],
  ['answered-not-interested', 'Answered — not interested'],
  ['no-answer', 'No answer'],
  ['wrong-number', 'Wrong number'],
  ['callback-later', 'Callback later'],
]

function esc(text) {
  const div = document.createElement('div')
  div.textContent = text ?? ''
  return div.innerHTML
}

export async function renderCalls(root, ctx) {
  const { queue } = await api.get('/api/call-queue')
  const { drops } = await api.get('/api/drops')
  let index = 0

  function draw() {
    if (queue.length === 0) {
      root.innerHTML = `
        <div class="card empty">
          <div class="glyph">📞</div>
          <div class="t">Your call queue is empty</div>
          <div class="d">Leads land here when their email fails verification or a sequence runs out without a reply.</div>
        </div>
        ${dropsPanel()}`
      wireDrops()
      return
    }
    const lead = queue[index]
    // THE call screen (map §3): the listed fields, exactly three actions,
    // nothing else.
    root.innerHTML = `
      <div class="queue-strip"><span class="mono">Lead ${index + 1} of ${queue.length}</span>
        <span>
          <button class="ghost" id="prev" ${index === 0 ? 'disabled' : ''}>← Previous</button>
          <button class="ghost" id="next" ${index >= queue.length - 1 ? 'disabled' : ''}>Next →</button>
        </span>
      </div>
      <div class="card call-screen">
        <div class="call-head">
          <h2>${esc(lead.name)}</h2>
          ${timeChip(lead.timezone, { large: true, city: lead.city })}
        </div>
        <div class="call-phone">
          ${esc(lead.phone ?? 'no phone on record')}
          ${lead.phoneConfirmed ? '<span class="chip ok">confirmed · a human answered</span>' : '<span class="chip no-dot">not yet confirmed</span>'}
        </div>
        <div class="call-people">
          ${lead.contacts.map((p) => `<div><strong>${esc(p.name ?? '(no name)')}</strong> ${esc(p.role ?? '')} <span class="mono">${esc(p.email ?? 'no email')}</span> <span class="chip quiet">${esc(p.emailStatus.replaceAll('_', ' '))}</span></div>`).join('') || '<div class="hint">No contacts on record.</div>'}
        </div>
        <div class="call-thread">
          <h3>Email thread</h3>
          ${lead.thread.length === 0 ? '<div class="hint">No emails yet.</div>' : lead.thread.map((m) => `
            <div class="thread-msg ${m.direction}">
              <div class="meta">${m.direction === 'outbound' ? 'We wrote' : 'They wrote'} · ${esc(m.createdAt)} UTC · ${esc(m.status)}</div>
              <div class="subject">${esc(m.subject ?? '')}</div>
              <pre>${esc(m.body ?? '')}</pre>
            </div>`).join('')}
        </div>
        <div class="call-last">${lead.lastActivity ? `Last activity: ${esc(lead.lastActivity.kind.replaceAll('_', ' '))} by ${esc(lead.lastActivity.actor)} at ${esc(lead.lastActivity.createdAt)} UTC` : 'No activity recorded yet.'}</div>
        <div class="call-notes">
          <h3>Call notes</h3>
          ${lead.callNotes.length === 0 ? '<div class="hint">No calls logged yet.</div>' : lead.callNotes.map((n) => `<div class="activity"><div>${esc(n.outcome)}</div><div class="meta">${esc(n.createdAt)} UTC ${n.notes ? '· ' + esc(n.notes) : ''}</div></div>`).join('')}
        </div>
        <div class="call-actions">
          <div class="action-block">
            <h3>1 · Log call outcome</h3>
            ${OUTCOMES.map(([value, label]) => `<button class="outcome ${value === 'answered-interested' ? 'good-o' : 'secondary'}" data-outcome="${value}">${label}</button>`).join('')}
            <input id="call-note" placeholder="optional note about the call" />
          </div>
          <div class="action-block">
            <h3>2 · Book meeting</h3>
            <select id="meet-contact">${lead.contacts.map((p) => `<option value="${p.id}">${esc(p.name ?? p.email ?? 'contact ' + p.id)}</option>`).join('')}</select>
            <input id="meet-when" type="datetime-local" />
            <button id="book">Book meeting</button>
          </div>
          <div class="action-block destructive">
            <h3>3 · Send to drop queue</h3>
            <div class="hint"><span class="gate-dots">${[0, 1, 2].map((i) => `<i class="${i < lead.dropGate.failedAttempts ? 'hit' : ''}"></i>`).join('')}</span>${esc(lead.dropGate.reason)}</div>
            <button class="danger" id="to-drop">Send to drop queue</button>
          </div>
        </div>
      </div>
      ${dropsPanel()}`

    root.querySelector('#prev')?.addEventListener('click', () => { index--; draw() })
    root.querySelector('#next')?.addEventListener('click', () => { index++; draw() })
    root.onkeydown = (e) => {
      if (e.target.closest('input, select, textarea')) return
      if (e.key === 'ArrowLeft' && index > 0) { index--; draw() }
      if (e.key === 'ArrowRight' && index < queue.length - 1) { index++; draw() }
    }

    root.querySelectorAll('.outcome').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api.post('/api/calls', {
            companyId: lead.id,
            contactId: lead.contacts[0]?.id,
            outcome: btn.dataset.outcome,
            notes: root.querySelector('#call-note').value || undefined,
          })
          toast('Call logged', 'success')
          ctx.reload()
        } catch (err) {
          toast(err.message, 'error')
        }
      })
    })

    root.querySelector('#book').addEventListener('click', async () => {
      const when = root.querySelector('#meet-when').value
      try {
        await api.post('/api/meetings', {
          companyId: lead.id,
          contactId: Number(root.querySelector('#meet-contact').value),
          scheduledAt: when ? new Date(when).toISOString() : undefined,
        })
        toast('Meeting booked — stage updated', 'success')
        ctx.reload()
      } catch (err) {
        toast(err.message, 'error')
      }
    })

    root.querySelector('#to-drop').addEventListener('click', async () => {
      const go = await confirmModal({
        title: 'Send to drop queue?',
        body: 'This prepares a drop request. The lead is only dropped after you confirm it in the drop queue below — and only once the call gate is satisfied.',
        confirmLabel: 'Prepare drop',
      })
      if (!go) return
      try {
        await api.post('/api/drops', { companyId: lead.id, reason: 'sent from call screen' })
        toast('Added to the drop queue below', 'success')
        ctx.reload()
      } catch (err) {
        toast(err.message, 'error')
      }
    })
    wireDrops()

  }

  function dropsPanel() {
    if (drops.length === 0) return ''
    return `
      <h2>Drop queue — waiting for your confirmation</h2>
      <div class="card">
        ${drops.map((d) => `
          <div class="drop-row" data-id="${d.id}">
            <span>${esc(d.companyName)} — ${esc(d.reason ?? 'no reason recorded')}</span>
            <span>
              <button class="secondary reject">Keep the lead</button>
              <button class="danger confirm">Confirm drop</button>
            </span>
          </div>`).join('')}
      </div>`
  }

  function wireDrops() {
    root.querySelectorAll('.drop-row').forEach((row) => {
      const id = row.dataset.id
      row.querySelector('.confirm').addEventListener('click', async () => {
        const go = await confirmModal({
          title: 'Confirm drop?',
          body: 'The lead moves to Dropped. It re-enters the pool automatically after 12 months.',
          confirmLabel: 'Drop it',
          danger: true,
        })
        if (!go) return
        try {
          await api.post(`/api/drops/${id}/confirm`)
          toast('Lead dropped', 'success')
          ctx.reload()
        } catch (err) {
          toast(err.message, 'error')
        }
      })
      row.querySelector('.reject').addEventListener('click', async () => {
        try {
          await api.post(`/api/drops/${id}/reject`)
          toast('Kept — removed from the drop queue', 'success')
          ctx.reload()
        } catch (err) {
          toast(err.message, 'error')
        }
      })
    })
  }

  draw()
}
