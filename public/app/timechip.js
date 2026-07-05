// The local-time chip — the one bold element. Answers, at a glance:
// "can I contact this lead right now?" Window = 09:00–16:30 lead-local,
// weekdays (mirrors the server's send window).

const WIN_START = 9 * 60
const WIN_END = 16 * 60 + 30

function localParts(timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date())
    const get = (t) => parts.find((p) => p.type === t)?.value ?? ''
    const weekday = get('weekday')
    const hour = Number(get('hour') === '24' ? '0' : get('hour'))
    const minute = Number(get('minute'))
    return { weekday, mins: hour * 60 + minute, label: `${get('weekday')} ${get('hour')}:${get('minute')}` }
  } catch {
    return null
  }
}

function stateOf(timezone) {
  const p = localParts(timezone)
  if (!p) return { label: 'tz unknown', inWindow: false, progress: 0 }
  const weekend = p.weekday === 'Sat' || p.weekday === 'Sun'
  const inWindow = !weekend && p.mins >= WIN_START && p.mins < WIN_END
  const progress = Math.max(0, Math.min(1, (p.mins - WIN_START) / (WIN_END - WIN_START)))
  return { label: p.label, inWindow, progress }
}

function arcSvg(progress, size) {
  const r = size / 2 - 1.5
  const c = 2 * Math.PI * r
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
    <circle class="track" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="2"/>
    <circle class="fill" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="2"
      stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - progress)}"
      transform="rotate(-90 ${size / 2} ${size / 2})"/>
  </svg>`
}

function esc(text) {
  const div = document.createElement('div')
  div.textContent = text ?? ''
  return div.innerHTML
}

/** Chip HTML. Pass large: true for the call-screen version. */
export function timeChip(timezone, { large = false, city = null } = {}) {
  if (!timezone) {
    return `<span class="tchip ${large ? 'lg' : ''}" title="Timezone unknown — never inside a send window">tz unknown</span>`
  }
  const s = stateOf(timezone)
  const size = large ? 16 : 12
  const title = s.inWindow ? 'Inside their working hours — good time to contact' : 'Outside their send window right now'
  return `<span class="tchip ${s.inWindow ? 'in' : ''} ${large ? 'lg' : ''}" data-tz="${esc(timezone)}" data-large="${large ? '1' : ''}" title="${title}">
    ${arcSvg(s.inWindow ? s.progress : 0, size)}<span class="t">${esc(s.label)}</span>${city ? `<span class="city">· ${esc(city)}</span>` : ''}
  </span>`
}

/** Refresh every mounted chip in place. Called on an interval from main.js. */
export function tickTimeChips(root = document) {
  root.querySelectorAll('.tchip[data-tz]').forEach((el) => {
    const s = stateOf(el.dataset.tz)
    el.classList.toggle('in', s.inWindow)
    const t = el.querySelector('.t')
    if (t) t.textContent = s.label
    const size = el.dataset.large ? 16 : 12
    const svg = el.querySelector('svg')
    if (svg) svg.outerHTML = arcSvg(s.inWindow ? s.progress : 0, size)
  })
}
