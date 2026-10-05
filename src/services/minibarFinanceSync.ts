import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { updateInventory } from './inventoryStore';
import { recordMinibarIncome } from './minibarSales';
import type { InventoryData } from '../types/inventory';
import type { FrigobarSale } from '../types/frigobar';
import type { FinancePaymentMethod } from '../types/finance';
import type { MinibarPaymentMethod } from '../types/inventory';
import { recordOperationalIncomes, type OperationalIncomeInput } from './operationalIncome';
import { localDateKey } from './receptionStore';

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
            await updateInventory((current) => {
              const currentMovement = current.movements[movement.id];
              if (!currentMovement || currentMovement.financeSynced !== false) return current;
              return {
                ...current,
                movements: { ...current.movements, [movement.id]: { ...currentMovement, financeSynced: true } },
              };
            });
          } catch (cause) {
            setError(cause instanceof Error ? `Venda registrada, mas não conciliada no Financeiro: ${cause.message}` : 'Venda registrada, mas não conciliada no Financeiro.');
          } finally {
            syncingIds.current.delete(movement.id);
          }
        })();
      });
  }, [data.movements, setError]);
}

export function useFrigobarFinanceSync(sales: Record<string, FrigobarSale>, isAdmin: boolean, setError: Dispatch<SetStateAction<string>>) {
  useEffect(() => {
    const paymentMethods: Record<MinibarPaymentMethod, FinancePaymentMethod> = {
      dinheiro: 'cash',
      pix: 'pix',
      cartao_debito: 'debit',
      cartao_credito: 'credit',
    };
    const inputs: OperationalIncomeInput[] = [];
    Object.values(sales).filter((sale) => sale.settlement !== 'cobrar_no_checkout' && sale.paymentMethod).forEach((sale) => {
      inputs.push({
        id: `frigobar-${sale.id}`,
        date: localDateKey(new Date(sale.settledAt ?? sale.createdAt)),
        category: 'Consumo',
        description: sale.items.map((item) => `${item.productName} × ${item.quantity}`).join(', '),
        amount: sale.amount,
        paymentMethod: paymentMethods[sale.paymentMethod as MinibarPaymentMethod],
        note: ['Geladeira - Recepção', sale.roomNumber ? `Quarto ${sale.roomNumber}` : '', sale.guestName].filter(Boolean).join(' · '),
      });
    });
    void recordOperationalIncomes(inputs).catch((cause: unknown) => {
      setError(cause instanceof Error ? `Venda da recepção não conciliada no Financeiro: ${cause.message}` : 'Venda da recepção não conciliada no Financeiro.');
    });
  }, [isAdmin, sales, setError]);
}