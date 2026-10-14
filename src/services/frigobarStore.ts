import { endAt, get, increment, onValue, orderByChild, query, ref, runTransaction, set, startAt, update } from 'firebase/database';
import { db } from '../config/firebase';
import { commitDeletion, removeFinanceEntries } from './deletionStore';
import { STOCK_QUANTITY_EPSILON, normalizedStockQuantity, type InventoryData, type MinibarPaymentMethod, type MinibarSettlement, type StockProduct } from '../types/inventory';
import type { FrigobarData, FrigobarProduct, FrigobarSale } from '../types/frigobar';
import { withTransactionData } from './firebaseTransactions';
import { invalidInventoryKey } from './inventoryStore';

const CATALOG_PATH = 'erp_geral/frigobar/catalog';
const OPERATIONS_PATH = 'erp_geral/frigobar/operations';
const RECEPTION_LOCATION = 'Geladeira - Recepção';

function visibleProducts(value: unknown): Record<string, FrigobarProduct> {
  return Object.fromEntries(Object.entries((value ?? {}) as Record<string, FrigobarProduct>).filter(([key]) => !key.startsWith('_')));
}
function visibleStock(value: unknown): Record<string, number> {
  return Object.fromEntries(Object.entries((value ?? {}) as Record<string, unknown>).filter(([key, quantity]) => !key.startsWith('_') && typeof quantity === 'number')) as Record<string, number>;
}

export async function withStockProductLocks<T>(productIds: string[], action: () => Promise<T>): Promise<T> {
  const token = crypto.randomUUID();
  const held: string[] = [];
  try {
    for (const id of [...new Set(productIds)].sort()) {
      const stamp = Date.now();
      const result = await runTransaction(ref(db, `erp_geral/stockProductLocks/${id}`), (current) => !current || Number(current.expiresAt) < stamp ? { token, expiresAt: stamp + 300_000 } : undefined, { applyLocally: false });
      if (!result.committed) throw new Error('Este produto está sendo movimentado em outra sessão. Aguarde e tente novamente.');
      held.push(id);
    }
    return await action();
  } finally {
    await Promise.allSettled(held.map((id) => withTransactionData(`erp_geral/stockProductLocks/${id}`, (reference) => runTransaction(reference, (current) => current?.token === token ? null : undefined, { applyLocally: false }))));
  }
}

function fiveYearsAgoTimestamp(): string {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 5);
  return cutoff.toISOString();
}

function localDateBoundary(dateValue: string, endOfDay = false): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
  if (!match) return '';
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (date.getFullYear() !== Number(year) || date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day)) return '';
  if (endOfDay) date.setHours(23, 59, 59, 999);
  return date.toISOString();
}

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
    products = visibleProducts(snapshot.val());
    publish();
  }, onError);
  const stopStock = onValue(ref(db, `${OPERATIONS_PATH}/stock`), (snapshot) => {
    stock = visibleStock(snapshot.val());
    publish();
  }, onError);
  return () => {
    stopCatalog();
    stopStock();
  };
}

