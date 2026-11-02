import { pb } from '../config/pocketbase';
import type { CheckoutTarget } from './checkoutPolicy';

const unavailable = 'A liberação de quartos está indisponível. A gerência precisa verificar o serviço de checkout. Nenhuma hospedagem foi encerrada.';

async function checkoutResponse<T>(response: Response): Promise<T> {
  if (!response.headers.get('content-type')?.includes('application/json')) {
    const body = await response.text();
    if (response.status === 401) throw new Error('Sessão inválida. Entre novamente.');
    if (response.status === 403) throw new Error('Seu perfil não tem permissão para acessar o checkout.');
    if (!response.ok && body.trim() && !/<(?:!doctype|html)\b/i.test(body)) throw new Error(body);
    throw new Error(`${unavailable} (HTTP ${response.status})`);
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? unavailable);
  return result as T;
}

export async function checkoutQuery<T>(query = '', signal?: AbortSignal): Promise<T> {
  const token = pb.authStore.token;
  const response = await fetch(`/.netlify/functions/checkout${query}`, { signal, headers: { Authorization: `Bearer ${token ?? ''}` } });
  return checkoutResponse<T>(response);
}

export async function requestCheckout(target: CheckoutTarget): Promise<void> {
  const token = pb.authStore.token;
  if (!token) throw new Error('Entre novamente para liberar o quarto.');
  const response = await fetch('/.netlify/functions/checkout', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(target),
  });
  await checkoutResponse(response);
}
