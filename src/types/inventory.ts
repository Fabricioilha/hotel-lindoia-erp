// Categoria livre (id); somente 'frigobar' é fixa e é a única com itens à venda.
export type StockCategory = string;
export const SALES_CATEGORY_ID = 'frigobar';

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
  financeSynced?: boolean;
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

export interface StockCategoryRecord {
  id: string;
  name: string;
}

export interface InventoryData {
  categories?: Record<string, StockCategoryRecord>;
  categoriesConfigured?: boolean;
  products: Record<string, StockProduct>;
  suppliers: Record<string, StockSupplier>;
  movements: Record<string, StockMovement>;
  assets: Record<string, TrackedAsset>;
}

export const DEFAULT_STOCK_CATEGORIES: StockCategoryRecord[] = [
  { id: 'limpeza', name: 'Limpeza' },
  { id: 'manutencao', name: 'Manutenção e reposição' },
  { id: 'rouparia', name: 'Rouparia' },
  { id: 'cafe_manha', name: 'Café da manhã' },
  { id: 'camareiras', name: 'Uso das camareiras' },
  { id: 'lavanderia', name: 'Lavanderia' },
  { id: 'quartos', name: 'Itens dos quartos' },
];

export const SALES_CATEGORY: StockCategoryRecord = { id: SALES_CATEGORY_ID, name: 'Geladeira - Recepção' };

// Categorias editáveis; enquanto ninguém as altera, vale a lista padrão.
export function customCategoriesOf(data: Pick<InventoryData, 'categories' | 'categoriesConfigured'>): StockCategoryRecord[] {
  const list = data.categoriesConfigured ? Object.values(data.categories ?? {}) : DEFAULT_STOCK_CATEGORIES;
  return [...list].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

export function stockCategoriesOf(data: Pick<InventoryData, 'categories' | 'categoriesConfigured'>): StockCategoryRecord[] {
  return [...customCategoriesOf(data), SALES_CATEGORY];
}

export const STOCK_LOCATIONS = [
  'Almoxarifado central',
  'Rouparia limpa',
  'Lavanderia',
  'Manutenção',
  'Carrinho de limpeza',
  'Geladeira - Recepção',
];