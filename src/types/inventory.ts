export type StockCategory = 'limpeza' | 'rouparia' | 'manutencao' | 'frigobar';

export type MovementType =
  | 'entrada'
  | 'saida'
  | 'transferencia'
  | 'ajuste'
  | 'consumo_frigobar'
  | 'perda';

export type AssetStatus = 'em_uso' | 'em_manutencao' | 'baixado';
export type MinibarSettlement = 'pago_na_recepcao' | 'cobrar_no_checkout' | 'pago_no_checkout';
export type MinibarPaymentMethod = 'dinheiro' | 'pix' | 'cartao_debito' | 'cartao_credito';

export interface StockProduct {
  id: string;
  name: string;
  sku: string;
  category: StockCategory;
  unit: string;
  minimumQuantity: number;
  cost: number;
  salePrice: number;
  locationQuantities: Record<string, number>;
  supplierId: string;
  expiresAt: string;
  description: string;
  active?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StockSupplier {
  id: string;
  name: string;
  contact: string;
  phone: string;
  email: string;
  notes: string;
  createdAt: string;
}

export interface StockMovement {
  id: string;
  productId: string;
  productName: string;
  category: StockCategory;
  type: MovementType;
  quantity: number;
  unit: string;
  fromLocation: string;
  toLocation: string;
  reference: string;
  note: string;
  actor: string;
  unitPrice: number;
  settlement?: MinibarSettlement;
  paymentMethod?: MinibarPaymentMethod | '';
  roomNumber?: string;
  guestName?: string;
  settledAt?: string;
  settledBy?: string;
  createdAt: string;
}

export interface TrackedAsset {
  id: string;
  name: string;
  tag: string;
  serialNumber: string;
  location: string;
  status: AssetStatus;
  acquiredAt: string;
  cost: number;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryData {
  products: Record<string, StockProduct>;
  suppliers: Record<string, StockSupplier>;
  movements: Record<string, StockMovement>;
  assets: Record<string, TrackedAsset>;
}

export const STOCK_CATEGORIES: { id: StockCategory; label: string }[] = [
  { id: 'limpeza', label: 'Limpeza' },
  { id: 'rouparia', label: 'Rouparia' },
  { id: 'manutencao', label: 'Manutenção' },
  { id: 'frigobar', label: 'Geladeira - Recepção' },
];

export const STOCK_LOCATIONS = [
  'Almoxarifado central',
  'Rouparia limpa',
  'Lavanderia',
  'Manutenção',
  'Carrinho de limpeza',
  'Geladeira - Recepção',
];