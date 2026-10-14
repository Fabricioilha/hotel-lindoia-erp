import { runTransaction } from 'firebase/database';
import { withTransactionData } from './firebaseTransactions';

interface FinanceWriteLock { token: string; startedAt: number }

export async function withFinanceWriteLock<T>(action: () => Promise<T>): Promise<T> {
  return withTransactionData('erp_geral/financeiro/managerWriteLock', async (lockRef) => {
    const token = crypto.randomUUID();
    let acquired = false;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const result = await runTransaction(lockRef, (current: FinanceWriteLock | null) => {
        if (current && Date.now() - current.startedAt < 5 * 60_000) return;
        return { token, startedAt: Date.now() };
      }, { applyLocally: false });
      if (result.committed) { acquired = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!acquired) throw new Error('O financeiro está sendo atualizado. Aguarde e tente salvar novamente.');
    try { return await action(); }
    finally {
      await runTransaction(lockRef, (current: FinanceWriteLock | null) => current?.token === token ? null : undefined,
        { applyLocally: false }).catch(() => undefined);
    }
  });
}
