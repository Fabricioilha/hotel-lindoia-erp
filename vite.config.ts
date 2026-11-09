import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

function localCheckout(): Plugin {
  return {
    name: 'local-checkout-read-api',
    apply: 'serve',
    configureServer(server) {
      const env = loadEnv(server.config.mode, server.config.envDir || server.config.root, ['POCKETBASE_SUPERUSER_'])
      const backend = {
        POCKETBASE_URL: server.config.env.VITE_POCKETBASE_URL || 'http://127.0.0.1:8090',
        POCKETBASE_SUPERUSER_EMAIL: env.POCKETBASE_SUPERUSER_EMAIL ?? '',
        POCKETBASE_SUPERUSER_PASSWORD: env.POCKETBASE_SUPERUSER_PASSWORD ?? '',
      }
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (req.method !== 'GET' || url.pathname !== '/api/checkout') return next()
        try {
          const { default: checkout } = await server.ssrLoadModule('/cloudflare/functions/checkout.ts')
          const headers = new Headers()
          if (req.headers.authorization) headers.set('Authorization', req.headers.authorization)
          const response: Response = await checkout(new Request(url, { headers }), backend)
          res.writeHead(response.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          res.end(await response.text())
        } catch (error) {
          next(error)
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), localCheckout()],
})
