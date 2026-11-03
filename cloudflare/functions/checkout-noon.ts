import { commitState, readState, superuserClient, type BackendEnv } from '../lib/pocketbase';
import { applyCheckout, checkoutPending, dueCheckouts, type CheckoutState } from '../../src/services/checkoutPolicy';

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

export default async (env: BackendEnv, now = new Date()) => {
  const client = await superuserClient(env);
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await readState(client, 'erp_geral');
    const previous = (current.value ?? {}) as CheckoutState;
    const next = structuredClone(previous);
    let completed = 0;
    let pending = 0;
    let unavailable = 0;

    for (const target of dueCheckouts(next, now)) {
      if (checkoutPending(next, target) !== 0) {
        pending++;
        continue;
      }
      try {
        if (applyCheckout(next, target, now, 'Checkout automático')) completed++;
      } catch (cause) {
        unavailable++;
        console.warn('Checkout automático não liberou um quarto:', cause instanceof Error ? cause.message : 'falha desconhecida');
      }
    }

    const updates = changedBranches(previous, next);
    if (Object.keys(updates).length === 0) {
      console.info('Checkout automático', { completed, pending, unavailable });
      return;
    }
    try {
      await commitState(client, current.versions, updates);
      console.info('Checkout automático', { completed, pending, unavailable });
      return;
    } catch (cause) {
      if (!(cause && typeof cause === 'object' && 'status' in cause && cause.status === 409) || attempt === 4) throw cause;
    }
  }
};

