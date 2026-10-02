import type { MinibarPaymentMethod, MinibarSettlement } from './inventory';

export interface FrigobarProduct {
  id: string;
  name: string;
  unit: string;
  salePrice: number;
  baseQuantity: number;
  active: boolean;
}

export interface FrigobarSaleItem {
  productId: string;
  productName: string;
  quantity: number;
  unit: string;
  unitPrice: number;
}

export interface FrigobarSale {
  id: string;
  items: FrigobarSaleItem[];
  amount: number;
  settlement: MinibarSettlement;
  paymentMethod: MinibarPaymentMethod | '';
  roomNumber: string;
  guestName: string;
  actor: string;
  createdAt: string;
  settledAt?: string;
  settledBy?: string;
}

export interface FrigobarOperations {
  stock: Record<string, number>;
  sales: Record<string, FrigobarSale>;
  catalogSyncs: Record<string, boolean>;
}

export interface FrigobarData {
  products: Record<string, FrigobarProduct>;
  stock: Record<string, number>;
  sales: Record<string, FrigobarSale>;
}