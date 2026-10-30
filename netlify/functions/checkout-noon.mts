import { adminServices } from '../lib/firebase';
import { applyCheckout, checkoutPending, dueCheckouts, type CheckoutState } from '../../src/services/checkoutPolicy';

export default async () => {
  const { db } = adminServices();
  const now = new Date();
  let completed = 0;
  let pending = 0;
  let unavailable = 0;
  await db.ref('erp_geral').transaction((state: CheckoutState | null) => {
    if (!state) return null;
    completed = 0; pending = 0; unavailable = 0;
    let changed = false;
    for (const target of dueCheckouts(state, now)) {
      if (checkoutPending(state, target) !== 0) { pending++; continue; }
      // An inconsistent room must not prevent other rooms from checking out.
      try { if (applyCheckout(state, target, now, 'Checkout automático')) { completed++; changed = true; } }
      catch { unavailable++; }
    }
    return changed ? state : undefined;
  });
  console.info('Checkout automático', { completed, pending, unavailable });
};

// Retry throughout the departure afternoon after transient failures or payment.
// 15:00–02:59 UTC is 12:00–23:59 in São Paulo; dueCheckouts checks the hotel date.
export const config = { schedule: '*/5 0-2,15-23 * * *' };
