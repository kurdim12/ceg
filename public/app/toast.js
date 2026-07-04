// In-app notifications. Native browser dialogs are banned for the life of
// the repo — this module and the modal primitive are the replacements.
export function toast(message, kind = 'info') {
  const el = document.createElement('div')
  el.className = `toast ${kind}`
  el.textContent = message
  document.getElementById('toasts').appendChild(el)
  setTimeout(() => el.remove(), 4200)
}
