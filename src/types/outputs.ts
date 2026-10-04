export interface OutputCatalogItem {
  id: string;
  name: string;
  unit: string;
  category: string;
  categoryName: string;
  available: number;
}

export interface OutputItem {
  productId: string;
  productName: string;
  unit: string;
  quantity: number;
}

export interface OutputRecord {
  id: string;
  items: OutputItem[];
  destination: string;
  note: string;
  actor: string;
  createdAt: string;
  applied?: boolean;
}

export interface OutputData {
  catalog: Record<string, OutputCatalogItem>;
  records: Record<string, OutputRecord>;
}

export const OUTPUT_DESTINATIONS = ['Camareiras', 'Lavanderia', 'Manutenção', 'Café da manhã', 'Recepção'];
