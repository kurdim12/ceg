import { Hono } from 'hono'
import type { Env } from './env'

const app = new Hono<{ Bindings: Env }>()

app.get('/health', (c) =>
  c.json({ ok: true, product: c.env.PRODUCT_NAME, dryRun: c.env.DRY_RUN === 'true' }),
)

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext) {
    // Internal dispatcher lands in Phase 3: hourly send dispatch,
    // sourcing at 23:00 UTC (02:00 Amman).
  },
} satisfies ExportedHandler<Env>
