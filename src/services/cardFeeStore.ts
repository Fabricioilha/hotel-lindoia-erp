import { db, get, ref } from './pocketbaseRealtime';
import type { FinanceData } from '../types/finance';
import type { GuestStay } from '../types/reception';

// Keep the agreed rate and net receipt on the operational record itself.
export async function snapshotStayCardFees(stay: GuestStay): Promise<GuestStay> {
  const all = Object.values(stay.receipts ?? {});
  const needsSchedule = all.some((receipt) => receipt.cardFeeRate === undefined && ['credit', 'debit'].includes(receipt.method));
  const schedule = needsSchedule
    ? Object.values(((await get(ref(db, 'erp_geral/financeiro/cardFeeSchedule'))).val() ?? {}) as NonNullable<FinanceData['cardFeeSchedule']>).sort((a, b) => b.effectiveAt.localeCompare(a.effectiveAt))
    : [];
  const receipts = { ...stay.receipts };
  let changed = false;
  for (const receipt of all) {
    if (receipt.method !== 'credit' && receipt.method !== 'debit') {
      if (receipt.cardFeeRate !== undefined || receipt.cardFeeAmount !== undefined || receipt.netAmount !== undefined) {
        const { cardFeeRate: _rate, cardFeeAmount: _fee, netAmount: _net, ...rest } = receipt;
        void _rate; void _fee; void _net;
        receipts[receipt.id] = rest;
        changed = true;
      }
      continue;
    }
    const rates = receipt.cardFeeRate === undefined ? schedule.find((item) => item.effectiveAt <= receipt.createdAt) : undefined;
    const rate = receipt.cardFeeRate ?? rates?.[receipt.method] ?? 0;
    const gross = Math.round(receipt.amount * 100);
    const fee = Math.round(gross * rate / 100);
    if (receipt.cardFeeRate !== rate || receipt.cardFeeAmount !== fee / 100 || receipt.netAmount !== (gross - fee) / 100) {
      receipts[receipt.id] = { ...receipt, cardFeeRate: rate, cardFeeAmount: fee / 100, netAmount: (gross - fee) / 100 };
      changed = true;
    }
  }
  return changed ? { ...stay, receipts } : stay;
}
