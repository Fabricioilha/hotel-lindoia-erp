import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { ref, set } from 'firebase/database';
import { db } from '../config/firebase';
import { recordMinibarIncome } from './minibarSales';
import type { InventoryData } from '../types/inventory';

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
            await recordMinibarIncome(movement);
            await set(ref(db, `erp_geral/estoque/movements/${movement.id}/financeSynced`), true);
          } catch (cause) {
            setError(cause instanceof Error ? `Venda registrada, mas não conciliada no Financeiro: ${cause.message}` : 'Venda registrada, mas não conciliada no Financeiro.');
          } finally {
            syncingIds.current.delete(movement.id);
          }
        })();
      });
  }, [data.movements, setError]);
}

