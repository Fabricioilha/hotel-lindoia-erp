import { get, increment, onValue, ref, runTransaction, set, update } from 'firebase/database';
import { db } from '../config/firebase';
import { commitDeletion, removeFinanceEntries } from './deletionStore';
import type { InventoryData, MinibarPaymentMethod, MinibarSettlement, StockProduct } from '../types/inventory';
import type { FrigobarData, FrigobarProduct, FrigobarSale } from '../types/frigobar';

const CATALOG_PATH = 'erp_geral/frigobar/catalog';
const OPERATIONS_PATH = 'erp_geral/frigobar/operations';
const RECEPTION_LOCATION = 'Geladeira - Recepção';

export function emptyFrigobar(): FrigobarData {
  return { products: {}, stock: {}, sales: {} };
}

export function subscribeRoomAddOnInventory(
  onChange: (data: Pick<FrigobarData, 'products' | 'stock'>) => void,
  onError: (error: Error) => void,
): () => void {
  let products: Record<string, FrigobarProduct> | undefined;
  let stock: Record<string, number> | undefined;
  const publish = () => {
    if (products && stock) onChange({ products, stock });
  };
  const stopCatalog = onValue(ref(db, CATALOG_PATH), (snapshot) => {
    products = snapshot.val() ?? {};
    publish();
  }, onError);
  const stopStock = onValue(ref(db, `${OPERATIONS_PATH}/stock`), (snapshot) => {
    stock = { ...(snapshot.val() as Record<string, number> | null ?? {}) };
    delete stock._catalogVersion;
    publish();
  }, onError);
  return () => {
    stopCatalog();
    stopStock();
  };
}

export function subscribeFrigobar(onChange: (data: FrigobarData) => void, onError: (error: Error) => void): () => void {
  let catalog: Record<string, FrigobarProduct> | undefined;
  let stock: Record<string, number> | undefined;
  let sales: Record<string, FrigobarSale> | undefined;
  const publish = () => {
    if (!catalog || !stock || !sales) return;
    onChange({ products: catalog, stock, sales });
  };
  const stopCatalog = onValue(ref(db, CATALOG_PATH), (snapshot) => {
    catalog = snapshot.val() ?? {};
    publish();
  }, onError);
  const stopStock = onValue(ref(db, `${OPERATIONS_PATH}/stock`), (snapshot) => {
    const quantities = { ...(snapshot.val() as Record<string, unknown> | null ?? {}) };
    delete quantities._catalogVersion;
    stock = quantities as Record<string, number>;
    publish();
  }, onError);
  const stopSales = onValue(ref(db, `${OPERATIONS_PATH}/sales`), (snapshot) => {
    sales = snapshot.val() ?? {};
    publish();
  }, onError);
  return () => {
    stopCatalog();
    stopStock();
    stopSales();
  };
}

function productQuantity(product: StockProduct): number {
  return Number(product.locationQuantities?.[RECEPTION_LOCATION] ?? 0);
}

function inventoryVersion(products: Record<string, StockProduct>): string {
  const source = JSON.stringify(Object.values(products)
    .filter((product) => product.category === 'frigobar')
    .map((product) => [product.id, product.name, product.unit, product.salePrice, productQuantity(product), product.active !== false])
    .sort(([left], [right]) => String(left).localeCompare(String(right))));
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) hash = (hash * 31 + source.charCodeAt(index)) | 0;
  return `sync_${Math.abs(hash).toString(36)}`;
}

export async function syncFrigobarCatalog(inventory: InventoryData): Promise<void> {
  const snapshot = await get(ref(db, CATALOG_PATH));
  const catalog = snapshot.val() as Record<string, FrigobarProduct> | null ?? {};
  const products: Record<string, FrigobarProduct> = { ...catalog };
  const initialStock: Record<string, number> = {};
  const stockDeltas: Record<string, number> = {};
  const version = inventoryVersion(inventory.products);
  const sourceProducts = Object.values(inventory.products).filter((product) => product.category === 'frigobar');
  const sourceIds = new Set(sourceProducts.map((product) => product.id));

  sourceProducts.forEach((product) => {
    const sourceQuantity = productQuantity(product);
    const previous = catalog[product.id];
    if (previous) {
      const delta = sourceQuantity - previous.baseQuantity;
      if (delta) stockDeltas[product.id] = delta;
    } else {
      initialStock[product.id] = sourceQuantity;
    }
    products[product.id] = {
      id: product.id,
      name: product.name,
      unit: product.unit,
      salePrice: product.salePrice,
      baseQuantity: sourceQuantity,
      active: product.active !== false,
    };
  });

  Object.values(catalog).forEach((product) => {
    if (!sourceIds.has(product.id)) products[product.id] = { ...product, active: false };
  });

  let alreadyApplied = false;
  const result = await runTransaction(ref(db, `${OPERATIONS_PATH}/stock`), (value) => {
    const stock = { ...(value as Record<string, unknown> | null ?? {}) };
    if (stock._catalogVersion === version) {
      alreadyApplied = true;
      return;
    }
    Object.entries(initialStock).forEach(([id, quantity]) => {
      if (stock[id] === undefined) stock[id] = quantity;
    });
    Object.entries(stockDeltas).forEach(([id, delta]) => {
      stock[id] = Math.max(0, Number(stock[id] ?? 0) + delta);
    });
    stock._catalogVersion = version;
    return stock;
  });
  if (!result.committed && !alreadyApplied) throw new Error('Não foi possível sincronizar os produtos da geladeira.');
  if (JSON.stringify(products) !== JSON.stringify(catalog)) await set(ref(db, CATALOG_PATH), products);
}

