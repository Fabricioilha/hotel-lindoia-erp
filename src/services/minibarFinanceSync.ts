import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { get, runTransaction } from 'firebase/database';
import { minibarMovementFinanceEntry, stockPurchaseExpense } from './operationalLedger';
import { recordOperationalExpenses, recordOperationalIncome } from './operationalIncome';
import { withTransactionData } from './firebaseTransactions';
import type { InventoryData, StockMovement } from '../types/inventory';

const movementFingerprint = (movement: StockMovement) => JSON.stringify([
  movement.type, movement.quantity, movement.unitPrice, movement.settlement, movement.paymentMethod, movement.settledAt,
  movement.entryPayment, movement.paidDate,
]);

export async function syncStockMovementFinance(movement: StockMovement): Promise<void> {
  await withTransactionData(`erp_geral/estoque/movements/${movement.id}`, async (movementRef) => {
    const snapshot = await get(movementRef);
    const current = snapshot.val() as StockMovement | null;
    if (!current || current.id !== movement.id || current.financeSynced === true) return;
    const sale = minibarMovementFinanceEntry(current);
    const purchase = stockPurchaseExpense(current);
    if (sale) {
      const line = sale.items![0];
      await recordOperationalIncome({ id: sale.id, date: sale.date, category: sale.category, description: line.description,
        amount: line.amount, paymentMethod: line.paymentMethod, note: sale.note });
    } else if (purchase) {
      await recordOperationalExpenses([purchase]);
    } else return;
    const fingerprint = movementFingerprint(current);
    await runTransaction(movementRef, (value: StockMovement | null) => {
      // Deletion or a new settlement can occur while the receipt is being reconciled.
      if (!value || value.id !== current.id || movementFingerprint(value) !== fingerprint) return;
      return { ...value, financeSynced: true };
    }, { applyLocally: false });
  });
}

export function useMinibarFinanceSync(data: InventoryData, setError: Dispatch<SetStateAction<string>>) {
  const syncingIds = useRef(new Set<string>());

  useEffect(() => {
    Object.values(data.movements)
      .filter((movement) => movement.financeSynced === false)
      .forEach((movement) => {
        if (syncingIds.current.has(movement.id)) return;
        syncingIds.current.add(movement.id);
        void (async () => {
          try {
            await syncStockMovementFinance(movement);
          } catch (cause) {
            setError(cause instanceof Error ? `Movimento registrado, mas não conciliado no Financeiro: ${cause.message}` : 'Movimento registrado, mas não conciliado no Financeiro.');
          } finally {
            syncingIds.current.delete(movement.id);
          }
        })();
      });
  }, [data.movements, setError]);
}

