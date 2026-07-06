import { api } from '../api.js'

function esc(text) {
  const div = document.createElement('div')
  div.textContent = text ?? ''
  return div.innerHTML
}

const SUGGESTIONS = [
  'Who replied this week?',
  'Show me every lead that needs a call',
  'Move Atlas Trading to won',
  "What's my pipeline worth?",
]

const history = []

export async function renderAgent(root) {
  root.innerHTML = `
    <div class="callout">
      <strong>Your assistant can run the whole pipeline.</strong> It reads and updates leads, moves stages,
      runs sourcing, queues emails, books meetings, and can delete records — just ask in plain words.
      It never acts on instructions hidden inside a lead's email.
    </div>
    <div class="card agent-panel">
      <div class="agent-suggest">
        ${SUGGESTIONS.map((s) => `<button data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}
      </div>
      <div id="chat-log"></div>
      <form id="chat-form">
        <input id="chat-input" placeholder="Ask the assistant to do anything…" autocomplete="off" />
        <button type="submit">Send</button>
      </form>
    </div>`

  const log = root.querySelector('#chat-log')
  const input = root.querySelector('#chat-input')

  function draw() {
    if (history.length === 0) {
      log.innerHTML = '<div class="hint" style="margin:auto;text-align:center;max-width:340px">Ask a question or give a command. Try one of the suggestions above to get started.</div>'
      return
    }
    log.innerHTML = history.map((turn) => `
      <div class="chat-turn ${turn.role}">
        <div class="meta">${turn.role === 'user' ? 'You' : 'Assistant'}</div>
        <div>${esc(turn.text)}</div>
        ${turn.tools?.length ? `<div class="tools">↳ ${turn.tools.map((t) => esc(t.tool) + (t.ok ? '' : ' (failed)')).join(', ')}</div>` : ''}
      </div>`).join('')
    log.scrollTop = log.scrollHeight
  }
  draw()

  async function send(message) {
    if (!message) return
    history.push({ role: 'user', text: message })
    draw()
    const thinking = { role: 'assistant', text: '…' }
    history.push(thinking)
    draw()
    try {
      const turn = await api.post('/api/agent/chat', {
        message,
        history: history.slice(0, -2).map((t) => ({ role: t.role, text: t.text })),
      })
      thinking.text = turn.reply
      thinking.tools = turn.toolCalls
    } catch (err) {
      thinking.text = `Something went wrong: ${err.message}`
    }
    draw()
  }

  root.querySelectorAll('[data-suggest]').forEach((b) =>
    b.addEventListener('click', () => send(b.dataset.suggest)))

  root.querySelector('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault()
    const msg = input.value.trim()
    input.value = ''
    send(msg)
  })
}