export async function createFrigobarSale(input: {
  id: string;
  items: { productId: string; quantity: number }[];
  settlement: MinibarSettlement;
  paymentMethod: MinibarPaymentMethod | '';
  roomNumber: string;
  guestName: string;
  actor: string;
  catalog: Record<string, FrigobarProduct>;
}): Promise<void> {
  if (input.items.length === 0) throw new Error('Adicione pelo menos um produto à venda.');
  if (input.settlement === 'cobrar_no_checkout' && !input.roomNumber.trim()) throw new Error('Informe o quarto para lançar a venda no checkout.');
  if (input.settlement === 'pago_na_recepcao' && !input.paymentMethod) throw new Error('Selecione a forma de pagamento recebida na recepção.');

  const saleRef = ref(db, `${OPERATIONS_PATH}/sales/${input.id}`);
  const existingSale = await get(saleRef);
  if (existingSale.exists()) return;

  const items: FrigobarSale['items'] = input.items.map((line) => {
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) throw new Error('A quantidade deve ser maior que zero.');
    const product = input.catalog[line.productId];
    if (!product || !product.active || product.salePrice <= 0) throw new Error('Um dos produtos não está disponível para venda.');
    return { productId: product.id, productName: product.name, quantity: line.quantity, unit: product.unit, unitPrice: product.salePrice };
  });
  const createdAt = new Date().toISOString();
  const sale: FrigobarSale = {
    id: input.id,
    items,
    amount: items.reduce((total, item) => total + item.quantity * item.unitPrice, 0),
    settlement: input.settlement,
    paymentMethod: input.settlement === 'pago_na_recepcao' ? input.paymentMethod : '',
    roomNumber: input.roomNumber.trim(),
    guestName: input.guestName.trim(),
    actor: input.actor,
    createdAt,
    ...(input.settlement === 'pago_na_recepcao' ? { settledAt: createdAt, settledBy: input.actor } : {}),
  };

  const stockRef = ref(db, `${OPERATIONS_PATH}/stock`);
  const stockResult = await runTransaction(stockRef, (value) => {
    const stock = { ...(value as Record<string, number> | null ?? {}) };
    for (const item of items) {
      const available = Number(stock[item.productId] ?? 0);
      if (available < item.quantity) throw new Error(`Saldo insuficiente de ${item.productName}. Disponível: ${available} ${item.unit}.`);
      stock[item.productId] = available - item.quantity;
    }
    return stock;
  });
  if (!stockResult.committed) throw new Error('A venda não foi confirmada. Atualize o saldo e tente novamente.');

  try {
    await set(saleRef, sale);
  } catch (cause) {
    const savedSale = await get(saleRef);
    if (!savedSale.exists()) {
      await runTransaction(stockRef, (value) => {
        const stock = { ...(value as Record<string, number> | null ?? {}) };
        items.forEach((item) => { stock[item.productId] = Number(stock[item.productId] ?? 0) + item.quantity; });
        return stock;
      });
    }
    throw cause;
  }
}

// Exclui a venda, devolve os itens ao saldo da geladeira e remove a receita do Financeiro.
export async function deleteFrigobarSale(sale: FrigobarSale): Promise<void> {
  const snapshot = await get(ref(db, `${OPERATIONS_PATH}/sales/${sale.id}`));
  if (!snapshot.exists()) return;
  const current = snapshot.val() as FrigobarSale;
  const updates: Record<string, unknown> = { [`${OPERATIONS_PATH}/sales/${sale.id}`]: null };
  const quantities: Record<string, number> = {};
  current.items.forEach((item) => { quantities[item.productId] = (quantities[item.productId] ?? 0) + item.quantity; });
  Object.entries(quantities).forEach(([id, quantity]) => { updates[`${OPERATIONS_PATH}/stock/${id}`] = increment(quantity); });
  removeFinanceEntries(updates, [`frigobar-${sale.id}`]);
  await commitDeletion([`sale-${sale.id}`], updates);
}

export async function settleFrigobarSale(saleId: string, paymentMethod: MinibarPaymentMethod, actor: string): Promise<void> {
  const saleRef = ref(db, `${OPERATIONS_PATH}/sales/${saleId}`);
  const snapshot = await get(saleRef);
  const sale = snapshot.val() as FrigobarSale | null;
  if (!sale || sale.settlement !== 'cobrar_no_checkout') throw new Error('Esta cobrança não está mais pendente.');
  await update(saleRef, {
    settlement: 'pago_no_checkout',
    paymentMethod,
    settledAt: new Date().toISOString(),
    settledBy: actor,
  });
}
