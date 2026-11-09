import { db, get, increment, ref } from './pocketbaseRealtime';
import type { FinanceExpense, FinanceIncome, PayrollEntry } from '../types/finance';
import type { GuestStay, RoomCharge } from '../types/reception';
import type { FrigobarSale } from '../types/frigobar';
import type { Reservation } from '../types/housekeeping';
import { commitDeletion, removeFinanceEntries } from './deletionStore';
import { deleteCashOut } from './receptionStore';
import { deleteFrigobarSale } from './frigobarStore';
import { deleteStockMovement } from './inventoryDeletion';

export async function deleteFinancialIncome(entry: FinanceIncome): Promise<void> {
  const updates: Record<string, unknown> = {};
  removeFinanceEntries(updates, [entry.id]);
  updates[`erp_geral/financeiro/expenses/oyo-fee-${entry.id}`] = null;
  if (entry.id.startsWith('recepcao-')) {
    const snapshot = await get(ref(db, 'erp_geral/recepcao/stays'));
    const stay = (Object.values(snapshot.val() ?? {}) as GuestStay[]).find((item) => entry.id.startsWith(`recepcao-${item.id}-`));
    if (stay) updates[`erp_geral/recepcao/stays/${stay.id}/voidedPayments/${entry.id}`] = true;
  } else if (entry.id.startsWith('room-charge-')) {
    const snapshot = await get(ref(db, 'erp_geral/recepcao/roomCharges'));
    const charge = (Object.values(snapshot.val() ?? {}) as RoomCharge[]).find((item) => entry.id.startsWith(`room-charge-${item.id}-`));
    if (charge) updates[`erp_geral/recepcao/roomCharges/${charge.id}/voidedPayments/${entry.id}`] = true;
  } else if (entry.id.startsWith('frigobar-')) {
    const snapshot = await get(ref(db, `erp_geral/frigobar/operations/sales/${entry.id.slice('frigobar-'.length)}`));
    if (snapshot.exists()) { await deleteFrigobarSale(snapshot.val() as FrigobarSale); return; }
  } else if (entry.id.startsWith('minibar-')) {
    const movementId = entry.id.slice('minibar-'.length);
    const snapshot = await get(ref(db, `erp_geral/estoque/movements/${movementId}`));
    if (snapshot.exists()) { await deleteStockMovement(movementId); return; }
  } else if (entry.id.startsWith('reservation-')) {
    const snapshot = await get(ref(db, 'erp_geral/quartos/reservations'));
    const reservation = (Object.values(snapshot.val() ?? {}) as Reservation[]).find((item) => entry.id.startsWith(`reservation-${item.id}-`));
    if (reservation) {
      const collectionId = entry.id.slice(`reservation-${reservation.id}-checkout-`.length);
      const pending = entry.id.startsWith(`reservation-${reservation.id}-checkout-`)
        ? await get(ref(db, `erp_geral/reservationCollections/${reservation.id}/${collectionId}`)) : null;
      if (pending?.exists()) updates[`erp_geral/reservationCollections/${reservation.id}/${collectionId}`] = null;
      else updates[`erp_geral/quartos/reservations/${reservation.id}/balanceDue`] = increment(entry.amount);
    }
  }
  await commitDeletion([`payment-${entry.id}`], updates);
}

export async function deleteFinancialExpense(entry: FinanceExpense): Promise<void> {
  if (entry.generatedFromIncome) throw new Error('A taxa é vinculada ao recebimento. Edite ou exclua a entrada de origem.');
  const payroll = (await get(ref(db, 'erp_geral/financeiro/payroll'))).val() as Record<string, PayrollEntry> | null;
  if (Object.values(payroll ?? {}).some((item) => item.advances?.[entry.id])) throw new Error('Este adiantamento está compensado na folha. Remova o vínculo na folha antes de excluí-lo.');
  if (entry.id.startsWith('caixa-')) { await deleteCashOut(entry.id.slice('caixa-'.length)); return; }
  const updates: Record<string, unknown> = {};
  removeFinanceEntries(updates, [entry.id], 'expenses');
  await commitDeletion([`expense-${entry.id}`], updates);
}
