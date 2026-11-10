import { pb } from '../config/pocketbase';
import { checkoutStatus, type CheckoutAlert, type CheckoutState, type CheckoutTarget } from './checkoutPolicy';
import { db, get, ref } from './pocketbaseRealtime';

const unavailable = 'A liberação de quartos está indisponível. A gerência precisa verificar o serviço de checkout. Nenhuma hospedagem foi encerrada.';
const missingRoute = 'Serviço de checkout não encontrado (HTTP 404). Nenhuma hospedagem foi encerrada. Para remover um cadastro feito por engano, use Excluir hospedagem ou Excluir reserva; para checkout, a gerência deve verificar a publicação do serviço.';

async function checkoutResponse<T>(response: Response): Promise<T> {
  if (!response.headers.get('content-type')?.includes('application/json')) {
    const body = await response.text();
    if (response.status === 401) throw new Error('Sessão inválida. Entre novamente.');
    if (response.status === 403) throw new Error('Seu perfil não tem permissão para acessar o checkout.');
    if (response.status === 404) throw new Error(missingRoute);
    if (!response.ok && body.trim() && !/<(?:!doctype|html)\b/i.test(body)) throw new Error(body);
    throw new Error(`${unavailable} (HTTP ${response.status})`);
  }
  const result = await response.json();
  if (response.status === 404 && (!result.error || result.error === 'Rota não encontrada.')) throw new Error(missingRoute);
  if (!response.ok) throw new Error(result.error ?? unavailable);
  return result as T;
}

export async function checkoutQuery<T>(query = '', signal?: AbortSignal): Promise<T> {
  const token = pb.authStore.token;
  const response = await fetch(`/api/checkout${query}`, { signal, headers: { Authorization: `Bearer ${token ?? ''}` } });
  return checkoutResponse<T>(response);
}

export async function managerCheckoutAlerts(now: Date): Promise<CheckoutAlert[]> {
  const [reservations, stays, roomCharges, incomes, suppressed, extras, collections, sales] = await Promise.all([
    get(ref(db, 'erp_geral/quartos/reservations')),
    get(ref(db, 'erp_geral/recepcao/stays')),
    get(ref(db, 'erp_geral/recepcao/roomCharges')),
    get(ref(db, 'erp_geral/financeiro/incomes')),
    get(ref(db, 'erp_geral/financeiro/suppressed')),
    get(ref(db, 'erp_geral/reservationExtras')),
    get(ref(db, 'erp_geral/reservationCollections')),
    get(ref(db, 'erp_geral/frigobar/operations/sales')),
  ]);
  const state: CheckoutState = {
    quartos: { reservations: reservations.val() ?? undefined },
    recepcao: { stays: stays.val() ?? undefined, roomCharges: roomCharges.val() ?? undefined },
    financeiro: { incomes: incomes.val() ?? undefined, suppressed: suppressed.val() ?? undefined },
    reservationExtras: extras.val() ?? undefined,
    reservationCollections: collections.val() ?? undefined,
    frigobar: { operations: { sales: sales.val() ?? undefined } },
  };
  return checkoutStatus(state, now);
}

export async function requestCheckout(target: CheckoutTarget): Promise<void> {
  const token = pb.authStore.token;
  if (!token) throw new Error('Entre novamente para liberar o quarto.');
  const response = await fetch('/api/checkout', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(target),
  });
  await checkoutResponse(response);
}
