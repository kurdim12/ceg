import { api } from '../api.js'

export function renderLogin(root, onSuccess) {
  root.innerHTML = `
    <div class="panel login-panel">
      <h1>Maranasi Engine</h1>
      <p class="sub">Sign in with your owner account.</p>
      <form id="login-form">
        <label for="email">Email</label>
        <input id="email" type="email" autocomplete="username" required />
        <label for="password">Password</label>
        <input id="password" type="password" autocomplete="current-password" required />
        <button type="submit">Sign in</button>
        <p class="error-text" id="login-error"></p>
      </form>
    </div>`

  const form = root.querySelector('#login-form')
  const errorEl = root.querySelector('#login-error')
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    errorEl.textContent = ''
    const button = form.querySelector('button')
    button.disabled = true
    try {
      await api.post('/api/auth/login', {
        email: root.querySelector('#email').value,
        password: root.querySelector('#password').value,
      })
      onSuccess()
    } catch (err) {
      errorEl.textContent = err.message === 'invalid credentials'
        ? 'That email and password combination does not match.'
        : err.message
    } finally {
      button.disabled = false
    }
  })
}
