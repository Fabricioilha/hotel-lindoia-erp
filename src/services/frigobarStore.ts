import { get, onValue, ref, runTransaction, set } from 'firebase/database';
import { db } from '../config/firebase';
import { updateFinance } from './financeStore';
import type { InventoryData, MinibarPaymentMethod, MinibarSettlement, StockProduct } from '../types/inventory';
import type { FrigobarData, FrigobarOperations, FrigobarProduct, FrigobarSale } from '../types/frigobar';

const CATALOG_PATH = 'erp_geral/frigobar/catalog';
const OPERATIONS_PATH = 'erp_geral/frigobar/operations';
const RECEPTION_LOCATION = 'Geladeira - Recepção';

function normalizeOperations(value: unknown): FrigobarOperations {
  const data = value && typeof value === 'object' ? value as Partial<FrigobarOperations> : {};
  return { stock: data.stock ?? {}, sales: data.sales ?? {}, catalogSyncs: data.catalogSyncs ?? {} };
}

export function emptyFrigobar(): FrigobarData {
  return { products: {}, stock: {}, sales: {} };
}

export function subscribeFrigobar(onChange: (data: FrigobarData) => void, onError: (error: Error) => void): () => void {
  let catalog: Record<string, FrigobarProduct> | undefined;
  let operations: FrigobarOperations | undefined;
  const publish = () => {
    if (!catalog || !operations) return;
    onChange({ products: catalog, stock: operations.stock, sales: operations.sales });
  };
  const stopCatalog = onValue(ref(db, CATALOG_PATH), (snapshot) => {
    catalog = snapshot.val() ?? {};
    publish();
  }, onError);
  const stopOperations = onValue(ref(db, OPERATIONS_PATH), (snapshot) => {
    operations = normalizeOperations(snapshot.val());
    publish();
  }, onError);
  return () => {
    stopCatalog();
    stopOperations();
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

  const version = inventoryVersion(inventory.products);
  const result = await runTransaction(ref(db, OPERATIONS_PATH), (value) => {
    const operations = normalizeOperations(value);
    if (operations.catalogSyncs[version]) return operations;
    const stock = { ...operations.stock };
    Object.entries(initialStock).forEach(([id, quantity]) => {
      if (stock[id] === undefined) stock[id] = quantity;
    });
    Object.entries(stockDeltas).forEach(([id, delta]) => {
      stock[id] = Math.max(0, Number(stock[id] ?? 0) + delta);
    });
    return { ...operations, stock, catalogSyncs: { ...operations.catalogSyncs, [version]: true } };
  });
  if (!result.committed) throw new Error('Não foi possível sincronizar os produtos da geladeira.');
  await set(ref(db, CATALOG_PATH), products);
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

  const result = await runTransaction(ref(db, OPERATIONS_PATH), (value) => {
    const current = normalizeOperations(value);
    if (current.sales[input.id]) return current;
    const stock = { ...current.stock };
    const items: FrigobarSale['items'] = [];
    for (const line of input.items) {
      if (!Number.isFinite(line.quantity) || line.quantity <= 0) throw new Error('A quantidade deve ser maior que zero.');
      const product = input.catalog[line.productId];
      if (!product || !product.active || product.salePrice <= 0) throw new Error('Um dos produtos não está disponível para venda.');
      const available = Number(stock[product.id] ?? 0);
      if (available < line.quantity) throw new Error(`Saldo insuficiente de ${product.name}. Disponível: ${available} ${product.unit}.`);
      stock[product.id] = available - line.quantity;
      items.push({ productId: product.id, productName: product.name, quantity: line.quantity, unit: product.unit, unitPrice: product.salePrice });
    }

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
    return { ...current, stock, sales: { ...current.sales, [sale.id]: sale } };
  });
  if (!result.committed) throw new Error('A venda não foi confirmada. Atualize o saldo e tente novamente.');
}

// Exclui a venda, devolve os itens ao saldo da geladeira e remove a receita do Financeiro.
export async function deleteFrigobarSale(sale: FrigobarSale): Promise<void> {
  const result = await runTransaction(ref(db, OPERATIONS_PATH), (value) => {
    const current = normalizeOperations(value);
    if (!current.sales[sale.id]) return current;
    const sales = { ...current.sales };
    delete sales[sale.id];
    const stock = { ...current.stock };
    sale.items.forEach((item) => { stock[item.productId] = Number(stock[item.productId] ?? 0) + item.quantity; });
    return { ...current, sales, stock };
  });
  if (!result.committed) throw new Error('Não foi possível excluir a venda da geladeira.');
  await updateFinance((current) => {
    const id = `frigobar-${sale.id}`;
    if (!current.incomes[id]) return current;
    const incomes = { ...current.incomes };
    delete incomes[id];
    return { ...current, incomes };
  });
}

export async function settleFrigobarSale(saleId: string, paymentMethod: MinibarPaymentMethod, actor: string): Promise<void> {
  const result = await runTransaction(ref(db, OPERATIONS_PATH), (value) => {
    const current = normalizeOperations(value);
    const sale = current.sales[saleId];
    if (!sale || sale.settlement !== 'cobrar_no_checkout') throw new Error('Esta cobrança não está mais pendente.');
    return {
      ...current,
      sales: {
        ...current.sales,
        [saleId]: { ...sale, settlement: 'pago_no_checkout', paymentMethod, settledAt: new Date().toISOString(), settledBy: actor },
      },
    };
  });
  if (!result.committed) throw new Error('Não foi possível registrar o recebimento do frigobar.');
}