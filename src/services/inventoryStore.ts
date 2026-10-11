import { onValue, orderByChild, query, ref, runTransaction, startAt } from 'firebase/database';
import { db } from '../config/firebase';
import type { InventoryData } from '../types/inventory';

export function emptyInventory(): InventoryData {
  return { products: {}, suppliers: {}, movements: {}, assets: {} };
}

function fiveYearsAgoTimestamp(): string {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 5);
  return cutoff.toISOString();
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
  const keys = ['categories', 'categoriesConfigured', 'products', 'suppliers', 'movements', 'assets', 'deletedOutputs'] as const;
  const loaded = new Set<string>();
  const values: Record<string, unknown> = {};
  const stops = keys.map((key) => {
    const path = ref(db, `erp_geral/estoque/${key}`);
    const listener = key === 'movements' ? query(path, orderByChild('createdAt'), startAt(fiveYearsAgoTimestamp())) : path;
    return onValue(listener, (snapshot) => {
    values[key] = snapshot.val() ?? (key === 'categoriesConfigured' ? false : {});
    loaded.add(key);
    if (loaded.size === keys.length) onChange(normalizeInventory(values));
    }, onError);
  });
  return () => stops.forEach((stop) => stop());
}

export function subscribeInventoryProducts(
  onChange: (products: InventoryData['products']) => void,
  onError: (error: Error) => void,
): () => void {
  return onValue(ref(db, 'erp_geral/estoque/products'), (snapshot) => onChange(snapshot.val() ?? {}), onError);
}

export type InventoryCatalogData = Pick<InventoryData, 'categories' | 'categoriesConfigured' | 'products'>;

export function subscribeInventoryCatalog(
  onChange: (data: InventoryCatalogData) => void,
  onError: (error: Error) => void,
): () => void {
  const data: InventoryCatalogData = { categories: {}, categoriesConfigured: false, products: {} };
  const loaded = new Set<keyof InventoryCatalogData>();
  const publish = (key: keyof InventoryCatalogData) => {
    loaded.add(key);
    if (loaded.size === 3) onChange(data);
  };
  const stopCategories = onValue(ref(db, 'erp_geral/estoque/categories'), (snapshot) => {
    data.categories = snapshot.val() ?? {};
    publish('categories');
  }, onError);
  const stopConfigured = onValue(ref(db, 'erp_geral/estoque/categoriesConfigured'), (snapshot) => {
    data.categoriesConfigured = Boolean(snapshot.val());
    publish('categoriesConfigured');
  }, onError);
  const stopProducts = onValue(ref(db, 'erp_geral/estoque/products'), (snapshot) => {
    data.products = snapshot.val() ?? {};
    publish('products');
  }, onError);
  return () => { stopCategories(); stopConfigured(); stopProducts(); };
}

export async function updateInventory(
  update: (current: InventoryData) => InventoryData,
): Promise<void> {
  const result = await runTransaction(ref(db, 'erp_geral/estoque'), (current) => {
    const original = current && typeof current === 'object' ? current as Record<string, unknown> : {};
    return { ...original, ...update(normalizeInventory(current)) };
  });
  if (!result.committed) throw new Error('A gravação do estoque não foi confirmada.');
}
