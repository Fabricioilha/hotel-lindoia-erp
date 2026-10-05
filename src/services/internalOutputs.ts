import { onValue, ref, set } from 'firebase/database';
import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { db } from '../config/firebase';
import { SALES_CATEGORY_ID, stockCategoriesOf, type InventoryData } from '../types/inventory';
import type { OutputCatalogItem, OutputData, OutputRecord } from '../types/outputs';
import { subscribeInventory, updateInventory } from './inventoryStore';

const PATH = 'erp_geral/saidas';
let lastCatalogJson = '';

export function emptyOutputs(): OutputData {
  return { catalog: {}, records: {} };
}

export function subscribeOutputs(onChange: (data: OutputData) => void, onError: (error: Error) => void): () => void {
  let catalog: Record<string, OutputCatalogItem> | undefined;
  let records: Record<string, OutputRecord> | undefined;
  const publish = () => {
    if (catalog && records) onChange({ catalog, records });
  };
  const stopCatalog = onValue(ref(db, `${PATH}/catalog`), (snapshot) => {
    catalog = snapshot.val() ?? {};
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

export function createOutput(record: OutputRecord): Promise<void> {
  return set(ref(db, `${PATH}/records/${record.id}`), record);
}

// Espelho dos produtos de uso interno, legível pela equipe (o estoque é restrito à gerência).
async function syncOutputsCatalog(inventory: InventoryData): Promise<void> {
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
  const json = JSON.stringify(catalog);
  if (json === lastCatalogJson) return;
  await set(ref(db, `${PATH}/catalog`), catalog);
  lastCatalogJson = json;
}

function applyOutput(current: InventoryData, record: OutputRecord): InventoryData {
  const products = { ...current.products };
  const movements = { ...current.movements };
  record.items.forEach((item) => {
    const movementId = `saida-${record.id}-${item.productId}`;
    const product = products[item.productId];
    if (movements[movementId] || !product) return;
    const locations = { ...(product.locationQuantities ?? {}) };
    const used: string[] = [];
    let remaining = item.quantity;
    Object.entries(locations).sort((a, b) => Number(b[1]) - Number(a[1])).forEach(([name, quantity]) => {
      const take = Math.min(Number(quantity), remaining);
      if (take <= 0) return;
      locations[name] = Number(quantity) - take;
      remaining -= take;
      used.push(name);
    });
    const taken = item.quantity - remaining;
    if (taken <= 0) return;
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
      toLocation: record.destination || 'Uso interno',
      reference: 'Saída para uso interno',
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
    const fail = (cause: unknown) => setError(cause instanceof Error ? `Saída de produtos não conciliada: ${cause.message}` : 'Saída de produtos não conciliada.');
    const stopInventory = subscribeInventory((inventory) => void syncOutputsCatalog(inventory).catch(fail), fail);
    const stopRecords = onValue(ref(db, `${PATH}/records`), (snapshot) => {
      const records = (snapshot.val() ?? {}) as Record<string, OutputRecord>;
      Object.values(records).filter((record) => !record.applied && !applying.current.has(record.id)).forEach((record) => {
        applying.current.add(record.id);
        void (async () => {
          try {
            await updateInventory((current) => applyOutput(current, record));
            await set(ref(db, `${PATH}/records/${record.id}/applied`), true);
          } catch (cause) {
            fail(cause);
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
