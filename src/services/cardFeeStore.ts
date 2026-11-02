import { db, get, ref } from './pocketbaseRealtime';
import type { FinanceData } from '../types/finance';
import type { GuestStay } from '../types/reception';

// Keep the agreed rate and net receipt on the operational record itself.
export async function snapshotStayCardFees(stay: GuestStay): Promise<GuestStay> {
  const pending = Object.values(stay.receipts ?? {}).filter((receipt) => receipt.cardFeeRate === undefined && ['credit', 'debit'].includes(receipt.method));
  if (!pending.length) return stay;
  const snapshot = await get(ref(db, 'erp_geral/financeiro/cardFeeSchedule'));
  const schedule = Object.values((snapshot.val() ?? {}) as NonNullable<FinanceData['cardFeeSchedule']>).sort((a, b) => b.effectiveAt.localeCompare(a.effectiveAt));
  const receipts = { ...stay.receipts };
  for (const receipt of pending) {
    const rates = schedule.find((rate) => rate.effectiveAt <= receipt.createdAt);
    const rate = rates?.[receipt.method as 'credit' | 'debit'] ?? 0;
    const gross = Math.round(receipt.amount * 100);
    const fee = Math.round(gross * rate / 100);
    receipts[receipt.id] = { ...receipt, cardFeeRate: rate, cardFeeAmount: fee / 100, netAmount: (gross - fee) / 100 };
  }
  return { ...stay, receipts };
}
