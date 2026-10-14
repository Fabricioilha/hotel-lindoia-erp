import { get, onValue, ref, remove, runTransaction, set, update } from 'firebase/database';
import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { db } from '../config/firebase';
import { SALES_CATEGORY_ID, STOCK_QUANTITY_EPSILON, normalizedStockQuantity, stockCategoriesOf, type InventoryData } from '../types/inventory';
import type { OutputCatalogItem, OutputData, OutputRecord } from '../types/outputs';
import { invalidInventoryKey, subscribeInventoryCatalog, updateInventory, type InventoryCatalogData } from './inventoryStore';
import { withStockProductLocks } from './frigobarStore';
import { withTransactionData } from './firebaseTransactions';

const PATH = 'erp_geral/saidas';

export function emptyOutputs(): OutputData {
  return { catalog: {}, records: {} };
}

export function subscribeOutputs(onChange: (data: OutputData) => void, onError: (error: Error) => void): () => void {
  let catalog: Record<string, OutputCatalogItem> | undefined;
  let records: Record<string, OutputRecord> | undefined;
  let catalogRevision = 0;
  const publish = () => {
    if (catalog && records) onChange({ catalog, records, catalogRevision });
  };
  const stopCatalog = onValue(ref(db, `${PATH}/catalog`), (snapshot) => {
    const value = snapshot.val() ?? {};
    catalogRevision = Number(value._revision) || 0;
    catalog = Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('_'))) as Record<string, OutputCatalogItem>;
    publish();
  }, onError);
  const stopRecords = onValue(ref(db, `${PATH}/records`), (snapshot) => {
    records = snapshot.val() ?? {};
    publish();
  }, onError);
  return () => {
    stopCatalog();
    stopRecords();
  };
}

export function outputPendingQuantity(records: OutputRecord[], productId: string, catalogRevision = 0): number {
  return records.filter((record) => !record.applied || (record.appliedInventoryRevision ?? 0) > catalogRevision)
    .reduce((total, record) => total + record.items.filter((item) => item.productId === productId).reduce((sum, item) => sum + item.quantity, 0), 0);
}

export async function createOutput(record: OutputRecord): Promise<void> {
  if (!record.id || invalidInventoryKey(record.id) || !record.items.length) throw new Error('Selecione pelo menos um produto para a saída.');
  const grouped = new Map<string, number>();
  record.items.forEach((item) => {
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) throw new Error('A quantidade da saída deve ser maior que zero.');
    grouped.set(item.productId, (grouped.get(item.productId) ?? 0) + item.quantity);
  });
  await withStockProductLocks([...grouped.keys()], async () => {
    const target = ref(db, `${PATH}/records/${record.id}`);
    if ((await get(target)).exists()) return;
    const [catalogSnapshot, recordsSnapshot] = await Promise.all([get(ref(db, `${PATH}/catalog`)), get(ref(db, `${PATH}/records`))]);
    const catalog = catalogSnapshot.val() ?? {};
    const records = Object.values(recordsSnapshot.val() ?? {}) as OutputRecord[];
    const items = [...grouped].map(([id, quantity]) => {
      const product = catalog[id] as OutputCatalogItem | undefined;
      if (!product || product.category === SALES_CATEGORY_ID) throw new Error('Um produto não está mais disponível para uso interno. Atualize a seleção.');
      const available = Number(product.available) - outputPendingQuantity(records, id, Number(catalog._revision) || 0);
      if (available + STOCK_QUANTITY_EPSILON < quantity) throw new Error(`Saldo insuficiente de ${product.name}. Disponível: ${Math.max(0, available)} ${product.unit}.`);
      return { productId: id, productName: product.name, unit: product.unit, quantity };
    });
    await set(target, { ...record, items, applied: false });
  });
}

// Espelho dos produtos de uso interno, legível pela equipe (o estoque é restrito à gerência).
export async function syncOutputsCatalog(inventory: InventoryCatalogData): Promise<void> {
  const categoryNames = new Map(stockCategoriesOf(inventory).map((category) => [category.id, category.name]));
  const catalog: Record<string, OutputCatalogItem> = {};
  Object.values(inventory.products)
    .filter((product) => product.category !== SALES_CATEGORY_ID && product.active !== false)
    .forEach((product) => {
      catalog[product.id] = {
        id: product.id,
        name: product.name,
        unit: product.unit,
        category: product.category,
        categoryName: categoryNames.get(product.category) ?? product.category,
        available: Object.values(product.locationQuantities ?? {}).reduce((total, value) => total + Number(value || 0), 0),
      };
    });
  const revision = inventory.revision ?? 0;
  await withTransactionData(`${PATH}/catalog`, (reference) => runTransaction(reference, (current) => {
    if (Number(current?._revision ?? -1) > revision) return;
    const next = { ...catalog, _revision: revision };
    return JSON.stringify(current) === JSON.stringify(next) ? undefined : next;
  }, { applyLocally: false }));
}

