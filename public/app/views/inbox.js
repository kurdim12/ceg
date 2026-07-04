import { api } from '../api.js'

function esc(text) {
  const div = document.createElement('div')
  div.textContent = text ?? ''
  return div.innerHTML
}

const TRIAGE_LABELS = {
  reply: 'Replied',
  ooo: 'Out of office',
  not_interested: 'Not interested',
  stop: 'Asked to stop',
  bounce: 'Bounced',
  other: 'Needs a look',
}

export async function renderInbox(root) {
  const { inbound } = await api.get('/api/inbox')
  root.innerHTML =
    inbound.length === 0
      ? '<div class="panel">No inbound emails yet. Replies land here automatically once inboxes are connected.</div>'
      : `<table>
          <thead><tr><th>From</th><th>Company</th><th>Subject</th><th>Classified as</th><th>When</th></tr></thead>
          <tbody>
            ${inbound
              .map(
                (m) => `
              <tr>
                <td>${esc(m.fromEmail)}</td>
                <td>${esc(m.companyName)}</td>
                <td>${esc(m.subject ?? '')}</td>
                <td><span class="chip ${esc(m.triage ?? 'other')}">${esc(TRIAGE_LABELS[m.triage] ?? m.triage ?? '?')}</span></td>
                <td>${esc(m.createdAt)} UTC</td>
              </tr>`,
              )
              .join('')}
          </tbody>
        </table>`
}
