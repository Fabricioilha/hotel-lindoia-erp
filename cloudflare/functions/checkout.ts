import { checkoutStatus } from '../lib/checkoutStatus';
import { commitState, readState, requestToken, superuserClient, verifyUser, type BackendEnv } from '../lib/pocketbase';
import { applyCheckout, hotelDate, type CheckoutState, type CheckoutTarget } from '../../src/services/checkoutPolicy';
import { stayCheckOutDate } from '../../src/services/reservationAnalytics';
import type { Reservation, ReservationDirectoryEntry } from '../../src/types/housekeeping';
import type { GuestStay } from '../../src/types/reception';

function getHotelState(value: Record<string, unknown> | null): CheckoutState {
  return (value ?? {}) as CheckoutState;
}

function changedBranches(previous: CheckoutState, next: CheckoutState): Record<string, unknown> {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  const updates: Record<string, unknown> = {};
  for (const key of keys) {
    if (JSON.stringify(previous[key as keyof CheckoutState]) !== JSON.stringify(next[key as keyof CheckoutState])) {
      updates[`erp_geral/${key}`] = next[key as keyof CheckoutState] ?? null;
    }
  }
  return updates;
}

export default async (request: Request, env: BackendEnv) => {
  if (!['POST', 'GET'].includes(request.method)) return Response.json({ error: 'Método não permitido.' }, { status: 405 });
  try {
    const token = requestToken(request);
    if (!token) return Response.json({ error: 'Sessão inválida. Entre novamente.' }, { status: 401 });
    const user = await verifyUser(env, token);

    if (request.method === 'GET') {
      const client = await superuserClient(env);
      const current = await readState(client, 'erp_geral');
      const state = getHotelState(current.value);
      const url = new URL(request.url);
      if (url.searchParams.get('action') === 'history') {
        const date = url.searchParams.get('date') ?? '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ error: 'Data inválida.' }, { status: 400 });
        const directory = Object.values(state.quartos?.reservations ?? {}) as Reservation[];
        const filtered = directory.filter((reservation) => reservation.checkInDate <= date && reservation.status !== 'cancelada'
          && (reservation.checkedOutAt ? hotelDate(new Date(reservation.checkedOutAt)) : reservation.checkOutDate) >= date);
        const reservations = filtered.map((reservation): ReservationDirectoryEntry => ({
          id: reservation.id,
          roomId: reservation.roomId,
          roomNumber: reservation.roomNumber,
          guestName: reservation.guestName,
          checkInDate: reservation.checkInDate,
          checkOutDate: reservation.checkedOutAt ? hotelDate(new Date(reservation.checkedOutAt)) : reservation.checkOutDate,
          status: reservation.status,
          adults: reservation.adults,
          children: reservation.children,
          breakfastIncluded: Boolean(reservation.breakfastIncluded),
          channel: reservation.channel ?? 'balcao',
        }));
        const stays = (Object.values(state.recepcao?.stays ?? {}) as GuestStay[])
          .filter((stay) => stayCheckOutDate(stay) >= date);
        return Response.json({
          reservations: Object.fromEntries(reservations.map((reservation) => [reservation.id, reservation])),
          stays: Object.fromEntries(stays.map((stay) => [stay.id, stay])),
        }, { headers: { 'Cache-Control': 'no-store' } });
      }
      return Response.json(checkoutStatus(state, new Date()), { headers: { 'Cache-Control': 'no-store' } });
    }

    let target: CheckoutTarget;
    try { target = await request.json() as CheckoutTarget; }
    catch { return Response.json({ error: 'JSON inválido.' }, { status: 400 }); }
    if (!target || !['stay', 'reservation'].includes(target.sourceType) || typeof target.sourceId !== 'string'
      || !target.sourceId || /[.#$[\]/]/.test(target.sourceId)) {
      return Response.json({ error: 'Hospedagem inválida. Atualize a tela e tente novamente.' }, { status: 400 });
    }

    const client = await superuserClient(env);
    const now = new Date();
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await readState(client, 'erp_geral');
      const previous = getHotelState(current.value);
      const next = structuredClone(previous);
      const source = target.sourceType === 'stay' ? next.recepcao?.stays?.[target.sourceId] : next.quartos?.reservations?.[target.sourceId];
      if (!source) throw new Error('Hospedagem não encontrada. Atualize a grade e tente novamente.');
      if (!applyCheckout(next, target, now, user.id)) return Response.json({ ok: true });

      try {
        await commitState(client, current.versions, changedBranches(previous, next));
        return Response.json({ ok: true });
      } catch (error) {
        if (!(error && typeof error === 'object' && 'status' in error && error.status === 409) || attempt === 4) throw error;
      }
    }
    return Response.json({ error: 'Os dados mudaram várias vezes. Atualize a tela e tente novamente.' }, { status: 409 });
  } catch (cause) {
    const status = cause && typeof cause === 'object' && 'status' in cause && typeof cause.status === 'number' && cause.status >= 400 && cause.status <= 599 ? cause.status : 409;
    return Response.json({ error: cause instanceof Error ? cause.message : 'Não foi possível liberar o quarto.' }, { status });
  }
};