export function applyOutput(current: InventoryData, record: OutputRecord): InventoryData {
  if (current.deletedOutputs?.[record.id]) return current;
  const products = { ...current.products };
  const movements = { ...current.movements };
  record.items.forEach((item) => {
    const movementId = `saida-${record.id}-${item.productId}`;
    const product = products[item.productId];
    if (movements[movementId]) return;
    if (!product || product.active === false || product.category === SALES_CATEGORY_ID) throw new Error(`O produto ${item.productName} não está disponível para esta saída.`);
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) throw new Error('Confira as quantidades da saída.');
    const locations = { ...(product.locationQuantities ?? {}) };
    const used: string[] = [];
    const sourceLocationQuantities: Record<string, number> = {};
    let remaining = item.quantity;
    Object.entries(locations).sort((a, b) => Number(b[1]) - Number(a[1])).forEach(([name, quantity]) => {
      const take = Math.min(Number(quantity), remaining);
      if (take <= 0) return;
      locations[name] = normalizedStockQuantity(Number(quantity) - take);
      remaining = normalizedStockQuantity(remaining - take);
      used.push(name);
      sourceLocationQuantities[name] = take;
    });
    if (remaining > 0.000001) throw new Error(`Saldo insuficiente de ${product.name}. A saída não foi aplicada. Confira o estoque e tente novamente.`);
    const taken = item.quantity;
    products[product.id] = { ...product, locationQuantities: locations, updatedAt: record.createdAt };
    movements[movementId] = {
      id: movementId,
      productId: product.id,
      productName: product.name,
      category: product.category,
      type: 'saida',
      quantity: taken,
      unit: product.unit,
      fromLocation: used.join(', '),
      sourceLocationQuantities,
      toLocation: '',
      reference: `Saída para uso interno${record.destination ? ` · ${record.destination}` : ''}`,
      note: record.note,
      actor: record.actor,
      unitPrice: 0,
      createdAt: record.createdAt,
    };
  });
  return { ...current, products, movements };
}

// Roda na sessão da gerência: publica o catálogo e baixa do estoque as saídas lançadas pela equipe.
export function useInternalOutputSync(isAdmin: boolean, setError: Dispatch<SetStateAction<string>>) {
  const applying = useRef(new Set<string>());

  useEffect(() => {
    if (!isAdmin) return;
    const fail = (cause: unknown) => setError(cause instanceof Error ? `Saída de produtos não conciliada: ${cause.message}` : 'Saída de produtos não conciliada.');
    const stopInventory = subscribeInventoryCatalog((inventory) => void syncOutputsCatalog(inventory).catch(fail), fail);
    const stopRecords = onValue(ref(db, `${PATH}/records`), (snapshot) => {
      const records = (snapshot.val() ?? {}) as Record<string, OutputRecord>;
      Object.values(records).filter((record) => !record.applied && !applying.current.has(record.id)).forEach((record) => {
        applying.current.add(record.id);
        void (async () => {
          try {
            let deleted = false;
            let revision = 0;
            await withStockProductLocks(record.items.map((item) => item.productId), () => updateInventory((current) => {
              deleted = Boolean(current.deletedOutputs?.[record.id]); revision = (current.revision ?? 0) + 1;
              return applyOutput(current, record);
            }));
            if (!deleted) await update(ref(db, `${PATH}/records/${record.id}`), { applied: true, appliedInventoryRevision: revision });
          } catch (cause) {
            try {
              const deleted = await get(ref(db, `erp_geral/estoque/deletedOutputs/${record.id}`));
              if (!deleted.exists()) fail(cause);
            } catch { fail(cause); }
          } finally {
            applying.current.delete(record.id);
          }
        })();
      });
    }, fail);
    return () => {
      stopInventory();
      stopRecords();
    };
  }, [isAdmin, setError]);
}

export async function deleteOutput(record: OutputRecord): Promise<void> {
  await withStockProductLocks(record.items.map((item) => item.productId), () => removeOutput(record));
}

async function removeOutput(record: OutputRecord): Promise<void> {
  await updateInventory((current) => {
    if (current.deletedOutputs?.[record.id]) return current;
    const products = { ...current.products };
    const movements = { ...current.movements };
    record.items.forEach((item) => {
      const movementId = `saida-${record.id}-${item.productId}`;
      const movement = movements[movementId];
      const product = products[item.productId];
      if (movement && product) {
        const locations = { ...product.locationQuantities };
        // Older records did not retain the quantities taken from each location.
        const returned = movement.sourceLocationQuantities ?? { [movement.fromLocation.includes(', ') ? 'Almoxarifado central' : movement.fromLocation || 'Almoxarifado central']: movement.quantity };
        Object.entries(returned).forEach(([location, quantity]) => { locations[location] = Number(locations[location] ?? 0) + quantity; });
        products[item.productId] = { ...product, locationQuantities: locations, updatedAt: new Date().toISOString() };
      }
      delete movements[movementId];
    });
    return { ...current, products, movements, deletedOutputs: { ...current.deletedOutputs, [record.id]: true } };
  });
  await remove(ref(db, `${PATH}/records/${record.id}`));
}
