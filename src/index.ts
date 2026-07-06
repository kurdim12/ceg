import { Hono } from 'hono'
import { authRoutes } from './http/auth-routes'
import { apiRoutes } from './http/api-routes'
import { gmailCallback, gmailRoutes } from './http/gmail-routes'
import { opsRoutes } from './http/ops-routes'
import { runCronTick } from './schedule/cron'
import { schemaState } from './ops/schema'
import type { Env } from './env'

const app = new Hono<{ Bindings: Env }>()

app.get('/health', async (c) => {
  const schema = await schemaState(c.env.DB)
  return c.json({
    ok: true,
    product: c.env.PRODUCT_NAME,
    dryRun: c.env.DRY_RUN === 'true',
    schema: schema.behind ? 'pending' : 'ok',
  })
})

app.route('/api/auth', authRoutes)
app.route('/api/auth/gmail', gmailCallback)
app.route('/api/gmail', gmailRoutes)
app.route('/api', opsRoutes)
app.route('/api', apiRoutes)

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runCronTick(env, new Date(controller.scheduledTime)))
  },
} satisfies ExportedHandler<Env>