export function subscribeFrigobar(onChange: (data: FrigobarData) => void, onError: (error: Error) => void, startDate?: string, endDate?: string): () => void {
  let catalog: Record<string, FrigobarProduct> | undefined;
  let stock: Record<string, number> | undefined;
  let sales: Record<string, FrigobarSale> | undefined;
  const publish = () => {
    if (!catalog || !stock || !sales) return;
    onChange({ products: catalog, stock, sales });
  };
  const stopCatalog = onValue(ref(db, CATALOG_PATH), (snapshot) => {
    catalog = visibleProducts(snapshot.val());
    publish();
  }, onError);
  const stopStock = onValue(ref(db, `${OPERATIONS_PATH}/stock`), (snapshot) => {
    stock = visibleStock(snapshot.val());
    publish();
  }, onError);
  const startTimestamp = startDate ? localDateBoundary(startDate) : '';
  const endTimestamp = endDate ? localDateBoundary(endDate, true) : '';
  const salesQuery = startTimestamp && endTimestamp && startDate !== undefined && endDate !== undefined && startDate <= endDate
    ? query(ref(db, `${OPERATIONS_PATH}/sales`), orderByChild('createdAt'), startAt(startTimestamp), endAt(endTimestamp))
    : query(ref(db, `${OPERATIONS_PATH}/sales`), orderByChild('createdAt'), startAt(fiveYearsAgoTimestamp()));
  const stopSales = onValue(salesQuery, (snapshot) => {
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
  const catalog = visibleProducts(snapshot.val());
  const products: Record<string, FrigobarProduct> = { ...catalog };
  const version = inventoryVersion(inventory.products);
  const revision = inventory.revision ?? 0;
  const sourceProducts = Object.values(inventory.products).filter((product) => product.category === 'frigobar');
  const sourceIds = new Set(sourceProducts.map((product) => product.id));

  sourceProducts.forEach((product) => {
    const sourceQuantity = productQuantity(product);
    products[product.id] = {
      id: product.id,
      name: product.name,
      unit: product.unit,
      salePrice: Number(product.salePrice) || 0,
      baseQuantity: sourceQuantity,
      active: product.active !== false,
    };
  });

  Object.values(catalog).forEach((product) => {
    if (!sourceIds.has(product.id)) products[product.id] = { ...product, active: false };
  });

  let outdated = false;
  await withTransactionData(`${OPERATIONS_PATH}/stock`, (reference) => runTransaction(reference, (value) => {
    const stock = { ...(value as Record<string, unknown> | null ?? {}) };
    if (Number(stock._inventoryRevision ?? -1) > revision) { outdated = true; return; }
    if (stock._catalogVersion === version && Number(stock._inventoryRevision) === revision) return;
    const bases = { ...(stock._catalogBases as Record<string, number> | undefined ?? {}) };
    sourceProducts.forEach((product) => {
      const quantity = productQuantity(product);
      if (!Number.isFinite(quantity) || quantity < 0) throw new Error(`Confira o saldo da geladeira de ${product.name}.`);
      const oldBase = bases[product.id] ?? catalog[product.id]?.baseQuantity;
      const nextQuantity = normalizedStockQuantity(stock[product.id] === undefined ? quantity : Number(stock[product.id]) + (oldBase === undefined ? 0 : quantity - Number(oldBase)));
      if (!Number.isFinite(nextQuantity) || nextQuantity < 0) throw new Error(`A movimentação de ${product.name} excede o saldo disponível na geladeira. Faça a conferência do produto.`);
      stock[product.id] = nextQuantity;
      bases[product.id] = quantity;
    });
    stock._catalogBases = bases;
    stock._catalogVersion = version;
    stock._inventoryRevision = revision;
    return stock;
  }, { applyLocally: false }));
  if (outdated) return;
  await withTransactionData(CATALOG_PATH, (reference) => runTransaction(reference, (current) => Number(current?._revision ?? -1) > revision ? undefined : { ...products, _revision: revision }, { applyLocally: false }));
  // A persisted debit can be recovered after a lost connection before sale creation.
  const stockSnapshot = await get(ref(db, `${OPERATIONS_PATH}/stock/_saleDebits`));
  const staged = Object.values((stockSnapshot.val() ?? {}) as Record<string, { sale: FrigobarSale; state: string }>).filter((item) => item.state === 'pending');
  for (const item of staged) {
    try {
      await withStockProductLocks(item.sale.items.map((line) => line.productId), async () => {
        const saleReference = ref(db, `${OPERATIONS_PATH}/sales/${item.sale.id}`);
        if (!(await get(saleReference)).exists()) await set(saleReference, item.sale);
        await set(ref(db, `${OPERATIONS_PATH}/stock/_saleDebits/${item.sale.id}/state`), 'recorded');
      });
    } catch (cause) {
      if (!(cause instanceof Error) || !cause.message.includes('outra sessão')) throw cause;
    }
  }
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
  if (!input.id || invalidInventoryKey(input.id)) throw new Error('A identificação da venda é inválida. Reabra o pedido.');
  if (input.settlement !== 'pago_na_recepcao' && input.settlement !== 'cobrar_no_checkout') throw new Error('Selecione receber agora ou lançar no quarto.');
  if (input.items.length === 0) throw new Error('Adicione pelo menos um produto à venda.');
  if (input.settlement === 'cobrar_no_checkout' && !input.roomNumber.trim()) throw new Error('Informe o quarto para lançar a venda no checkout.');
  if (input.settlement === 'pago_na_recepcao' && !['dinheiro', 'pix', 'cartao_debito', 'cartao_credito'].includes(input.paymentMethod)) throw new Error('Selecione a forma de pagamento recebida na recepção.');

  const saleRef = ref(db, `${OPERATIONS_PATH}/sales/${input.id}`);
  const existingSale = await get(saleRef);
  if (existingSale.exists()) return;

  const catalog = visibleProducts((await get(ref(db, CATALOG_PATH))).val());
  const grouped = new Map<string, number>();
  input.items.forEach((line) => {
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) throw new Error('A quantidade deve ser maior que zero.');
    grouped.set(line.productId, (grouped.get(line.productId) ?? 0) + line.quantity);
  });
  const items: FrigobarSale['items'] = [...grouped].map(([productId, quantity]) => {
    const product = catalog[productId];
    if (!product || product.active === false || !Number.isFinite(product.salePrice) || product.salePrice <= 0) throw new Error('Um dos produtos foi arquivado ou está sem preço de venda. Atualize o pedido.');
    return { productId: product.id, productName: product.name, quantity, unit: product.unit, unitPrice: product.salePrice };
  });
  const createdAt = new Date().toISOString();
  const sale: FrigobarSale = {
    id: input.id,
    items,
    amount: Math.round(items.reduce((total, item) => total + item.quantity * item.unitPrice, 0) * 100) / 100,
    settlement: input.settlement,
    paymentMethod: input.settlement === 'pago_na_recepcao' ? input.paymentMethod : '',
    roomNumber: input.roomNumber.trim(),
    guestName: input.guestName.trim(),
    actor: input.actor,
    createdAt,
    ...(input.settlement === 'pago_na_recepcao' ? { settledAt: createdAt, settledBy: input.actor } : {}),
  };

  await withStockProductLocks([...items.map((item) => item.productId), `sale-${input.id}`], async () => {
    if ((await get(saleRef)).exists()) return;
    let finalSale = sale;
    const result = await withTransactionData(`${OPERATIONS_PATH}/stock`, (stockRef) => runTransaction(stockRef, (value) => {
      const stock = { ...(value as Record<string, unknown> | null ?? {}) };
      const debits = { ...(stock._saleDebits as Record<string, { sale: FrigobarSale; state: string }> | undefined ?? {}) };
      if (debits[input.id]) {
        if (debits[input.id].state !== 'pending') throw new Error('Esta venda já foi registrada e excluída. Inicie um novo pedido.');
        finalSale = debits[input.id].sale;
        return stock;
      }
      for (const item of items) {
        const available = Number(stock[item.productId] ?? 0);
        if (!Number.isFinite(available) || available + STOCK_QUANTITY_EPSILON < item.quantity) throw new Error(`Saldo insuficiente de ${item.productName}. Disponível: ${available} ${item.unit}.`);
        stock[item.productId] = normalizedStockQuantity(available - item.quantity);
      }
      stock._saleDebits = { ...debits, [input.id]: { sale, state: 'pending' } };
      return stock;
    }, { applyLocally: false }));
    if (!result.committed) throw new Error('A venda não foi confirmada. Atualize o saldo e tente novamente.');
    try {
      await set(saleRef, finalSale);
    } catch (cause) {
      if ((await get(saleRef)).exists()) return;
      await withTransactionData(`${OPERATIONS_PATH}/stock`, (stockRef) => runTransaction(stockRef, (value) => {
        const stock = { ...(value as Record<string, unknown> | null ?? {}) };
        const debits = { ...(stock._saleDebits as Record<string, { sale: FrigobarSale; state: string }> | undefined ?? {}) };
        if (debits[input.id]?.state !== 'pending') return;
        finalSale.items.forEach((item) => { stock[item.productId] = Number(stock[item.productId] ?? 0) + item.quantity; });
        delete debits[input.id]; stock._saleDebits = debits;
        return stock;
      }, { applyLocally: false }));
      throw cause;
    }
    await set(ref(db, `${OPERATIONS_PATH}/stock/_saleDebits/${input.id}/state`), 'recorded');
  });
}

// Exclui a venda, devolve os itens ao saldo da geladeira e remove a receita do Financeiro.
export async function deleteFrigobarSale(sale: FrigobarSale): Promise<void> {
  await withStockProductLocks([...sale.items.map((item) => item.productId), `sale-${sale.id}`], () => removeFrigobarSale(sale));
}

async function removeFrigobarSale(sale: FrigobarSale): Promise<void> {
  const snapshot = await get(ref(db, `${OPERATIONS_PATH}/sales/${sale.id}`));
  if (!snapshot.exists()) return;
  const current = snapshot.val() as FrigobarSale;
  const updates: Record<string, unknown> = { [`${OPERATIONS_PATH}/sales/${sale.id}`]: null };
  if ((await get(ref(db, `${OPERATIONS_PATH}/stock/_saleDebits/${sale.id}`))).exists()) updates[`${OPERATIONS_PATH}/stock/_saleDebits/${sale.id}/state`] = 'deleted';
  const quantities: Record<string, number> = {};
  current.items.forEach((item) => { quantities[item.productId] = (quantities[item.productId] ?? 0) + item.quantity; });
  Object.entries(quantities).forEach(([id, quantity]) => { updates[`${OPERATIONS_PATH}/stock/${id}`] = increment(quantity); });
  removeFinanceEntries(updates, [`frigobar-${sale.id}`]);
  await commitDeletion([`sale-${sale.id}`], updates);
}

export async function settleFrigobarSale(saleId: string, paymentMethod: MinibarPaymentMethod, actor: string): Promise<void> {
  if (!['dinheiro', 'pix', 'cartao_debito', 'cartao_credito'].includes(paymentMethod)) throw new Error('Selecione uma forma de pagamento válida.');
  await withStockProductLocks([`sale-${saleId}`], () => receiveFrigobarSale(saleId, paymentMethod, actor));
}

async function receiveFrigobarSale(saleId: string, paymentMethod: MinibarPaymentMethod, actor: string): Promise<void> {
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
