import type { IncomingMessage } from 'node:http'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    req.on('data', (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      bytes += buffer.length
      if (bytes > 1024 * 1024) {
        req.destroy()
        reject(new Error('Corpo da requisição excedeu o limite permitido.'))
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function localCheckout(): Plugin {
  return {
    name: 'local-checkout-api',
    apply: 'serve',
    configureServer(server) {
      const env = loadEnv(server.config.mode, server.config.envDir || server.config.root, ['POCKETBASE_'])
      const backend = {
        POCKETBASE_URL: env.POCKETBASE_URL || server.config.env.VITE_POCKETBASE_URL || 'http://127.0.0.1:8090',
        POCKETBASE_SUPERUSER_EMAIL: env.POCKETBASE_SUPERUSER_EMAIL ?? '',
        POCKETBASE_SUPERUSER_PASSWORD: env.POCKETBASE_SUPERUSER_PASSWORD ?? '',
      }
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (url.pathname !== '/api/checkout') return next()
        const method = (req.method ?? 'GET').toUpperCase()
        try {
          const { default: checkout } = await server.ssrLoadModule('/cloudflare/functions/checkout.ts')
          const headers = new Headers()
          if (req.headers.authorization) headers.set('Authorization', req.headers.authorization)
          if (req.headers['content-type']) headers.set('Content-Type', req.headers['content-type'])
          const init: RequestInit = { method, headers }
          if (method !== 'GET' && method !== 'HEAD') {
            init.body = await readRequestBody(req)
          }
          const response: Response = await checkout(new Request(url, init), backend)
          res.writeHead(response.status, {
            'Content-Type': response.headers.get('content-type') || 'application/json',
            'Cache-Control': 'no-store',
          })
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
