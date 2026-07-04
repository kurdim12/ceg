// In-app confirmation modal — the replacement for the banned native
// dialogs. Returns a promise resolving true (confirm) or false (cancel).
export function confirmModal({ title, body, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    overlay.innerHTML = `
      <div class="modal panel" role="dialog" aria-modal="true" aria-label="${title}">
        <h2>${title}</h2>
        <p>${body}</p>
        <div class="modal-actions">
          <button class="secondary" data-act="cancel">Cancel</button>
          <button data-act="confirm" ${danger ? 'class="danger"' : ''}>${confirmLabel}</button>
        </div>
      </div>`
    function close(result) {
      overlay.remove()
      resolve(result)
    }
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(false)
      const act = e.target.dataset?.act
      if (act === 'cancel') close(false)
      if (act === 'confirm') close(true)
    })
    document.body.appendChild(overlay)
    overlay.querySelector('[data-act="confirm"]').focus()
  })
}
