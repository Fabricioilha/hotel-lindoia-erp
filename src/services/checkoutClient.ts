import { auth } from '../config/firebase';
import type { CheckoutTarget } from './checkoutPolicy';

const unavailable = 'A liberação de quartos está indisponível. A gerência precisa verificar o serviço de checkout. Nenhuma hospedagem foi encerrada.';

async function checkoutResponse<T>(response: Response): Promise<T> {
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error(unavailable);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? unavailable);
  return result as T;
}

export async function checkoutQuery<T>(query = '', signal?: AbortSignal): Promise<T> {
  const token = await auth.currentUser?.getIdToken();
  const response = await fetch(`/.netlify/functions/checkout${query}`, { signal, headers: { Authorization: `Bearer ${token ?? ''}` } });
  return checkoutResponse<T>(response);
}

export async function requestCheckout(target: CheckoutTarget): Promise<void> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error('Entre novamente para liberar o quarto.');
  const response = await fetch('/.netlify/functions/checkout', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(target),
  });
  await checkoutResponse(response);
}
