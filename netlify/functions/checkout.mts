import { checkoutStatus } from '../lib/checkoutStatus';
import { adminServices } from '../lib/firebase';
import { applyCheckout, hotelDate, type CheckoutState, type CheckoutTarget } from '../../src/services/checkoutPolicy';
import { stayCheckOutDate } from '../../src/services/reservationAnalytics';
import type { Reservation, ReservationDirectoryEntry } from '../../src/types/housekeeping';
import type { GuestStay } from '../../src/types/reception';

export default async (request: Request) => {
  if (!['POST', 'GET'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
  try {
    const { auth, db } = adminServices();
    let uid: string;
    try { uid = (await auth.verifyIdToken((request.headers.get('authorization') ?? '').replace(/^Bearer /, ''), true)).uid; }
    catch { return Response.json({ error: 'Sessão inválida. Entre novamente.' }, { status: 401 }); }
    const role = (await db.ref(`roles/${uid}/role`).get()).val();
    if (role !== 'admin' && role !== 'viewer') return new Response('Forbidden', { status: 403 });
    if (request.method === 'GET') {
      const url = new URL(request.url);
      if (url.searchParams.get('action') === 'history') {
        const date = url.searchParams.get('date') ?? '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return new Response('Invalid date', { status: 400 });
        const [reservations, stays] = await Promise.all([
          db.ref('erp_geral/quartos/reservations').orderByChild('checkInDate').endAt(date).get(),
          db.ref('erp_geral/recepcao/stays').orderByChild('checkInDate').endAt(date).get(),
        ]);
        const directory = Object.values(reservations.val() ?? {} as Record<string, Reservation>) as Reservation[];
        const filtered = directory.filter((r) => r.checkInDate <= date && r.status !== 'cancelada' && (r.checkedOutAt ? hotelDate(new Date(r.checkedOutAt)) : r.checkOutDate) >= date);
        const selected = filtered.map((r): ReservationDirectoryEntry => ({ id: r.id, roomId: r.roomId, roomNumber: r.roomNumber, guestName: r.guestName,
          checkInDate: r.checkInDate, checkOutDate: r.checkedOutAt ? hotelDate(new Date(r.checkedOutAt)) : r.checkOutDate,
          status: r.status, adults: r.adults, children: r.children, breakfastIncluded: Boolean(r.breakfastIncluded), channel: r.channel ?? 'balcao' }));
        const selectedStays = (Object.values(stays.val() ?? {}) as GuestStay[]).filter((s) => stayCheckOutDate(s) >= date);
        return Response.json({ reservations: Object.fromEntries(selected.map((r) => [r.id, r])), stays: Object.fromEntries(selectedStays.map((s) => [s.id, s])) }, { headers: { 'Cache-Control': 'no-store' } });
      }
      return Response.json(await checkoutStatus(db, new Date()), { headers: { 'Cache-Control': 'no-store' } });
    }
    const target = await request.json() as CheckoutTarget;
    if (!['stay', 'reservation'].includes(target.sourceType) || typeof target.sourceId !== 'string' || !target.sourceId || /[.#$[\]/]/.test(target.sourceId)) return new Response('Invalid target', { status: 400 });
    const now = new Date();
    await db.ref('erp_geral').transaction((state: CheckoutState | null) => {
      if (!state) return null;
      const source = target.sourceType === 'stay' ? state.recepcao?.stays?.[target.sourceId] : state.quartos?.reservations?.[target.sourceId];
      if (!source) throw new Error('Hospedagem não encontrada. Atualize a grade e tente novamente.');
      return applyCheckout(state, target, now, uid) ? state : undefined;
    });
    return Response.json({ ok: true });
  } catch (cause) {
    return Response.json({ error: cause instanceof Error ? cause.message : 'Não foi possível liberar o quarto.' }, { status: 409 });
  }
};
