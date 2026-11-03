// Advanced-mode Pages Worker: only checkout invokes this Worker (_routes.json).
const checkoutPath = '/.netlify/functions/checkout';
const failure = (message, status) => Response.json({ error: message }, {
  status, headers: { 'Cache-Control': 'no-store' },
});

export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);
    if (incoming.pathname !== checkoutPath) return env.ASSETS.fetch(request);
    if (!['GET', 'POST'].includes(request.method)) return failure('Método não permitido.', 405);
    if (!request.headers.get('Authorization')?.startsWith('Bearer ')) {
      return failure('Sessão inválida. Entre novamente.', 401);
    }

    let upstream;
    try {
      upstream = new URL(env.CHECKOUT_ORIGIN);
      // Configuration only: never accept a destination from the incoming request.
      if (upstream.protocol !== 'https:' || upstream.username || upstream.password
        || upstream.pathname !== '/' || upstream.search || upstream.hash
        || upstream.origin === incoming.origin) throw new Error('Invalid origin');
    } catch {
      return failure('Serviço de checkout não configurado na Cloudflare.', 503);
    }
    upstream.pathname = checkoutPath;
    upstream.search = incoming.search;
    const headers = new Headers({ Authorization: request.headers.get('Authorization') });
    if (request.method === 'POST') headers.set('Content-Type', 'application/json');
    try {
      const response = await fetch(upstream, {
        method: request.method, headers,
        body: request.method === 'POST' ? request.body : undefined,
        redirect: 'manual', signal: AbortSignal.timeout(25000),
      });
      // Never follow redirects with the user's token or return an HTML fallback.
      if (response.status >= 300 && response.status < 400
        || !response.headers.get('Content-Type')?.includes('application/json')) {
        return failure('Resposta inválida do serviço de checkout.', 502);
      }
      return new Response(response.body, {
        status: response.status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    } catch {
      return failure('Serviço de checkout indisponível. Consulte o estado do quarto antes de tentar novamente.', 502);
    }
  },
};
