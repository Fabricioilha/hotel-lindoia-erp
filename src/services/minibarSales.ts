import type {
  InventoryData,
  MinibarPaymentMethod,
  MinibarSettlement,
  StockMovement,
} from '../types/inventory';
import { recordOperationalIncome } from './operationalIncome';

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
  if (sale.items.length === 0) throw new Error('Adicione pelo menos um produto à venda.');
  if (sale.settlement === 'cobrar_no_checkout' && !sale.roomNumber.trim()) {
    throw new Error('Informe o quarto para lançar a venda no checkout.');
  }
  if (sale.settlement === 'pago_na_recepcao' && !sale.paymentMethod) {
    throw new Error('Selecione a forma de pagamento recebida na recepção.');
  }

  const createdAt = new Date().toISOString();
  const saleId = sale.id ?? crypto.randomUUID();
  const products = { ...current.products };
  const movements = { ...current.movements };

  for (const item of sale.items) {
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
      throw new Error('A quantidade da venda deve ser maior que zero.');
    }

    const product = products[item.productId];
    if (!product || product.category !== 'frigobar') {
      throw new Error('Um dos produtos não pertence à Geladeira - Recepção.');
    }
    if (product.salePrice <= 0) throw new Error(`Defina o preço de venda de ${product.name} antes de vender.`);

    const available = Number(product.locationQuantities[RECEPTION_LOCATION] ?? 0);
    if (available < item.quantity) {
      throw new Error(`Saldo insuficiente de ${product.name}. Disponível: ${available} ${product.unit}.`);
    }

    products[product.id] = {
      ...product,
      locationQuantities: {
        ...product.locationQuantities,
        [RECEPTION_LOCATION]: available - item.quantity,
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
  if (movement.type !== 'consumo_frigobar' || !movement.paymentMethod || (movement.settlement !== 'pago_na_recepcao' && movement.settlement !== 'pago_no_checkout')) return;
  const paymentMethods = {
    dinheiro: 'cash',
    pix: 'pix',
    cartao_debito: 'debit',
    cartao_credito: 'credit',
  } as const;
  await recordOperationalIncome({
    id: `minibar-${movement.id}`,
    date: (movement.settledAt ?? movement.createdAt).slice(0, 10),
    category: 'Consumo',
    description: `${movement.productName} · ${movement.quantity} ${movement.unit}`,
    amount: movement.quantity * movement.unitPrice,
    paymentMethod: paymentMethods[movement.paymentMethod],
    note: ['Frigobar', movement.roomNumber ? `Quarto ${movement.roomNumber}` : '', movement.guestName].filter(Boolean).join(' · '),
  });
}