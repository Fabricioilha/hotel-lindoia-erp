import type { StockProduct } from '../types/inventory';
export const inventoryUnitCost = (product: Pick<StockProduct, 'averageCost' | 'cost'>) => product.averageCost ?? product.cost;
export function weightedInventoryCost(quantity: number, cost: number, addedQuantity: number, addedCost: number): number {
  const total = quantity + addedQuantity;
  if (total <= 1e-9) return cost;
  const value = quantity * cost + addedQuantity * addedCost;
  if (value < -0.005) throw new Error('Esta exclusão deixaria o custo do estoque inconsistente. Revise os movimentos posteriores antes de excluir.');
  return Math.round(Math.max(0, value / total) * 1e6) / 1e6;
}
export function effectiveStockQuantity(product: StockProduct, receptionQuantity?: number): number {
  const locations = { ...product.locationQuantities };
  if (product.category === 'frigobar' && receptionQuantity !== undefined) locations['Geladeira - Recepção'] = receptionQuantity;
  return Object.values(locations).reduce((sum, quantity) => sum + Number(quantity || 0), 0);
}
