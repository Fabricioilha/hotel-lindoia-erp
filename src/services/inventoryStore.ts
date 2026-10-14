import { onValue, ref, runTransaction } from 'firebase/database';
import { db } from '../config/firebase';
import type { InventoryData } from '../types/inventory';
import { withTransactionData } from './firebaseTransactions';

export function emptyInventory(): InventoryData {
  return { products: {}, suppliers: {}, movements: {}, assets: {} };
}

export function normalizeInventory(value: unknown): InventoryData {
  const data = value && typeof value === 'object' ? value as Partial<InventoryData> : {};
  return {
    revision: Number(data.revision) || 0,
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
  // One snapshot keeps product balances and their revision from the same commit.
  return onValue(ref(db, 'erp_geral/estoque'), (snapshot) => onChange(normalizeInventory(snapshot.val())), onError);
}

export function subscribeInventoryProducts(
  onChange: (products: InventoryData['products']) => void,
  onError: (error: Error) => void,
): () => void {
  return onValue(ref(db, 'erp_geral/estoque/products'), (snapshot) => onChange(snapshot.val() ?? {}), onError);
}

export type InventoryCatalogData = Pick<InventoryData, 'categories' | 'categoriesConfigured' | 'products' | 'revision'>;

export function subscribeInventoryCatalog(
  onChange: (data: InventoryCatalogData) => void,
  onError: (error: Error) => void,
): () => void {
  return subscribeInventory((data) => onChange({ categories: data.categories, categoriesConfigured: data.categoriesConfigured, products: data.products, revision: data.revision }), onError);
}

export function invalidInventoryKey(key: string): boolean {
  return ['.', '#', '$', '[', ']', '/'].some((character) => key.includes(character)) || [...key].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

export function cleanInventoryPayload(value: unknown, path = 'estoque'): unknown {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`Confira o valor numérico informado em ${path}.`);
  if (Array.isArray(value)) return value.map((item, index) => cleanInventoryPayload(item, `${path}/${index}`) ?? null);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => {
    if (invalidInventoryKey(key)) throw new Error(`O nome “${key}” contém caracteres não aceitos. Use um nome sem . / # $ [ ou ].`);
    return [key, cleanInventoryPayload(item, `${path}/${key}`)];
  }));
  return value;
}

export async function updateInventory(
  update: (current: InventoryData) => InventoryData,
): Promise<void> {
  // Firebase calls transaction callbacks with an empty local cache first.
  // Fetch the branch before callbacks that validate an existing product/balance.
  const result = await withTransactionData('erp_geral/estoque', (reference) => runTransaction(reference, (current) => {
    const original = current && typeof current === 'object' ? current as Record<string, unknown> : {};
    const next = update(normalizeInventory(current));
    return cleanInventoryPayload({ ...original, ...next, revision: (Number(original.revision) || 0) + 1 });
  }, { applyLocally: false }));
  if (!result.committed) throw new Error('A gravação do estoque não foi confirmada.');
}
