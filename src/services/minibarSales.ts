import { STOCK_QUANTITY_EPSILON, normalizedStockQuantity,
  type InventoryData,
  type MinibarPaymentMethod,
  type MinibarSettlement,
  type StockMovement,
} from '../types/inventory';
import { recordOperationalIncome } from './operationalIncome';
import { minibarMovementFinanceEntry } from './operationalLedger';

export interface MinibarSaleInput {
  id?: string;
  items: { productId: string; quantity: number }[];
  settlement: MinibarSettlement;
  paymentMethod: MinibarPaymentMethod | '';
  roomNumber: string;
  guestName: string;
  actor: string;
}

const RECEPTION_LOCATION = 'Geladeira - Recepção';

export function applyMinibarSale(current: InventoryData, sale: MinibarSaleInput): InventoryData {
  if (sale.settlement !== 'pago_na_recepcao' && sale.settlement !== 'cobrar_no_checkout') throw new Error('Selecione a forma de cobrança da venda.');
  if (sale.items.length === 0) throw new Error('Adicione pelo menos um produto à venda.');
  if (sale.settlement === 'cobrar_no_checkout' && !sale.roomNumber.trim()) {
    throw new Error('Informe o quarto para lançar a venda no checkout.');
  }
  if (sale.settlement === 'pago_na_recepcao' && !['dinheiro', 'pix', 'cartao_debito', 'cartao_credito'].includes(sale.paymentMethod)) {
    throw new Error('Selecione a forma de pagamento recebida na recepção.');
  }

  const createdAt = new Date().toISOString();
  const saleId = sale.id ?? crypto.randomUUID();
  if (sale.items.every((item) => current.movements[`${saleId}-${item.productId}`])) return current;
  if (sale.items.some((item) => current.movements[`${saleId}-${item.productId}`])) throw new Error('Esta venda está parcialmente registrada. Atualize os dados antes de tentar novamente.');
  const products = { ...current.products };
  const movements = { ...current.movements };

  const grouped = new Map<string, number>();
  sale.items.forEach((item) => {
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) throw new Error('A quantidade da venda deve ser maior que zero.');
    grouped.set(item.productId, (grouped.get(item.productId) ?? 0) + item.quantity);
  });
  for (const [productId, quantity] of grouped) {
    const item = { productId, quantity };
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
      throw new Error('A quantidade da venda deve ser maior que zero.');
    }

    const product = products[item.productId];
    if (!product || product.category !== 'frigobar' || product.active === false) {
      throw new Error('Um dos produtos não pertence à Geladeira - Recepção.');
    }
    if (!Number.isFinite(product.salePrice) || product.salePrice <= 0) throw new Error(`Defina o preço de venda de ${product.name} antes de vender.`);

    const available = Number(product.locationQuantities[RECEPTION_LOCATION] ?? 0);
    if (available + STOCK_QUANTITY_EPSILON < item.quantity) {
      throw new Error(`Saldo insuficiente de ${product.name}. Disponível: ${available} ${product.unit}.`);
    }

    products[product.id] = {
      ...product,
      locationQuantities: {
        ...product.locationQuantities,
        [RECEPTION_LOCATION]: normalizedStockQuantity(available - item.quantity),
      },
      updatedAt: createdAt,
    };

    const movement: StockMovement = {
      id: `${saleId}-${product.id}`,
      productId: product.id,
      productName: product.name,
      category: product.category,
      type: 'consumo_frigobar',
      quantity: item.quantity,
      unit: product.unit,
      fromLocation: RECEPTION_LOCATION,
      toLocation: '',
      reference: [sale.roomNumber ? `Quarto ${sale.roomNumber}` : '', sale.guestName.trim()].filter(Boolean).join(' · '),
      note: '',
      actor: sale.actor,
      unitPrice: product.salePrice,
      settlement: sale.settlement,
      paymentMethod: sale.settlement === 'pago_na_recepcao' ? sale.paymentMethod : '',
      roomNumber: sale.roomNumber.trim(),
      guestName: sale.guestName.trim(),
      ...(sale.settlement === 'pago_na_recepcao' ? { settledAt: createdAt, settledBy: sale.actor } : {}),
      ...(sale.settlement === 'pago_na_recepcao' ? { financeSynced: false } : {}),
      createdAt,
    };
    movements[movement.id] = movement;
  }

  return { ...current, products, movements };
}

export async function recordMinibarIncome(movement: StockMovement): Promise<void> {
  const entry = minibarMovementFinanceEntry(movement);
  const item = entry?.items?.[0];
  if (!entry || !item) return;
  await recordOperationalIncome({
    id: entry.id, date: entry.date, category: entry.category, description: item.description,
    amount: item.amount, paymentMethod: item.paymentMethod, note: entry.note,
  });
}
