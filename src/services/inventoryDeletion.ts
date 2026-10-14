import { get, increment, ref } from 'firebase/database';
import { db } from '../config/firebase';
import type { StockMovement } from '../types/inventory';
import { commitDeletion, removeFinanceEntries } from './deletionStore';
import { deleteOutput } from './internalOutputs';
import type { OutputRecord } from '../types/outputs';
import { syncFrigobarCatalog, withStockProductLocks } from './frigobarStore';
import { normalizeInventory } from './inventoryStore';

export async function deleteStockProduct(id: string): Promise<void> {
  await withStockProductLocks([id], () => removeStockProduct(id));
}

async function removeStockProduct(id: string): Promise<void> {
  const snapshot = await get(ref(db, 'erp_geral/estoque/movements'));
  const movements = (Object.values(snapshot.val() ?? {}) as StockMovement[]).filter((item) => item.productId === id);
  const updates: Record<string, unknown> = {
    [`erp_geral/estoque/products/${id}`]: null,
    [`erp_geral/frigobar/catalog/${id}`]: null,
    [`erp_geral/saidas/catalog/${id}`]: null,
    [`erp_geral/frigobar/operations/stock/${id}`]: null,
    [`erp_geral/frigobar/operations/stock/_catalogBases/${id}`]: null,
    'erp_geral/estoque/revision': increment(1),
  };
  movements.forEach((item) => {
    updates[`erp_geral/estoque/movements/${item.id}`] = null;
    if (item.type === 'entrada') removeFinanceEntries(updates, [`stock-entry-${item.id}`], 'expenses');
    if (item.type === 'consumo_frigobar') removeFinanceEntries(updates, [`minibar-${item.id}`]);
  });
  await commitDeletion([`product-${id}`, ...movements.map((item) => `movement-${item.id}`)], updates);
}

export async function deleteStockMovement(id: string): Promise<void> {
  const snapshot = await get(ref(db, `erp_geral/estoque/movements/${id}`));
  if (!snapshot.exists()) return;
  const movement = snapshot.val() as StockMovement;
  if (id.startsWith('saida-')) {
    const records = await get(ref(db, 'erp_geral/saidas/records'));
    const source = (Object.values(records.val() ?? {}) as OutputRecord[]).find((item) => id === `saida-${item.id}-${movement.productId}`);
    if (source) { await deleteOutput(source); return; }
  }
  await withStockProductLocks([movement.productId], () => removeStockMovement(id));
}

async function removeStockMovement(id: string): Promise<void> {
  const snapshot = await get(ref(db, `erp_geral/estoque/movements/${id}`));
  if (!snapshot.exists()) return;
  const movement = snapshot.val() as StockMovement;
  const allMovements = movement.type === 'entrada' ? await get(ref(db, 'erp_geral/estoque/movements')) : undefined;
  const updates: Record<string, unknown> = { [`erp_geral/estoque/movements/${id}`]: null };
  const product = await get(ref(db, `erp_geral/estoque/products/${movement.productId}`));
  if (product.exists()) {
    const deltas: Record<string, number> = {};
    const returned = movement.sourceLocationQuantities ?? (movement.fromLocation ? { [movement.fromLocation.includes(', ') ? 'Almoxarifado central' : movement.fromLocation]: movement.quantity } : {});
    Object.entries(returned).forEach(([location, quantity]) => { deltas[location] = (deltas[location] ?? 0) + quantity; });
    if (movement.toLocation) deltas[movement.toLocation] = (deltas[movement.toLocation] ?? 0) - movement.quantity;
    if (movement.toLocation && (deltas[movement.toLocation] ?? 0) < 0) {
      let available = Number(product.child(`locationQuantities/${movement.toLocation}`).val() ?? 0);
      if (product.child('category').val() === 'frigobar' && movement.toLocation === 'Geladeira - Recepção') {
        await syncFrigobarCatalog(normalizeInventory((await get(ref(db, 'erp_geral/estoque'))).val()));
        available = Number((await get(ref(db, `erp_geral/frigobar/operations/stock/${movement.productId}`))).val() ?? 0);
      }
      if (available + deltas[movement.toLocation] < 0) throw new Error('Esta movimentação já foi consumida ou transferida. Reponha o saldo no destino antes de excluí-la.');
    }
    Object.entries(deltas).forEach(([location, quantity]) => {
      if (quantity) updates[`erp_geral/estoque/products/${movement.productId}/locationQuantities/${location}`] = increment(quantity);
    });
    if (movement.type === 'entrada' && allMovements) {
      const remainingEntries = (Object.values(allMovements.val() ?? {}) as StockMovement[])
        .filter((item) => item.productId === movement.productId && item.type === 'entrada' && item.id !== movement.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const hasLaterEntry = remainingEntries.some((item) => item.createdAt > movement.createdAt);
      const currentUnitCost = Number(product.child('cost').val());
      if (!hasLaterEntry && currentUnitCost === movement.unitPrice) {
        const restoredCost = movement.previousUnitCost ?? remainingEntries.at(-1)?.unitPrice;
        if (typeof restoredCost === 'number' && Number.isFinite(restoredCost)) {
          updates[`erp_geral/estoque/products/${movement.productId}/cost`] = restoredCost;
        }
      }
    }
    updates[`erp_geral/estoque/products/${movement.productId}/updatedAt`] = new Date().toISOString();
  }
  if (movement.type === 'entrada') removeFinanceEntries(updates, [`stock-entry-${id}`], 'expenses');
  if (movement.type === 'consumo_frigobar') removeFinanceEntries(updates, [`minibar-${id}`]);
  updates['erp_geral/estoque/revision'] = increment(1);
  await commitDeletion([`movement-${id}`], updates);
  if (product.child('category').val() === 'frigobar') await syncFrigobarCatalog(normalizeInventory((await get(ref(db, 'erp_geral/estoque'))).val()));
}
