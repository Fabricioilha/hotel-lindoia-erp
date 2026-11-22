import { isNormalizedFinanceActive } from './financeRepository';
import { runTransaction } from './pocketbaseRealtime';
import { withTransactionData } from './pocketbaseTransactions';

interface FinanceWriteLock { token: string; startedAt: number }

let localQueue: Promise<unknown> = Promise.resolve();

export async function withFinanceWriteLock<T>(action: () => Promise<T>): Promise<T> {
  // Na arquitetura normalizada, cada lançamento possui versão própria e gravação transacional
  // atômica no PocketBase; evitamos lock global entre sessões para eliminar conflitos HTTP 409.
  if (await isNormalizedFinanceActive()) {
    const next = localQueue.catch(() => undefined).then(() => action());
    localQueue = next;
    return next;
  }

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
