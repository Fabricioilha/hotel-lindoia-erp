import { onValue, ref, runTransaction } from 'firebase/database';
import { db } from '../config/firebase';
import type { InventoryData } from '../types/inventory';

const STORAGE_KEY = 'hotel-lindoia:inventory:v1';
const LOCAL_UPDATE_EVENT = 'hotel-lindoia:inventory-updated';

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

function readLocalInventory(): InventoryData {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? normalizeInventory(JSON.parse(saved)) : emptyInventory();
  } catch {
    return emptyInventory();
  }
}

export const inventoryStorageMode = db ? 'Firebase' : 'neste navegador';

export function subscribeInventory(
  onChange: (data: InventoryData) => void,
  onError: (error: Error) => void,
): () => void {
  if (db) {
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

  const refresh = () => onChange(readLocalInventory());
  refresh();
  window.addEventListener('storage', refresh);
  window.addEventListener(LOCAL_UPDATE_EVENT, refresh);
  return () => {
    window.removeEventListener('storage', refresh);
    window.removeEventListener(LOCAL_UPDATE_EVENT, refresh);
  };
}

export async function updateInventory(
  update: (current: InventoryData) => InventoryData,
): Promise<void> {
  if (db) {
    const result = await runTransaction(ref(db, 'erp_geral/estoque'), (current) =>
      update(normalizeInventory(current)),
    );
    if (!result.committed) throw new Error('A gravação do estoque não foi confirmada.');
    return;
  }

  const next = update(readLocalInventory());
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event(LOCAL_UPDATE_EVENT));
}
