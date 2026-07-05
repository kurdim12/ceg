import { api } from '../api.js'

// Placeholder until design pass 3/3 lands the board + data endpoint.
export async function renderDeals(root) {
  root.innerHTML = `
    <div class="card empty">
      <div class="t">Deals board is on its way</div>
      <div class="d">This screen arrives with the next design pass.</div>
    </div>`
  void api
}
