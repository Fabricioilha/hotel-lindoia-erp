import { onValue, ref, runTransaction } from 'firebase/database';
import { db } from '../config/firebase';
import type { InventoryData } from '../types/inventory';

export function emptyInventory(): InventoryData {
  return { products: {}, suppliers: {}, movements: {}, assets: {} };
}

function normalizeInventory(value: unknown): InventoryData {
  const data = value && typeof value === 'object' ? value as Partial<InventoryData> : {};
  return {
    categories: data.categories ?? {},
    categoriesConfigured: Boolean(data.categoriesConfigured),
    products: data.products ?? {},
    suppliers: data.suppliers ?? {},
    movements: data.movements ?? {},
    assets: data.assets ?? {},
    deletedOutputs: data.deletedOutputs ?? {},
  };
}

export const inventoryStorageMode = 'Firebase';

export function subscribeInventory(
  onChange: (data: InventoryData) => void,
  onError: (error: Error) => void,
): () => void {
  const keys = ['categories', 'categoriesConfigured', 'products', 'suppliers', 'movements', 'assets'] as const;
  const loaded = new Set<string>();
  const values: Record<string, unknown> = {};
  const stops = keys.map((key) => onValue(ref(db, `erp_geral/estoque/${key}`), (snapshot) => {
    values[key] = snapshot.val() ?? (key === 'categoriesConfigured' ? false : {});
    loaded.add(key);
    if (loaded.size === keys.length) onChange(normalizeInventory(values));
  }, onError));
  return () => stops.forEach((stop) => stop());
}

export async function updateInventory(
  update: (current: InventoryData) => InventoryData,
): Promise<void> {
  const result = await runTransaction(ref(db, 'erp_geral/estoque'), (current) =>
    update(normalizeInventory(current)),
  );
  if (!result.committed) throw new Error('A gravação do estoque não foi confirmada.');
}
