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
    products: data.products ?? {},
    suppliers: data.suppliers ?? {},
    movements: data.movements ?? {},
    assets: data.assets ?? {},
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
    return onValue(
      ref(db, 'erp_geral/estoque'),
      (snapshot) => onChange(normalizeInventory(snapshot.val())),
      (error) => onError(error),
    );
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