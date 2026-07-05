import { api } from '../api.js'

function esc(text) {
  const div = document.createElement('div')
  div.textContent = text ?? ''
  return div.innerHTML
}

const history = []

export async function renderAgent(root) {
  root.innerHTML = `
    <div class="card agent-panel">
      <div id="chat-log">${history.length === 0
        ? '<div class="hint">Ask about your pipeline: "who replied this week?", "show me the call queue", "add a note to Atlas Trading"… The assistant can read and update leads. It can never send email, delete anything, or change settings.</div>'
        : ''}</div>
      <form id="chat-form">
        <input id="chat-input" placeholder="Ask the assistant…" autocomplete="off" />
        <button type="submit">Send</button>
      </form>
    </div>`

  const log = root.querySelector('#chat-log')

  function draw() {
    log.innerHTML = history
      .map(
        (turn) => `
        <div class="chat-turn ${turn.role}">
          <div class="meta">${turn.role === 'user' ? 'You' : 'Assistant'}</div>
          <div>${esc(turn.text)}</div>
          ${turn.tools?.length ? `<div class="meta">used: ${turn.tools.map((t) => esc(t.tool) + (t.ok ? '' : ' (blocked)')).join(', ')}</div>` : ''}
        </div>`,
      )
      .join('')
    log.scrollTop = log.scrollHeight
  }
  draw()

  root.querySelector('#chat-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const input = root.querySelector('#chat-input')
    const message = input.value.trim()
    if (!message) return
    input.value = ''
    history.push({ role: 'user', text: message })
    draw()
    try {
      const turn = await api.post('/api/agent/chat', {
        message,
        history: history.slice(0, -1).map((t) => ({ role: t.role, text: t.text })),
      })
      history.push({ role: 'assistant', text: turn.reply, tools: turn.toolCalls })
    } catch (err) {
      history.push({ role: 'assistant', text: `Something went wrong: ${err.message}` })
    }
    draw()
  })
}
