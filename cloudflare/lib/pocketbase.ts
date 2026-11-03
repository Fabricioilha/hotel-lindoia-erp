import PocketBase from 'pocketbase';

export interface StateResponse {
  value: Record<string, unknown> | null;
  versions: Record<string, number | null>;
}

export interface BackendEnv {
  POCKETBASE_URL: string;
  POCKETBASE_SUPERUSER_EMAIL: string;
  POCKETBASE_SUPERUSER_PASSWORD: string;
}

function baseUrl(env: BackendEnv): string {
  const value = env.POCKETBASE_URL;
  if (!value) throw new Error('Configure POCKETBASE_URL no servidor.');
  return value;
}

export function pocketbaseClient(env: BackendEnv, token?: string): PocketBase {
  const client = new PocketBase(baseUrl(env));
  client.autoCancellation(false);
  if (token) client.authStore.save(token, null);
  return client;
}

export function requestToken(request: Request): string | null {
  const authorization = request.headers.get('authorization') ?? '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() || null : null;
}

export async function verifyUser(env: BackendEnv, token: string): Promise<{ id: string; role: 'admin' | 'viewer' }> {
  const client = pocketbaseClient(env, token);
  const profile = await client.send<{ id: string; role: string }>('/api/hotel/me', {});
  if (profile.role !== 'admin' && profile.role !== 'viewer') {
    throw Object.assign(new Error('Seu perfil não tem permissão para acessar o checkout.'), { status: 403 });
  }
  return { id: profile.id, role: profile.role };
}

export async function superuserClient(env: BackendEnv): Promise<PocketBase> {
  const email = env.POCKETBASE_SUPERUSER_EMAIL;
  const password = env.POCKETBASE_SUPERUSER_PASSWORD;
  if (!email || !password) {
    throw new Error('Configure POCKETBASE_SUPERUSER_EMAIL e POCKETBASE_SUPERUSER_PASSWORD no servidor.');
  }
  const client = pocketbaseClient(env);
  await client.collection('_superusers').authWithPassword(email, password);
  return client;
}

export function readState(client: PocketBase, path: string): Promise<StateResponse> {
  return client.send<StateResponse>('/api/hotel/state', { query: { path } });
}

export function commitState(
  client: PocketBase,
  expected: Record<string, number | null>,
  updates: Record<string, unknown>,
): Promise<{ committed: boolean }> {
  return client.send('/api/hotel/state/commit', {
    method: 'POST',
    body: { expected, updates },
  });
}
