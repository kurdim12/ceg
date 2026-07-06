import { api } from './api.js'

// The assistant, everywhere. A launcher (bottom-right + Cmd/Ctrl-K) opens a
// slide-over chat on top of any screen. It carries screen context — the view
// you're on and the lead you have open — so "move this to won" or "draft a
// reply here" acts on what you're looking at. Reuses the agent chat backend;
// all of the agent's guardrails are unchanged.

const VIEW_LABELS = {
  leads: 'Leads', calls: 'the call queue', drafts: 'draft review',
  inbox: 'the inbox', recap: 'the daily recap', deals: 'Deals', settings: 'Settings',
}

const history = []
let ctx = { view: null, record: null }
let host = null
let mounted = false

function esc(text) {
  const div = document.createElement('div')
  div.textContent = text ?? ''
  return div.innerHTML
}

function scopeLabel() {
  if (ctx.record) return `Working on ${ctx.record.name}`
  if (ctx.view && VIEW_LABELS[ctx.view]) return `On ${VIEW_LABELS[ctx.view]}`
  return 'Across your whole pipeline'
}

function suggestions() {
  return ctx.record
    ? ['Summarise this lead', 'Draft a follow-up here', 'What should I do next with this one?', 'Move this to won']
    : ['Who replied this week?', 'Show every lead that needs a call', "What's my pipeline worth?", 'Draft follow-ups for stalled leads']
}

/** Mount the launcher + keyboard shortcut once, for the life of the session. */
export function mountAssistant() {
  if (mounted) return
  mounted = true
  const launcher = document.createElement('button')
  launcher.id = 'assistant-launcher'
  launcher.setAttribute('aria-label', 'Open assistant (Ctrl or Cmd + K)')
  launcher.title = 'Assistant · ⌘K'
  launcher.innerHTML =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5 10.1 7.6 12 3z"/><path d="M19 14l.7 1.8L21.5 16.5 19.7 17.2 19 19l-.7-1.8L16.5 16.5 18.3 15.8 19 14z"/></svg><span>Ask</span>'
  launcher.addEventListener('click', () => toggleAssistant())
  document.body.appendChild(launcher)

  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault()
      toggleAssistant()
    }
  })
}

/** Update what the assistant knows about the current screen. */
export function setAssistantContext(patch) {
  ctx = { ...ctx, ...patch }
  if (host) {
    const chip = host.querySelector('#asst-scope')
    if (chip) chip.textContent = scopeLabel()
    // Refresh suggestions only while the log is empty (don't disrupt a chat).
    if (history.length === 0) drawSuggest()
  }
}

export function toggleAssistant() {
  if (host) closeAssistant()
  else openAssistant()
}

export function closeAssistant() {
  if (!host) return
  host.classList.add('closing')
  const el = host
  host = null
  setTimeout(() => el.remove(), 160)
}

function drawSuggest() {
  const wrap = host?.querySelector('#asst-suggest')
  if (!wrap) return
  wrap.innerHTML = suggestions().map((s) => `<button data-suggest="${esc(s)}">${esc(s)}</button>`).join('')
  wrap.querySelectorAll('[data-suggest]').forEach((b) =>
    b.addEventListener('click', () => send(b.dataset.suggest)))
}

function draw() {
  const log = host?.querySelector('#chat-log')
  if (!log) return
  if (history.length === 0) {
    log.innerHTML = '<div class="hint" style="margin:auto;text-align:center;max-width:320px">Ask a question or give a command. I can act on whatever you have open.</div>'
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

async function send(message) {
  message = (message ?? '').trim()
  if (!message) return
  const wrap = host?.querySelector('#asst-suggest')
  if (wrap) wrap.style.display = 'none'
  history.push({ role: 'user', text: message })
  draw()
  const thinking = { role: 'assistant', text: '…' }
  history.push(thinking)
  draw()
  try {
    const turn = await api.post('/api/agent/chat', {
      message,
      history: history.slice(0, -2).map((t) => ({ role: t.role, text: t.text })),
      context: {
        view: ctx.view ?? undefined,
        record: ctx.record ? { id: Number(ctx.record.id), name: ctx.record.name } : undefined,
      },
    })
    thinking.text = turn.reply
    thinking.tools = turn.toolCalls
  } catch (err) {
    thinking.text = `Something went wrong: ${err.message}`
  }
  draw()
}

export function openAssistant(seed) {
  if (host) {
    host.querySelector('#chat-input')?.focus()
    return
  }
  host = document.createElement('div')
  host.className = 'drawer-overlay'
  host.innerHTML = `
    <div class="drawer assistant-drawer" role="dialog" aria-modal="true" aria-label="Assistant">
      <div class="drawer-head">
        <div class="rec-title">
          <span class="ini asst-ini">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5 10.1 7.6 12 3z"/></svg>
          </span>
          <div>
            <div class="nm">Assistant</div>
            <div class="hint" id="asst-scope">${esc(scopeLabel())}</div>
          </div>
        </div>
        <button class="icon-btn" id="asst-close" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="agent-panel assistant-panel">
        <div class="agent-suggest" id="asst-suggest"></div>
        <div id="chat-log"></div>
        <form id="chat-form">
          <input id="chat-input" placeholder="Ask the assistant to do anything…" autocomplete="off" />
          <button type="submit">Send</button>
        </form>
      </div>
    </div>`
  document.body.appendChild(host)

  host.addEventListener('click', (e) => { if (e.target === host) closeAssistant() })
  host.querySelector('#asst-close').addEventListener('click', closeAssistant)
  const onEsc = (e) => { if (e.key === 'Escape' && host) { closeAssistant(); document.removeEventListener('keydown', onEsc) } }
  document.addEventListener('keydown', onEsc)

  host.querySelector('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault()
    const input = host.querySelector('#chat-input')
    const msg = input.value
    input.value = ''
    send(msg)
  })

  drawSuggest()
  draw()
  const input = host.querySelector('#chat-input')
  if (seed) input.value = seed
  input.focus()
}
