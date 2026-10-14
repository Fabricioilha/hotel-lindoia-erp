import { get, ref } from 'firebase/database';
import { db } from '../config/firebase';
import { invalidInventoryKey, normalizeInventory, updateInventory } from './inventoryStore';
import { syncFrigobarCatalog, withStockProductLocks } from './frigobarStore';
import { SALES_CATEGORY_ID, STOCK_QUANTITY_EPSILON, normalizedStockQuantity, stockCategoriesOf, type InventoryData, type MovementType, type StockMovement, type StockProduct } from '../types/inventory';

export const RECEPTION_STOCK_LOCATION = 'Geladeira - Recepção';
export interface InventoryMovementInput {
  id: string; productId: string; type: MovementType; quantity: number;
  fromLocation: string; toLocation: string; unitPrice: number; reference: string; note: string; actor: string;
  createdAt: string; entryPayment?: 'pendente' | 'caixa' | 'banco'; paidDate?: string;
}

function validateLocation(location: string) {
  if (!location.trim()) throw new Error('Informe o local da movimentação.');
  if (invalidInventoryKey(location)) throw new Error('Use um nome de local sem . / # $ [ ou ].');
}

export function mergeProductRegistration(current: InventoryData, product: StockProduct): InventoryData {
  if (!product.name.trim() || !product.unit.trim() || !product.category) throw new Error('Informe nome, categoria e unidade do produto.');
  if ([product.minimumQuantity, product.cost, product.salePrice].some((amount) => !Number.isFinite(amount) || amount < 0)) throw new Error('Confira os valores de preço e estoque mínimo.');
  if (product.category === SALES_CATEGORY_ID && product.salePrice <= 0) throw new Error('Informe o preço de venda do produto da geladeira.');
  if (!stockCategoriesOf(current).some((category) => category.id === product.category) && current.products[product.id]?.category !== product.category) throw new Error('Esta categoria foi removida. Selecione outra categoria.');
  if (product.supplierId && !current.suppliers[product.supplierId]) throw new Error('Este fornecedor foi removido. Atualize a seleção.');
  if (product.sku && Object.values(current.products).some((item) => item.id !== product.id && item.sku.trim().toLocaleLowerCase('pt-BR') === product.sku.trim().toLocaleLowerCase('pt-BR'))) throw new Error('Já existe um produto com este código / SKU.');
  const existing = current.products[product.id];
  return { ...current, products: { ...current.products, [product.id]: { ...existing, ...product, locationQuantities: existing?.locationQuantities ?? product.locationQuantities, createdAt: existing?.createdAt ?? product.createdAt } } };
}

export function applyInventoryMovement(current: InventoryData, input: InventoryMovementInput, receptionQuantity?: number): InventoryData {
  if (current.movements[input.id]) return current;
  const product = current.products[input.productId];
  if (!product || product.active === false) throw new Error('Este produto foi excluído ou arquivado. Atualize a seleção.');
  if (!['entrada', 'saida', 'transferencia', 'ajuste', 'perda'].includes(input.type)) throw new Error('Escolha um tipo válido de movimentação.');
  if (!Number.isFinite(input.quantity) || input.quantity < 0 || (input.type !== 'ajuste' && input.quantity === 0)) throw new Error('Informe uma quantidade válida maior que zero.');
  if (!Number.isFinite(input.unitPrice) || input.unitPrice < 0) throw new Error('Confira o preço unitário informado.');
  const from = input.fromLocation.trim(); const to = input.toLocation.trim();
  if (input.type !== 'entrada') validateLocation(from);
  if (input.type === 'entrada' || input.type === 'transferencia') validateLocation(to);
  if (input.type === 'transferencia' && from === to) throw new Error('Escolha locais diferentes para transferir.');
  const locations = { ...product.locationQuantities };
  const stored = Number(locations[from] ?? 0);
  const isReception = product.category === SALES_CATEGORY_ID && from === RECEPTION_STOCK_LOCATION;
  const available = isReception && receptionQuantity !== undefined ? receptionQuantity : stored;
  let quantity = input.quantity; let fromLocation = from; let toLocation = to;
  if (input.type === 'entrada') { locations[to] = Number(locations[to] ?? 0) + quantity; fromLocation = ''; }
  else if (input.type === 'ajuste') {
    const delta = quantity - available;
    if (delta === 0) throw new Error('A contagem já corresponde ao saldo atual. Nenhuma alteração é necessária.');
    locations[from] = isReception ? stored + delta : quantity;
    quantity = Math.abs(delta); fromLocation = delta < 0 ? from : ''; toLocation = delta > 0 ? from : '';
  } else {
    if (available + STOCK_QUANTITY_EPSILON < quantity) throw new Error(`Saldo insuficiente em ${from}. Disponível: ${available} ${product.unit}.`);
    locations[from] = isReception ? stored - quantity : available - quantity;
    if (input.type === 'transferencia') locations[to] = Number(locations[to] ?? 0) + quantity;
    else toLocation = '';
  }
  Object.keys(locations).forEach((location) => { locations[location] = normalizedStockQuantity(locations[location]); });
  if (Object.values(locations).some((amount) => !Number.isFinite(amount) || amount < 0)) throw new Error('O saldo do produto ficou inconsistente. Faça a conferência antes de continuar.');
  const movement: StockMovement = {
    id: input.id, productId: product.id, productName: product.name, category: product.category, type: input.type,
    quantity, unit: product.unit, fromLocation, toLocation, reference: input.reference, actor: input.actor, unitPrice: input.unitPrice,
    note: input.type === 'ajuste' ? `${input.note}${input.note ? ' · ' : ''}Contagem informada: ${input.quantity} ${product.unit}.` : input.note,
    createdAt: input.createdAt,
    ...(input.type === 'entrada' ? { previousUnitCost: Number(product.cost) || 0, entryPayment: input.entryPayment ?? 'pendente', ...(input.paidDate ? { paidDate: input.paidDate } : {}), financeSynced: Math.round(input.quantity * input.unitPrice * 100) === 0 } : {}),
  };
  return { ...current,
    products: { ...current.products, [product.id]: { ...product, locationQuantities: locations, ...(input.type === 'entrada' ? { cost: input.unitPrice } : {}), updatedAt: input.createdAt } },
    movements: { ...current.movements, [movement.id]: movement },
  };
}

export async function recordInventoryMovement(input: InventoryMovementInput): Promise<void> {
  const snapshot = await get(ref(db, `erp_geral/estoque/products/${input.productId}`));
  const product = snapshot.val() as StockProduct | null;
  if (!product) throw new Error('O produto foi excluído. Atualize a seleção.');
  const execute = async () => {
    let available: number | undefined;
    if (product.category === SALES_CATEGORY_ID) {
      await syncFrigobarCatalog(normalizeInventory((await get(ref(db, 'erp_geral/estoque'))).val()));
      available = Number((await get(ref(db, `erp_geral/frigobar/operations/stock/${product.id}`))).val() ?? 0);
    }
    await updateInventory((current) => applyInventoryMovement(current, input, available));
    if (product.category === SALES_CATEGORY_ID) await syncFrigobarCatalog(normalizeInventory((await get(ref(db, 'erp_geral/estoque'))).val()));
  };
  await withStockProductLocks([product.id], execute);
}
