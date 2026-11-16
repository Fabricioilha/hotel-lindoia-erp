import checkout from './functions/checkout';
import type { BackendEnv } from './lib/pocketbase';

interface Env extends BackendEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/api/checkout') {
      const response = await checkout(request, env);
      response.headers.set('Cache-Control', 'no-store');
      return response;
    }
    if (path === '/api' || path.startsWith('/api/')) {
      return Response.json({ error: 'Rota não encontrada.' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }
    return env.ASSETS.fetch(request);
  },
};
