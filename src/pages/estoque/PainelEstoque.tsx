import { createContext, useContext, useEffect, useMemo, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { SidebarSlotContext } from '../../components/layout/sidebarSlot';
import { subscribeInventory, updateInventory } from '../../services/inventoryStore';
import { updateFinance } from '../../services/financeStore';
import { DateInput } from '../../components/ui/DateInput';
import { useMinibarFinanceSync } from '../../services/minibarFinanceSync';
import { createFrigobarSale, emptyFrigobar, subscribeFrigobar, syncFrigobarCatalog } from '../../services/frigobarStore';
import { useFrigobarFinanceSync } from '../../services/minibarFinanceSync';
import type { FrigobarData } from '../../types/frigobar';
import {
  SALES_CATEGORY,
  SALES_CATEGORY_ID,
  STOCK_LOCATIONS,
  customCategoriesOf,
  stockCategoriesOf,
  type AssetStatus,
  type InventoryData,
  type MinibarPaymentMethod,
  type MinibarSettlement,
  type MovementType,
  type StockCategory,
  type StockCategoryRecord,
  type StockMovement,
  type StockProduct,
  type StockSupplier,
  type TrackedAsset,
} from '../../types/inventory';
import './estoque.css';

type View = 'resumo' | 'produtos' | 'movimentacoes' | 'fornecedores' | 'patrimonio';
type Modal = 'produto' | 'movimento' | 'fornecedor' | 'patrimonio' | 'checkout' | 'categorias' | null;

const emptyData: InventoryData = { products: {}, suppliers: {}, movements: {}, assets: {} };
const newId = () => crypto.randomUUID();
const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dateTime = (value: string) => new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const CategoriesContext = createContext<StockCategoryRecord[]>([]);
const nameOfCategory = (categories: StockCategoryRecord[], id: StockCategory) => categories.find((item) => item.id === id)?.name ?? 'Sem categoria';
const NEW_CATEGORY = '__new__';
const withCategories = (data: InventoryData, list: StockCategoryRecord[]): InventoryData => ({ ...data, categoriesConfigured: true, categories: Object.fromEntries(list.map((item) => [item.id, item])) });
// Cores fixas são dadas por CSS nas categorias originais; as demais derivam do id.
const CLASSIC_CATEGORIES = new Set(['limpeza', 'rouparia', 'manutencao', 'frigobar']);
const hueOf = (id: string) => [...id].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7);
const dotStyle = (id: string) => CLASSIC_CATEGORIES.has(id) ? undefined : { background: `hsl(${hueOf(id)} 45% 58%)` };
const stampStyle = (id: string) => CLASSIC_CATEGORIES.has(id) ? undefined : { color: `hsl(${hueOf(id)} 40% 32%)`, background: `hsl(${hueOf(id)} 55% 92%)` };

function quantityOf(product: StockProduct) {
  return Object.values(product.locationQuantities ?? {}).reduce((total, quantity) => total + Number(quantity || 0), 0);
}

function movementName(type: MovementType) {
  const names: Record<MovementType, string> = {
    entrada: 'Entrada',
    saida: 'Saída',
    transferencia: 'Transferência',
    ajuste: 'Ajuste de inventário',
    consumo_frigobar: 'Venda da geladeira',
    perda: 'Perda / descarte',
  };
  return names[type];
}

function movementTone(type: MovementType) {
  if (type === 'entrada') return 'positive';
  if (type === 'saida' || type === 'perda' || type === 'consumo_frigobar') return 'negative';
  return 'neutral';
}

function exportCsv(filename: string, rows: (string | number)[][]) {
  const content = rows
    .map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(';'))
    .join('\r\n');
  const url = URL.createObjectURL(new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// A compra de estoque é despesa do hotel; o id fixo evita duplicar o lançamento.
async function recordEntryExpense(movementId: string, description: string, total: number, payment: string) {
  const today = new Date();
  const dueDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const stamp = today.toISOString();
  await updateFinance((current) => {
    const id = `stock-entry-${movementId}`;
    if (current.expenses[id]) return current;
    const hasCategory = current.expenseCategories.some((item) => item.toLocaleLowerCase('pt-BR') === 'estoque');
    return {
      ...current,
      expenseCategories: hasCategory ? current.expenseCategories : [...current.expenseCategories, 'Estoque'],
      expenses: { ...current.expenses, [id]: { id, dueDate, category: 'Estoque', plannedAmount: total, paidCash: payment === 'caixa' ? total : 0, paidBank: payment === 'banco' ? total : 0, note: description, createdAt: stamp, updatedAt: stamp } },
    };
  });
}

function StockStatus({ product }: { product: StockProduct }) {
  const quantity = quantityOf(product);
    if (quantity <= 0) return <span className="stock-status status-out">Sem estoque</span>;
  if (product.minimumQuantity > 0 && quantity <= product.minimumQuantity) {
    return <span className="stock-status status-low">Estoque baixo</span>;
  }
  return <span className="stock-status status-ok">Disponível</span>;
}

export function PainelEstoque({ actor = 'Equipe', canViewFinancials = true }: { actor?: string; canViewFinancials?: boolean }) {
  const [data, setData] = useState<InventoryData>(emptyData);
  const [frigobar, setFrigobar] = useState<FrigobarData>(emptyFrigobar());
    const [loading, setLoading] = useState(true);
  const [storageError, setStorageError] = useState('');
  const [view, setView] = useState<View>('resumo');
  const [categoryFilter, setCategoryFilter] = useState<StockCategory | 'todas'>('todas');
  const sidebarSlot = useContext(SidebarSlotContext);
  const [closedSections, setClosedSections] = useState<Record<string, boolean>>({});
  const toggleSection = (key: string) => setClosedSections((current) => ({ ...current, [key]: !current[key] }));
  const [search, setSearch] = useState('');
  const [stockFilter, setStockFilter] = useState<'todos' | 'baixo' | 'zerado'>('todos');
  const [modal, setModal] = useState<Modal>(null);
  const [editingId, setEditingId] = useState('');
  const [movementProductId, setMovementProductId] = useState('');
  const [movementType, setMovementType] = useState<MovementType>('entrada');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const categories = useMemo(() => stockCategoriesOf(data), [data]);
  const categoryName = (id: StockCategory) => nameOfCategory(categories, id);

  useMinibarFinanceSync(data, setStorageError);
  useFrigobarFinanceSync(frigobar.sales, true, setStorageError);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const productId = params.get('produto');
    let openedEntry = false;
    return subscribeInventory((next) => {
      setData(next);
      setLoading(false);
      setStorageError('');
      if (openedEntry || params.get('movimento') !== 'entrada' || !productId || !next.products[productId]) return;
      openedEntry = true;
      setView('produtos');
      setCategoryFilter(next.products[productId].category);
      setEditingId('');
      setMovementProductId(productId);
      setMovementType('entrada');
      setModal('movimento');
      window.history.replaceState(window.history.state, '', window.location.pathname);
    }, (error) => {
      setStorageError(error.message);
      setLoading(false);
    });
  }, []);

  useEffect(() => subscribeFrigobar(setFrigobar, (error) => setStorageError(error.message)), []);

  useEffect(() => {
    if (loading) return;
    void syncFrigobarCatalog(data).catch((error) => setStorageError(error instanceof Error ? error.message : 'Não foi possível atualizar o catálogo da geladeira.'));
  }, [data, loading]);

  const products = useMemo(() => Object.values(data.products).map((product) => product.category === SALES_CATEGORY_ID
    ? { ...product, locationQuantities: { ...product.locationQuantities, 'Geladeira - Recepção': Number(frigobar.stock[product.id] ?? product.locationQuantities['Geladeira - Recepção'] ?? 0) } }
    : product).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')), [data.products, frigobar.stock]);
  const movements = useMemo(() => Object.values(data.movements).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [data.movements]);
  const suppliers = useMemo(() => Object.values(data.suppliers).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')), [data.suppliers]);
  const assets = useMemo(() => Object.values(data.assets).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')), [data.assets]);
  const lowStock = products.filter((product) => product.active !== false && product.minimumQuantity > 0 && quantityOf(product) <= product.minimumQuantity);
  const outOfStock = products.filter((product) => quantityOf(product) <= 0);
  const inventoryValue = products.reduce((total, product) => total + quantityOf(product) * product.cost, 0);
  const minibarSales = movements
    .filter((movement) => movement.type === 'consumo_frigobar' && (movement.settlement === 'pago_na_recepcao' || movement.settlement === 'pago_no_checkout'))
    .reduce((total, movement) => total + movement.quantity * movement.unitPrice, 0)
    + Object.values(frigobar.sales).filter((sale) => sale.settlement !== 'cobrar_no_checkout').reduce((total, sale) => total + sale.amount, 0);
  const minibarPending = movements
    .filter((movement) => movement.type === 'consumo_frigobar' && movement.settlement === 'cobrar_no_checkout')
    .reduce((total, movement) => total + movement.quantity * movement.unitPrice, 0)
    + Object.values(frigobar.sales).filter((sale) => sale.settlement === 'cobrar_no_checkout').reduce((total, sale) => total + sale.amount, 0);
  const selectedProduct = products.find((product) => product.id === movementProductId);
  const filteredProducts = products.filter((product) => {
    const matchesCategory = categoryFilter === 'todas' || product.category === categoryFilter;
    const matchesSearch = `${product.name} ${product.sku}`.toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR'));
    const quantity = quantityOf(product);
    const matchesStock = stockFilter === 'todos'
      || (stockFilter === 'baixo' && product.minimumQuantity > 0 && quantity <= product.minimumQuantity && quantity > 0)
      || (stockFilter === 'zerado' && quantity <= 0);
    return matchesCategory && matchesSearch && matchesStock;
  });

  function openProduct(product?: StockProduct) {
    setEditingId(product?.id ?? '');
    setModal('produto');
  }

  function openSupplier(supplier?: StockSupplier) {
    setEditingId(supplier?.id ?? '');
    setModal('fornecedor');
  }

  function openAsset(asset?: TrackedAsset) {
    setEditingId(asset?.id ?? '');
    setModal('patrimonio');
  }

  function openMovement(product?: StockProduct, type: MovementType = 'entrada') {
    const fallbackProduct = product ?? products[0];
    setMovementProductId(fallbackProduct?.id ?? '');
    setMovementType(type);
    setModal('movimento');
  }

  async function commit(update: (current: InventoryData) => InventoryData, successMessage: string): Promise<boolean> {
    setSaving(true);
    setStorageError('');
    try {
      await updateInventory(update);
      setModal(null);
      setNotice(successMessage);
      window.setTimeout(() => setNotice(''), 4000);
      return true;
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Não foi possível salvar os dados.');
      return false;
    } finally {
      setSaving(false);
    }
  }

  function saveProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const existing = data.products[editingId];
    const timestamp = new Date().toISOString();
    const chosenCategory = String(form.get('category'));
    const newCategoryName = String(form.get('newCategory') ?? '').trim();
    let newCategory: StockCategoryRecord | undefined;
    if (chosenCategory === NEW_CATEGORY) {
      if (!newCategoryName) { setStorageError('Informe o nome da nova categoria.'); return; }
      const sameName = categories.find((item) => item.name.toLocaleLowerCase('pt-BR') === newCategoryName.toLocaleLowerCase('pt-BR'));
      newCategory = sameName ?? { id: newId(), name: newCategoryName };
    }
    const categoryId = newCategory?.id ?? chosenCategory;
    const product: StockProduct = {
      id: existing?.id ?? newId(),
      name: String(form.get('name')).trim(),
      sku: String(form.get('sku')).trim(),
      category: categoryId,
      unit: String(form.get('unit')).trim(),
      minimumQuantity: Number(form.get('minimumQuantity')) || 0,
      cost: canViewFinancials ? Number(form.get('cost')) || 0 : existing?.cost ?? 0,
      salePrice: categoryId !== SALES_CATEGORY_ID ? 0 : canViewFinancials ? Number(form.get('salePrice')) || 0 : existing?.salePrice ?? 0,
      locationQuantities: existing?.locationQuantities ?? { 'Almoxarifado central': 0 },
      supplierId: String(form.get('supplierId') ?? ''),
      expiresAt: String(form.get('expiresAt') ?? ''),
      description: String(form.get('description') ?? '').trim(),
      active: existing?.active ?? true,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    if (product.category === SALES_CATEGORY_ID && product.salePrice <= 0) {
      setStorageError('Informe um preço de venda para os produtos da Geladeira - Recepção.');
      return;
    }
    void commit((current) => {
      const base = newCategory && !customCategoriesOf(current).some((item) => item.id === newCategory.id)
        ? withCategories(current, [...customCategoriesOf(current), newCategory])
        : current;
      return { ...base, products: { ...base.products, [product.id]: product } };
    }, existing ? 'Produto atualizado.' : 'Produto cadastrado. Registre uma entrada para informar o saldo inicial.');
  }

  async function changeCategories(mutate: (list: StockCategoryRecord[], current: InventoryData) => StockCategoryRecord[], message: string) {
    setSaving(true);
    setStorageError('');
    try {
      await updateInventory((current) => {
        const next = mutate(customCategoriesOf(current), current).map((item) => ({ id: item.id, name: item.name.trim() }));
        if (next.some((item) => !item.name)) throw new Error('Informe o nome da categoria.');
        const names = [...next.map((item) => item.name), SALES_CATEGORY.name].map((name) => name.toLocaleLowerCase('pt-BR'));
        if (new Set(names).size !== names.length) throw new Error('Já existe uma categoria com este nome.');
        return withCategories(current, next);
      });
      setNotice(message);
      window.setTimeout(() => setNotice(''), 4000);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Não foi possível salvar as categorias.');
    } finally {
      setSaving(false);
    }
  }

  function removeCategory(category: StockCategoryRecord) {
    if (!window.confirm(`Excluir a categoria "${category.name}"?`)) return;
    void changeCategories((list, current) => {
      if (Object.values(current.products).some((product) => product.category === category.id)) throw new Error('Há produtos nesta categoria. Altere a categoria deles antes de excluí-la.');
      return list.filter((item) => item.id !== category.id);
    }, 'Categoria excluída.');
    if (categoryFilter === category.id) setCategoryFilter('todas');
  }

async function deleteProduct(product: StockProduct) {
    if (!window.confirm(`ATENÇÃO: Excluir o produto "${product.name}" definitivamente?\n\nIsso apagará o produto e também removerá TODO o histórico de movimentações (entradas, saídas e ajustes) vinculado a ele. Essa ação não pode ser desfeita.`)) return;
    
    await commit((current) => {
      const nextProducts = { ...current.products };
      delete nextProducts[product.id]; // Apaga o produto do cadastro
      
      const nextMovements = { ...current.movements };
      // Varre o banco de dados e destrói qualquer movimentação ligada a este produto
      Object.keys(nextMovements).forEach(movId => {
        if (nextMovements[movId].productId === product.id) {
          delete nextMovements[movId];
        }
      });
      
      return { ...current, products: nextProducts, movements: nextMovements };
    }, 'Produto e histórico de movimentações excluídos com sucesso.');
  }

  async function toggleProductArchive(product: StockProduct) {
    const nextActive = product.active === false;
    if (!window.confirm(`${nextActive ? 'Reativar' : 'Arquivar'} o produto "${product.name}"?`)) return;
    await commit((current) => {
      const existing = current.products[product.id];
      if (!existing) throw new Error('Produto não encontrado.');
      return {
        ...current,
        products: { ...current.products, [product.id]: { ...existing, active: nextActive, updatedAt: new Date().toISOString() } },
      };
    }, `Produto ${nextActive ? 'reativado' : 'arquivado'}.`);
  }

  function saveSupplier(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const existing = data.suppliers[editingId];
    const supplier: StockSupplier = {
      id: existing?.id ?? newId(),
      name: String(form.get('name')).trim(),
      contact: String(form.get('contact') ?? '').trim(),
      phone: String(form.get('phone') ?? '').trim(),
      email: String(form.get('email') ?? '').trim(),
      notes: String(form.get('notes') ?? '').trim(),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    void commit((current) => ({ ...current, suppliers: { ...current.suppliers, [supplier.id]: supplier } }), 'Fornecedor salvo.');
  }

  function saveAsset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const existing = data.assets[editingId];
    const timestamp = new Date().toISOString();
    const asset: TrackedAsset = {
      id: existing?.id ?? newId(),
      name: String(form.get('name')).trim(),
      tag: String(form.get('tag') ?? '').trim(),
      serialNumber: String(form.get('serialNumber') ?? '').trim(),
      location: String(form.get('location')).trim(),
      status: String(form.get('status')) as AssetStatus,
      acquiredAt: String(form.get('acquiredAt') ?? ''),
      cost: canViewFinancials ? Number(form.get('cost')) || 0 : existing?.cost ?? 0,
      notes: String(form.get('notes') ?? '').trim(),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    void commit((current) => ({ ...current, assets: { ...current.assets, [asset.id]: asset } }), existing ? 'Patrimônio atualizado.' : 'Bem patrimonial cadastrado.');
  }

  function saveMovement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedProduct) return;
    const form = new FormData(event.currentTarget);
    const quantity = Number(form.get('quantity'));
    const fromLocation = String(form.get('fromLocation') ?? '').trim();
    const toLocation = String(form.get('toLocation') ?? '').trim();
    const reference = String(form.get('reference') ?? '').trim();
    const note = String(form.get('note') ?? '').trim();
    const settlement = String(form.get('settlement') ?? '') as MinibarSettlement;
    const paymentMethod = String(form.get('paymentMethod') ?? '') as MinibarPaymentMethod | '';
    const roomNumber = String(form.get('roomNumber') ?? '').trim();
    const guestName = String(form.get('guestName') ?? '').trim();
    if (movementType === 'consumo_frigobar' && settlement !== 'pago_na_recepcao' && settlement !== 'cobrar_no_checkout') {
      setStorageError('Selecione como a cobrança será feita.');
      return;
    }
    if (movementType === 'consumo_frigobar' && settlement === 'cobrar_no_checkout' && !roomNumber) {
      setStorageError('Informe o quarto para deixar a cobrança pendente para o checkout.');
      return;
    }
    if (movementType === 'consumo_frigobar' && settlement === 'pago_na_recepcao' && !paymentMethod) {
      setStorageError('Selecione como o hóspede pagou na recepção.');
      return;
    }
    if (!Number.isFinite(quantity) || quantity < 0 || (movementType !== 'ajuste' && quantity <= 0)) {
      setStorageError('Informe uma quantidade válida maior que zero.');
      return;
    }
    if (movementType === 'transferencia' && fromLocation === toLocation) {
      setStorageError('Escolha locais diferentes para transferir.');
      return;
    }

    if (movementType === 'consumo_frigobar') {
      setSaving(true);
      setStorageError('');
      void createFrigobarSale({
        id: newId(),
        items: [{ productId: movementProductId, quantity }],
        settlement,
        paymentMethod,
        roomNumber,
        guestName,
        actor,
        catalog: frigobar.products,
      }).then(() => {
        setModal(null);
        setNotice('Venda da Geladeira - Recepção registrada.');
        window.setTimeout(() => setNotice(''), 4000);
      }).catch((error: unknown) => {
        setStorageError(error instanceof Error ? error.message : 'Não foi possível registrar a venda.');
      }).finally(() => setSaving(false));
      return;
    }

    const movementId = newId();
    const timestamp = new Date().toISOString();
    const entryUnitPrice = movementType === 'entrada' && canViewFinancials ? Number(form.get('entryUnitPrice') || 0) : selectedProduct.cost;
    const entryPayment = String(form.get('entryPayment') ?? 'pendente');
    if (!Number.isFinite(entryUnitPrice) || entryUnitPrice < 0) {
      setStorageError('Informe um preço de entrada válido.');
      return;
    }
    const unitPrice = entryUnitPrice;
    const committed = commit((current) => {
      const product = current.products[movementProductId];
      if (!product) throw new Error('Este produto não está mais disponível.');
      const locations = { ...product.locationQuantities };
      const available = Number(locations[fromLocation] ?? 0);
      let recordedQuantity = quantity;
      let finalFromLocation = fromLocation;
      let finalToLocation = toLocation;

      if (movementType === 'entrada') {
        locations[toLocation] = Number(locations[toLocation] ?? 0) + quantity;
        finalFromLocation = '';
      } else if (movementType === 'transferencia') {
        if (available < quantity) throw new Error(`Saldo insuficiente em ${fromLocation}. Disponível: ${available} ${product.unit}.`);
        locations[fromLocation] = available - quantity;
        locations[toLocation] = Number(locations[toLocation] ?? 0) + quantity;
      } else if (movementType === 'ajuste') {
        const delta = quantity - available;
        recordedQuantity = Math.abs(delta);
        locations[fromLocation] = quantity;
        finalToLocation = delta > 0 ? fromLocation : '';
        finalFromLocation = delta < 0 ? fromLocation : '';
      } else {
        if (available < quantity) throw new Error(`Saldo insuficiente em ${fromLocation}. Disponível: ${available} ${product.unit}.`);
        locations[fromLocation] = available - quantity;
        finalToLocation = '';
      }

      const updatedProduct = { ...product, locationQuantities: locations, ...(movementType === 'entrada' && canViewFinancials ? { cost: entryUnitPrice } : {}), updatedAt: timestamp };
      const movement: StockMovement = {
        id: movementId,
        productId: product.id,
        productName: product.name,
        category: product.category,
        type: movementType,
        quantity: recordedQuantity,
        unit: product.unit,
        fromLocation: finalFromLocation,
        toLocation: finalToLocation,
        note: movementType === 'ajuste' ? `${note}${note ? ' · ' : ''}Contagem informada: ${quantity} ${product.unit}.` : note,
        actor,
        unitPrice,
        reference,
        createdAt: timestamp,
      };
      return {
        ...current,
        products: { ...current.products, [product.id]: updatedProduct },
        movements: { ...current.movements, [movement.id]: movement },
      };
    }, 'Movimentação registrada.');
    if (movementType === 'entrada' && canViewFinancials && quantity * unitPrice > 0) {
      void committed.then(async (ok) => {
        if (!ok) return;
        try {
          await recordEntryExpense(movementId, `Entrada de estoque: ${quantity} ${selectedProduct.unit} de ${selectedProduct.name}`, Math.round(quantity * unitPrice * 100) / 100, entryPayment);
          setNotice('Entrada registrada e lançada como despesa no Financeiro.');
        } catch (error) {
          setStorageError(`Entrada registrada, mas a despesa não foi lançada no Financeiro: ${error instanceof Error ? error.message : 'erro desconhecido'}`);
        }
      });
    }
  }

  function settleCheckout(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const paymentMethod = String(new FormData(event.currentTarget).get('paymentMethod') ?? '') as MinibarPaymentMethod | '';
    if (!paymentMethod) {
      setStorageError('Selecione a forma de pagamento recebida no checkout.');
      return;
    }
    const settledAt = new Date().toISOString();
    void commit((current) => {
      const movement = current.movements[editingId];
      if (movement?.type !== 'consumo_frigobar' || movement.settlement !== 'cobrar_no_checkout') {
        throw new Error('Esta cobrança não está mais pendente para checkout.');
      }
      return {
        ...current,
        movements: {
          ...current.movements,
          [movement.id]: { ...movement, settlement: 'pago_no_checkout', paymentMethod, settledAt, settledBy: actor, financeSynced: false },
        },
      };
    }, 'Cobrança do quarto recebida no checkout.');
  }

  async function removeSupplier(supplier: StockSupplier) {
    const inUse = products.some((product) => product.supplierId === supplier.id);
    if (inUse) {
      setStorageError('Este fornecedor está vinculado a um produto. Altere o cadastro do produto antes de removê-lo.');
      return;
    }
    if (!window.confirm(`Remover o fornecedor ${supplier.name}?`)) return;
    await commit((current) => {
      const nextSuppliers = { ...current.suppliers };
      delete nextSuppliers[supplier.id];
      return { ...current, suppliers: nextSuppliers };
    }, 'Fornecedor removido.');
  }

  const title: Record<View, string> = {
    resumo: 'Visão geral',
    produtos: 'Produtos',
    movimentacoes: 'Movimentações',
    fornecedores: 'Fornecedores',
    patrimonio: 'Patrimônio',
  };

  return (
    <CategoriesContext.Provider value={categories}>
    <div className="stock-app">
      {sidebarSlot && createPortal(<div className="stock-sidebar-context">
        <button type="button" className="sidebar-label sidebar-section-toggle" aria-expanded={!closedSections.estoque} onClick={() => toggleSection('estoque')}>ESTOQUE <span aria-hidden="true">{closedSections.estoque ? '▸' : '▾'}</span></button>
        {!closedSections.estoque && <nav className="stock-nav" aria-label="Navegação do estoque">
          {([
            ['resumo', 'Visão geral'],
            ['produtos', 'Produtos'],
            ['movimentacoes', 'Movimentações'],
            ['fornecedores', 'Fornecedores'],
            ['patrimonio', 'Patrimônio'],
          ] as [View, string][]).map(([id, label]) => (
            <button key={id} className={`nav-item ${view === id ? 'selected' : ''}`} onClick={() => setView(id)}>
              <span className="nav-indicator" />{label}
              {id === 'produtos' && lowStock.length > 0 && <span className="nav-count">{lowStock.length}</span>}
            </button>
          ))}
        </nav>}
        <button type="button" className="sidebar-label category-label sidebar-section-toggle" aria-expanded={!closedSections.categorias} onClick={() => toggleSection('categorias')}>CATEGORIAS <span aria-hidden="true">{closedSections.categorias ? '▸' : '▾'}</span></button>
        {!closedSections.categorias && <nav className="stock-nav category-nav" aria-label="Filtrar por categoria">
          <button className={`nav-item ${categoryFilter === 'todas' ? 'selected' : ''}`} onClick={() => { setCategoryFilter('todas'); setView('produtos'); }}>Todas as categorias</button>
          {categories.map((category) => (
            <button key={category.id} className={`nav-item ${categoryFilter === category.id ? 'selected' : ''}`} onClick={() => { setCategoryFilter(category.id); setView('produtos'); }}>
              <span className={`category-dot dot-${category.id}`} style={dotStyle(category.id)} />{category.name}
            </button>
          ))}
          <button className="nav-item" onClick={() => setModal('categorias')}>Gerenciar categorias</button>
        </nav>}
      </div>, sidebarSlot)}

      <main className="stock-main">
        <header className="stock-topbar">
          <div className="breadcrumb"><Link to="/">Painel</Link><span>/</span><strong>Estoque</strong></div>
          <div className="topbar-actions">
            <span className="user-chip">{actor}</span>
            <Link className="back-link" to="/">Voltar ao painel</Link>
          </div>
        </header>

        <div className="stock-content">
          <section className="page-heading">
            <div>
              <p className="eyebrow">CONTROLE OPERACIONAL</p>
              <h1>{title[view]}</h1>
              <p className="page-description">Produtos, saldos por local e patrimônio do hotel.</p>
            </div>
            <div className="heading-actions">
              {view === 'produtos' && <><button className="button button-soft" onClick={() => exportCsv(`produtos-estoque-${new Date().toISOString().slice(0, 10)}.csv`, [['Produto', 'Código', 'Categoria', 'Unidade', 'Saldo', 'Estoque mínimo', ...(canViewFinancials ? ['Custo unitário'] : []), 'Locais', 'Validade'], ...products.map((product) => [product.name, product.sku, categoryName(product.category), product.unit, quantityOf(product), product.minimumQuantity, ...(canViewFinancials ? [product.cost] : []), Object.entries(product.locationQuantities).map(([location, quantity]) => `${location}: ${quantity}`).join(' | '), product.expiresAt])])}>Exportar CSV</button><button className="button button-primary" onClick={() => openProduct()}>+ Novo produto</button></>}
              {view === 'movimentacoes' && <><button className="button button-soft" onClick={() => exportCsv(`movimentacoes-estoque-${new Date().toISOString().slice(0, 10)}.csv`, [['Data', 'Movimento', 'Produto', 'Categoria', 'Quantidade', 'Unidade', 'Origem', 'Destino', 'Quarto', 'Hóspede', 'Cobrança', 'Pagamento', 'Recebido em', 'Recebido por', 'Observação', 'Responsável'], ...movements.map((movement) => [movement.createdAt, movementName(movement.type), movement.productName, categoryName(movement.category), movement.quantity, movement.unit, movement.fromLocation, movement.toLocation, movement.roomNumber ?? '', movement.guestName ?? '', movement.settlement ?? '', movement.paymentMethod ?? '', movement.settledAt ?? '', movement.settledBy ?? '', movement.note, movement.actor])])}>Exportar CSV</button><button className="button button-primary" onClick={() => openMovement()} disabled={!products.length}>+ Registrar movimento</button></>}
              {view === 'fornecedores' && <button className="button button-primary" onClick={() => openSupplier()}>+ Novo fornecedor</button>}
              {view === 'patrimonio' && <button className="button button-primary" onClick={() => openAsset()}>+ Cadastrar bem</button>}
              {view === 'resumo' && <button className="button button-primary" onClick={() => openProduct()}>+ Novo produto</button>}
            </div>
          </section>

          {storageError && <div className="notice notice-error" role="alert">{storageError}<button onClick={() => setStorageError('')} aria-label="Fechar aviso">×</button></div>}
          {notice && <div className="notice notice-success" role="status">{notice}</div>}
          {loading ? <div className="loading-state">Carregando dados do estoque...</div> : (
            <>
              {view === 'resumo' && (
                <Overview
                  products={products}
                  movements={movements}
                  lowStock={lowStock}
                  outOfStock={outOfStock}
                  canViewFinancials={canViewFinancials}
                  inventoryValue={inventoryValue}
                  minibarSales={minibarSales}
                  minibarPending={minibarPending}
                  onOpenProducts={() => { setCategoryFilter('todas'); setStockFilter('todos'); setView('produtos'); }}
                  onOpenOutOfStock={() => { setCategoryFilter('todas'); setStockFilter('zerado'); setView('produtos'); }}
                  onOpenMovements={() => setView('movimentacoes')}
                  onEdit={openProduct}
                />
              )}
              {view === 'produtos' && (
                <ProductsView
                  products={filteredProducts}
                  categoryFilter={categoryFilter}
                  stockFilter={stockFilter}
                  search={search}
                  onCategoryChange={setCategoryFilter}
                  onStockChange={setStockFilter}
                  onSearchChange={setSearch}
                  onEdit={openProduct}
                  onMovement={openMovement}
                  onDelete={deleteProduct}
                  onToggleArchive={toggleProductArchive}
                  canViewFinancials={canViewFinancials}
                />
              )}
              {view === 'movimentacoes' && <MovementsView movements={movements} canViewFinancials={canViewFinancials} onCheckout={(movement) => { setEditingId(movement.id); setModal('checkout'); }} />}
              {view === 'fornecedores' && <SuppliersView suppliers={suppliers} onEdit={openSupplier} onRemove={removeSupplier} />}
              {view === 'patrimonio' && <AssetsView assets={assets} onEdit={openAsset} canViewFinancials={canViewFinancials} />}
            </>
          )}
        </div>
      </main>

      {modal && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setModal(null); }}>
          <section className="stock-modal" role="dialog" aria-modal="true" aria-labelledby="stock-modal-title">
            {modal === 'produto' && <ProductForm product={data.products[editingId]} suppliers={suppliers} saving={saving} canViewFinancials={canViewFinancials} onClose={() => setModal(null)} onSubmit={saveProduct} />}
            {modal === 'categorias' && <CategoriesManager categories={customCategoriesOf(data)} usage={products.reduce<Record<string, number>>((all, product) => ({ ...all, [product.category]: (all[product.category] ?? 0) + 1 }), {})} saving={saving} error={storageError} onClose={() => setModal(null)} onAdd={(name) => void changeCategories((list) => [...list, { id: newId(), name }], 'Categoria criada.')} onRename={(id, name) => void changeCategories((list) => list.map((item) => item.id === id ? { ...item, name } : item), 'Categoria atualizada.')} onRemove={removeCategory} />}
            {modal === 'fornecedor' && <SupplierForm supplier={data.suppliers[editingId]} saving={saving} onClose={() => setModal(null)} onSubmit={saveSupplier} />}
            {modal === 'patrimonio' && <AssetForm asset={data.assets[editingId]} saving={saving} canViewFinancials={canViewFinancials} onClose={() => setModal(null)} onSubmit={saveAsset} />}
            {modal === 'movimento' && (
              <MovementForm
                products={products}
                product={selectedProduct}
                selectedProductId={movementProductId}
                movementType={movementType}
                actor={actor}
                canViewFinancials={canViewFinancials}
                saving={saving}
                onProductChange={(id) => {
                  setMovementProductId(id);
                  if (movementType === 'consumo_frigobar' && data.products[id]?.category !== 'frigobar') setMovementType('saida');
                }}
                onTypeChange={setMovementType}
                onClose={() => setModal(null)}
                onSubmit={saveMovement}
              />
            )}
            {modal === 'checkout' && data.movements[editingId] && <CheckoutForm movement={data.movements[editingId]} saving={saving} canViewFinancials={canViewFinancials} onClose={() => setModal(null)} onSubmit={settleCheckout} />}
          </section>
        </div>
      )}
    </div>
    </CategoriesContext.Provider>
  );
}

function Overview({
  products, movements, lowStock, outOfStock, canViewFinancials, inventoryValue, minibarSales, minibarPending, onOpenProducts, onOpenOutOfStock, onOpenMovements, onEdit,
}: {
  products: StockProduct[];
  movements: StockMovement[];
  lowStock: StockProduct[];
  outOfStock: StockProduct[];
  canViewFinancials: boolean;
  inventoryValue: number;
  minibarSales: number;
  minibarPending: number;
  onOpenProducts: () => void;
  onOpenOutOfStock: () => void;
  onOpenMovements: () => void;
  onEdit: (product?: StockProduct) => void;
}) {
  const categories = useContext(CategoriesContext);
  const categoryName = (id: StockCategory) => nameOfCategory(categories, id);
  const categoryTotals = categories.map((category) => ({
    ...category,
    count: products.filter((product) => product.category === category.id).length,
    quantity: products.filter((product) => product.category === category.id).reduce((sum, product) => sum + quantityOf(product), 0),
  }));
  const maxCategoryCount = Math.max(1, ...categoryTotals.map((category) => category.count));

  return (
    <>
      <section className="metric-grid">
        <Metric label="Produtos cadastrados" value={String(products.length)} detail="Itens de consumo" tone="green" />
        <Metric label="Abaixo do mínimo" value={String(lowStock.length)} detail={`${outOfStock.length} sem saldo`} tone={lowStock.length ? 'coral' : 'green'} />
        {canViewFinancials && <Metric label="Valor em estoque" value={money(inventoryValue)} detail="Custo estimado atual" tone="blue" />}
        {canViewFinancials && <Metric label="Geladeira recebida" value={money(minibarSales)} detail={`${money(minibarPending)} a cobrar no checkout`} tone="gold" />}
      </section>

      <div className="overview-grid">
        <section className="panel category-panel">
          <div className="panel-heading"><div><h2>Estoque por categoria</h2><p>Visão consolidada dos itens cadastrados</p></div><button className="text-button" onClick={onOpenProducts}>Ver produtos</button></div>
          {categoryTotals.map((category) => (
            <div className="category-row" key={category.id}>
              <div className="category-row-head"><span><i className={`category-dot dot-${category.id}`} style={dotStyle(category.id)} />{category.name}</span><strong>{category.count} itens <small>· {category.quantity} un.</small></strong></div>
              <div className="category-track"><span className={`category-bar bar-${category.id}`} style={{ width: `${Math.max(category.count > 0 ? 6 : 0, category.count / maxCategoryCount * 100)}%`, ...dotStyle(category.id) }} /></div>
            </div>
          ))}
          <div className="category-footnote">Mobiliário e equipamentos são acompanhados separadamente em Patrimônio.</div>
        </section>

        <section className="panel alert-panel">
          <div className="panel-heading"><div><h2>Atenção ao estoque</h2><p>Itens no mínimo ou abaixo dele</p></div><span className="alert-number">{lowStock.length}</span></div>
          {lowStock.length === 0 ? <div className="empty-compact">Nenhum item precisa de reposição.</div> : (
            <div className="alert-list">
              {lowStock.slice(0, 5).map((product) => (
                <button className="alert-row" key={product.id} onClick={() => onEdit(product)}>
                  <span className={`category-stamp stamp-${product.category}`} style={stampStyle(product.category)}>{categoryName(product.category).slice(0, 1)}</span>
                  <span className="alert-product"><strong>{product.name}</strong><small>{categoryName(product.category)}</small></span>
                  <span className="alert-quantity"><strong>{quantityOf(product)} {product.unit}</strong><small>mín. {product.minimumQuantity}</small></span>
                </button>
              ))}
            </div>
          )}
          {outOfStock.length > 0 && <button className="button button-soft button-full" onClick={onOpenOutOfStock}>Ver itens sem saldo</button>}
        </section>
      </div>

      <section className="panel recent-panel">
        <div className="panel-heading"><div><h2>Movimentações recentes</h2><p>Últimos registros de entrada, consumo e transferência</p></div><button className="text-button" onClick={onOpenMovements}>Ver histórico</button></div>
        {movements.length === 0 ? <EmptyState title="Sem movimentações" detail="Cadastre um produto e registre a primeira entrada para iniciar o controle." action="Cadastrar produto" onAction={() => onEdit()} /> : <MovementTable movements={movements.slice(0, 6)} canViewFinancials={canViewFinancials} />}
      </section>
    </>
  );
}

function Metric({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: string }) {
  return <article className={`metric-card metric-${tone}`}><div className="metric-accent" /><p>{label}</p><strong>{value}</strong><small>{detail}</small></article>;
}

function ProductsView({
  products, categoryFilter, stockFilter, search, onCategoryChange, onStockChange, onSearchChange, onEdit, onMovement, onDelete, onToggleArchive, canViewFinancials,
}: {
  products: StockProduct[];
  categoryFilter: StockCategory | 'todas';
  stockFilter: 'todos' | 'baixo' | 'zerado';
  search: string;
  onCategoryChange: (value: StockCategory | 'todas') => void;
  onStockChange: (value: 'todos' | 'baixo' | 'zerado') => void;
  onSearchChange: (value: string) => void;
  onEdit: (product?: StockProduct) => void;
  onMovement: (product?: StockProduct, type?: MovementType) => void;
  onDelete: (product: StockProduct) => void;
  onToggleArchive: (product: StockProduct) => void;
  canViewFinancials: boolean;
}) {
  const categories = useContext(CategoriesContext);
  const categoryName = (id: StockCategory) => nameOfCategory(categories, id);
  return (
    <section className="panel table-panel">
      <div className="filter-bar">
        <label className="search-field"><span>Buscar</span><input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Nome ou código do produto" /></label>
        <label className="filter-field"><span>Categoria</span><select value={categoryFilter} onChange={(event) => onCategoryChange(event.target.value as StockCategory | 'todas')}><option value="todas">Todas</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
        <label className="filter-field"><span>Situação</span><select value={stockFilter} onChange={(event) => onStockChange(event.target.value as 'todos' | 'baixo' | 'zerado')}><option value="todos">Todas</option><option value="baixo">Estoque baixo</option><option value="zerado">Sem estoque</option></select></label>
      </div>
      {products.length === 0 ? <EmptyState title="Nenhum produto encontrado" detail="Ajuste os filtros ou cadastre o primeiro item do estoque." action="Cadastrar produto" onAction={() => onEdit()} /> : (
        <div className="table-scroll"><table className="data-table"><thead><tr><th>Produto</th><th>Categoria</th><th>Saldo</th><th>Estoque mínimo</th>{canViewFinancials && <th>Custo unitário</th>}<th>Situação</th><th><span className="sr-only">Ações</span></th></tr></thead><tbody>
          {products.map((product) => (
            <tr key={product.id}>
              <td><div className="product-cell"><span className={`category-stamp stamp-${product.category}`} style={stampStyle(product.category)}>{categoryName(product.category).slice(0, 1)}</span><span><strong>{product.name}</strong><small>{product.sku || 'Sem código'} · {Object.keys(product.locationQuantities).length} locais</small></span></div></td>
              <td><span className="category-label"><i className={`category-dot dot-${product.category}`} style={dotStyle(product.category)} />{categoryName(product.category)}</span></td>
              <td><strong>{quantityOf(product)} {product.unit}</strong></td>
              <td>{product.minimumQuantity} {product.unit}</td>
              {canViewFinancials && <td>{money(product.cost)}</td>}
              <td><StockStatus product={product} /></td>
              <td><div className="row-actions"><button title="Registrar movimentação" onClick={() => onMovement(product, 'entrada')}>Movimentar</button><button title="Conferir quantidade física" onClick={() => onMovement(product, 'ajuste')}>Conferir</button><button title="Editar produto" onClick={() => onEdit(product)}>Editar</button><button title={product.active === false ? 'Reativar produto' : 'Arquivar produto'} onClick={() => onToggleArchive(product)}>{product.active === false ? 'Reativar' : 'Arquivar'}</button><button className="delete-action" title="Excluir produto" onClick={() => onDelete(product)}>Excluir</button></div></td>
            </tr>
          ))}
        </tbody></table></div>
      )}
      <div className="table-footer">{products.length} {products.length === 1 ? 'produto' : 'produtos'} exibidos</div>
    </section>
  );
}

function MovementsView({ movements, canViewFinancials, onCheckout }: { movements: StockMovement[]; canViewFinancials: boolean; onCheckout: (movement: StockMovement) => void }) {
  const pending = movements.filter((movement) => movement.type === 'consumo_frigobar' && movement.settlement === 'cobrar_no_checkout');
  const pendingTotal = pending.reduce((total, movement) => total + movement.quantity * movement.unitPrice, 0);
  return <section className="panel table-panel"><div className="panel-heading movement-heading"><div><h2>Histórico de estoque</h2><p>Registros feitos pela equipe{pending.length > 0 && ` · ${pending.length} consumo(s) aguardando checkout`}</p></div><span className="record-count">{canViewFinancials && pending.length > 0 ? `${money(pendingTotal)} pendentes · ` : ''}{movements.length} registros</span></div>{movements.length === 0 ? <EmptyState title="Histórico vazio" detail="As entradas, saídas e transferências aparecerão aqui." /> : <MovementTable movements={movements} onCheckout={onCheckout} canViewFinancials={canViewFinancials} />}</section>;
}

function MovementTable({ movements, onCheckout, canViewFinancials = true }: { movements: StockMovement[]; onCheckout?: (movement: StockMovement) => void; canViewFinancials?: boolean }) {
  const categories = useContext(CategoriesContext);
  const categoryName = (id: StockCategory) => nameOfCategory(categories, id);
  const paymentLabels: Record<MinibarPaymentMethod, string> = {
    dinheiro: 'Dinheiro',
    pix: 'Pix',
    cartao_debito: 'Cartão de débito',
    cartao_credito: 'Cartão de crédito',
  };
  return <div className="table-scroll"><table className="data-table movement-table"><thead><tr><th>Data e hora</th><th>Movimento</th><th>Produto</th><th>Quantidade</th><th>Origem / destino</th><th>Quarto / referência</th><th>Cobrança</th>{onCheckout && <th>Ação</th>}<th>Responsável</th></tr></thead><tbody>
    {movements.map((movement) => (
      <tr key={movement.id}>
        <td className="date-cell">{dateTime(movement.createdAt)}</td>
        <td><span className={`movement-tag tag-${movementTone(movement.type)}`}>{movementName(movement.type)}</span></td>
        <td><strong>{movement.productName}</strong><small className="sub-cell">{categoryName(movement.category)}</small></td>
        <td><strong>{movement.quantity} {movement.unit}</strong>{canViewFinancials && movement.type === 'consumo_frigobar' && <small className="sub-cell">{money(movement.quantity * movement.unitPrice)}</small>}</td>
        <td>{movement.fromLocation && <span>{movement.fromLocation}</span>}{movement.fromLocation && movement.toLocation && <span className="transfer-arrow"> → </span>}{movement.toLocation && <span>{movement.toLocation}</span>}{!movement.fromLocation && !movement.toLocation && <span>—</span>}</td>
        <td>{movement.type === 'consumo_frigobar' ? <>{movement.roomNumber && <span>Quarto {movement.roomNumber}</span>}{movement.guestName && <small className="sub-cell">{movement.guestName}</small>}{!movement.roomNumber && !movement.guestName && '—'}</> : movement.reference || movement.note || '—'}</td>
        <td>{movement.type === 'consumo_frigobar' ? <span className={`movement-tag ${movement.settlement === 'cobrar_no_checkout' ? 'tag-neutral' : 'tag-positive'}`}>{movement.settlement === 'cobrar_no_checkout' ? 'Cobrar no checkout' : `${movement.settlement === 'pago_no_checkout' ? 'Pago no checkout' : 'Pago na recepção'}${movement.paymentMethod ? ` · ${paymentLabels[movement.paymentMethod as MinibarPaymentMethod] ?? movement.paymentMethod}` : ''}`}</span> : '—'}</td>
        {onCheckout && <td>{movement.type === 'consumo_frigobar' && movement.settlement === 'cobrar_no_checkout' ? <button className="button button-soft checkout-action" onClick={() => onCheckout(movement)}>Receber</button> : '—'}</td>}
        <td>{movement.settledBy ? <><strong>{movement.actor}</strong><small className="sub-cell">Checkout: {movement.settledBy}</small></> : movement.actor}</td>
      </tr>
    ))}
  </tbody></table></div>;
}

function SuppliersView({ suppliers, onEdit, onRemove }: { suppliers: StockSupplier[]; onEdit: (supplier?: StockSupplier) => void; onRemove: (supplier: StockSupplier) => void }) {
  return <section className="panel table-panel"><div className="panel-heading movement-heading"><div><h2>Cadastro de fornecedores</h2><p>Contatos vinculados às compras do hotel</p></div><span className="record-count">{suppliers.length} cadastrados</span></div>{suppliers.length === 0 ? <EmptyState title="Nenhum fornecedor cadastrado" detail="Mantenha os contatos de compra organizados junto ao estoque." action="Adicionar fornecedor" onAction={() => onEdit()} /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>Fornecedor</th><th>Contato</th><th>Telefone</th><th>E-mail</th><th><span className="sr-only">Ações</span></th></tr></thead><tbody>{suppliers.map((supplier) => <tr key={supplier.id}><td><strong>{supplier.name}</strong>{supplier.notes && <small className="sub-cell">{supplier.notes}</small>}</td><td>{supplier.contact || '—'}</td><td>{supplier.phone || '—'}</td><td>{supplier.email || '—'}</td><td><div className="row-actions"><button onClick={() => onEdit(supplier)}>Editar</button><button onClick={() => onRemove(supplier)}>Remover</button></div></td></tr>)}</tbody></table></div>}</section>;
}

function AssetsView({ assets, onEdit, canViewFinancials }: { assets: TrackedAsset[]; onEdit: (asset?: TrackedAsset) => void; canViewFinancials: boolean }) {
  const statusLabels: Record<AssetStatus, string> = { em_uso: 'Em uso', em_manutencao: 'Em manutenção', baixado: 'Baixado' };
  return <section className="panel table-panel"><div className="panel-heading movement-heading"><div><h2>Bens e equipamentos</h2><p>Localização, identificação e condição dos itens duráveis</p></div><span className="record-count">{assets.length} bens</span></div>{assets.length === 0 ? <EmptyState title="Patrimônio ainda não cadastrado" detail="Cadastre camas, TVs, colchões e outros bens duráveis, separados dos materiais de consumo." action="Cadastrar bem" onAction={() => onEdit()} /> : <div className="table-scroll"><table className="data-table"><thead><tr><th>Bem</th><th>Identificação</th><th>Localização</th><th>Data de aquisição</th>{canViewFinancials && <th>Valor</th>}<th>Estado</th><th><span className="sr-only">Ações</span></th></tr></thead><tbody>{assets.map((asset) => <tr key={asset.id}><td><strong>{asset.name}</strong>{asset.notes && <small className="sub-cell">{asset.notes}</small>}</td><td>{asset.tag || asset.serialNumber || '—'}</td><td>{asset.location}</td><td>{asset.acquiredAt ? new Date(`${asset.acquiredAt}T12:00:00`).toLocaleDateString('pt-BR') : '—'}</td>{canViewFinancials && <td>{money(asset.cost)}</td>}<td><span className={`stock-status ${asset.status === 'em_uso' ? 'status-ok' : asset.status === 'em_manutencao' ? 'status-low' : 'status-out'}`}>{statusLabels[asset.status]}</span></td><td><div className="row-actions"><button onClick={() => onEdit(asset)}>Editar</button></div></td></tr>)}</tbody></table></div>}</section>;
}

function EmptyState({ title, detail, action, onAction }: { title: string; detail: string; action?: string; onAction?: () => void }) {
  return <div className="empty-state"><span className="empty-mark">—</span><strong>{title}</strong><p>{detail}</p>{action && onAction && <button className="button button-soft" onClick={onAction}>{action}</button>}</div>;
}

function ProductForm({ product, suppliers, saving, canViewFinancials, onClose, onSubmit }: { product?: StockProduct; suppliers: StockSupplier[]; saving: boolean; canViewFinancials: boolean; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const categories = useContext(CategoriesContext);
  const [category, setCategory] = useState(product?.category ?? categories[0]?.id ?? NEW_CATEGORY);
  const isSalesItem = category === SALES_CATEGORY_ID;
  return <form onSubmit={onSubmit}><ModalHeader title={product ? 'Editar produto' : 'Novo produto'} onClose={onClose} /><div className="modal-body">
    <label className="form-field form-wide"><span>Nome do produto *</span><input name="name" required defaultValue={product?.name} placeholder="Ex.: Detergente neutro 500 ml" /></label>
    <label className="form-field"><span>Categoria *</span><select name="category" required value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}<option value={NEW_CATEGORY}>+ Nova categoria...</option></select></label>
    {category === NEW_CATEGORY ? <label className="form-field"><span>Nome da nova categoria *</span><input name="newCategory" required maxLength={60} autoFocus placeholder="Ex.: Piscina" /></label> : <label className="form-field"><span>Código / SKU</span><input name="sku" defaultValue={product?.sku} placeholder="Opcional" /></label>}
    <label className="form-field"><span>Unidade *</span><input name="unit" required defaultValue={product?.unit ?? 'un.'} placeholder="un., kg, L, pacote..." /></label>
    <label className="form-field"><span>Estoque mínimo</span><input name="minimumQuantity" type="number" min="0" step="any" defaultValue={product?.minimumQuantity ?? 0} /></label>
    {canViewFinancials && <><label className="form-field"><span>Preço de entrada (R$)</span><input name="cost" type="number" min="0" step="0.01" defaultValue={product?.cost ?? 0} /></label>
    {isSalesItem && <label className="form-field"><span>Preço de venda (R$) *</span><input name="salePrice" type="number" min="0.01" step="0.01" required defaultValue={product?.salePrice ?? 0} /></label>}</>}
    <label className="form-field"><span>Fornecedor</span><select name="supplierId" defaultValue={product?.supplierId ?? ''}><option value="">Não informado</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></label>
    <label className="form-field"><span>Validade</span><DateInput name="expiresAt" defaultValue={product?.expiresAt} /></label>
    <label className="form-field form-wide"><span>Observações</span><textarea name="description" rows={2} defaultValue={product?.description} placeholder="Detalhes, apresentação ou cuidados" /></label>
    {category === NEW_CATEGORY && <label className="form-field"><span>Código / SKU</span><input name="sku" defaultValue={product?.sku} placeholder="Opcional" /></label>}
    <p className="form-hint form-wide">{isSalesItem ? 'Item da geladeira: é o único tipo vendido ao hóspede, por isso tem preço de venda.' : 'Item de uso do hotel: tem apenas preço de entrada, não é vendido.'}</p>
    {product && <p className="form-hint form-wide">O saldo atual por local será preservado. Para alterá-lo, registre uma movimentação ou faça uma conferência.</p>}
  </div><ModalFooter saving={saving} onClose={onClose} submitLabel={product ? 'Salvar alterações' : 'Cadastrar produto'} /></form>;
}

function SupplierForm({ supplier, saving, onClose, onSubmit }: { supplier?: StockSupplier; saving: boolean; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <form onSubmit={onSubmit}><ModalHeader title={supplier ? 'Editar fornecedor' : 'Novo fornecedor'} onClose={onClose} /><div className="modal-body">
    <label className="form-field form-wide"><span>Nome / razão social *</span><input name="name" required defaultValue={supplier?.name} /></label>
    <label className="form-field"><span>Pessoa de contato</span><input name="contact" defaultValue={supplier?.contact} /></label>
    <label className="form-field"><span>Telefone</span><input name="phone" type="tel" defaultValue={supplier?.phone} /></label>
    <label className="form-field form-wide"><span>E-mail</span><input name="email" type="email" defaultValue={supplier?.email} /></label>
    <label className="form-field form-wide"><span>Observações</span><textarea name="notes" rows={3} defaultValue={supplier?.notes} /></label>
  </div><ModalFooter saving={saving} onClose={onClose} submitLabel="Salvar fornecedor" /></form>;
}

function AssetForm({ asset, saving, canViewFinancials, onClose, onSubmit }: { asset?: TrackedAsset; saving: boolean; canViewFinancials: boolean; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <form onSubmit={onSubmit}><ModalHeader title={asset ? 'Editar patrimônio' : 'Cadastrar bem'} onClose={onClose} /><div className="modal-body">
    <label className="form-field form-wide"><span>Nome do bem *</span><input name="name" required defaultValue={asset?.name} placeholder="Ex.: Televisor 32 polegadas" /></label>
    <label className="form-field"><span>Patrimônio / etiqueta</span><input name="tag" defaultValue={asset?.tag} /></label>
    <label className="form-field"><span>Número de série</span><input name="serialNumber" defaultValue={asset?.serialNumber} /></label>
    <label className="form-field form-wide"><span>Localização *</span><input name="location" required list="stock-locations" defaultValue={asset?.location} placeholder="Quarto, setor ou depósito" /></label>
    <label className="form-field"><span>Estado</span><select name="status" defaultValue={asset?.status ?? 'em_uso'}><option value="em_uso">Em uso</option><option value="em_manutencao">Em manutenção</option><option value="baixado">Baixado</option></select></label>
    <label className="form-field"><span>Data de aquisição</span><DateInput name="acquiredAt" defaultValue={asset?.acquiredAt} /></label>
    {canViewFinancials && <label className="form-field"><span>Valor de aquisição (R$)</span><input name="cost" type="number" min="0" step="0.01" defaultValue={asset?.cost ?? 0} /></label>}
    <label className="form-field form-wide"><span>Observações</span><textarea name="notes" rows={2} defaultValue={asset?.notes} /></label>
  </div><ModalFooter saving={saving} onClose={onClose} submitLabel={asset ? 'Salvar alterações' : 'Cadastrar bem'} /></form>;
}

function MovementForm({
  products, product, selectedProductId, movementType, actor, saving, canViewFinancials, onProductChange, onTypeChange, onClose, onSubmit,
}: {
  products: StockProduct[];
  product?: StockProduct;
  selectedProductId: string;
  movementType: MovementType;
  actor: string;
  saving: boolean;
  canViewFinancials: boolean;
  onProductChange: (id: string) => void;
  onTypeChange: (type: MovementType) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const [minibarSettlement, setMinibarSettlement] = useState<MinibarSettlement>('pago_na_recepcao');
  const productLocations = product ? Object.keys(product.locationQuantities) : [];
  const locations = Array.from(new Set([...STOCK_LOCATIONS, ...productLocations]));
  const source = movementType === 'consumo_frigobar'
    ? 'Geladeira - Recepção'
    : productLocations.find((location) => (product?.locationQuantities[location] ?? 0) > 0) ?? productLocations[0] ?? STOCK_LOCATIONS[0];
  const isInbound = movementType === 'entrada';
  const isTransfer = movementType === 'transferencia';
  const isCount = movementType === 'ajuste';
  const isOutbound = movementType === 'saida' || movementType === 'perda' || movementType === 'consumo_frigobar';
  const options: [MovementType, string][] = [
    ['entrada', 'Entrada de compra / reposição'],
    ['saida', 'Saída para consumo interno'],
    ['transferencia', 'Transferência entre locais'],
    ['ajuste', 'Conferência de inventário'],
    ['perda', 'Perda ou descarte'],
    ...(product?.category === 'frigobar' ? [['consumo_frigobar', 'Venda da Geladeira - Recepção'] as [MovementType, string]] : []),
  ];

  return <form onSubmit={onSubmit}><ModalHeader title="Registrar movimentação" onClose={onClose} /><div className="modal-body">
    <label className="form-field form-wide"><span>Produto *</span><select required value={selectedProductId} onChange={(event) => onProductChange(event.target.value)}>{products.length === 0 && <option value="">Cadastre um produto primeiro</option>}{products.map((item) => <option key={item.id} value={item.id}>{item.name} · saldo {quantityOf(item)} {item.unit}</option>)}</select></label>
    <label className="form-field form-wide"><span>Tipo de movimento *</span><select value={movementType} onChange={(event) => onTypeChange(event.target.value as MovementType)}>{options.map(([type, label]) => <option key={type} value={type}>{label}</option>)}</select></label>
    {isTransfer || isOutbound || isCount ? <label className="form-field form-wide"><span>{isCount ? 'Local conferido *' : 'Origem *'}</span><input name="fromLocation" required list="stock-locations" defaultValue={source} /></label> : null}
    {isInbound || isTransfer ? <label className="form-field form-wide"><span>{isInbound ? 'Local de destino *' : 'Destino *'}</span><input name="toLocation" required list="stock-locations" defaultValue={isInbound && product?.category === 'frigobar' ? 'Geladeira - Recepção' : isInbound ? 'Almoxarifado central' : ''} placeholder="Informe o local" /></label> : null}
    <label className="form-field"><span>{isCount ? 'Quantidade contada *' : 'Quantidade *'} {product && `(${product.unit})`}</span><input name="quantity" type="number" min="0" step="any" required defaultValue="" placeholder={isCount ? 'Saldo físico' : '0'} /></label>
    {isInbound && canViewFinancials && <>
      <label className="form-field"><span>Preço de entrada / unidade (R$)</span><input key={product?.id} name="entryUnitPrice" type="number" min="0" step="0.01" defaultValue={product?.cost ?? 0} /></label>
      <label className="form-field"><span>Pagamento da compra</span><select name="entryPayment" defaultValue="pendente"><option value="pendente">A pagar (pendente)</option><option value="caixa">Pago em dinheiro (caixa)</option><option value="banco">Pago pelo banco</option></select></label>
      <p className="form-hint form-wide">A compra será lançada como despesa "Estoque" no Financeiro e o preço de entrada do produto será atualizado.</p>
    </>}
    {canViewFinancials && movementType === 'consumo_frigobar' && <label className="form-field"><span>Preço cobrado / unidade</span><input value={money(product?.salePrice ?? 0)} readOnly /></label>}
    {movementType === 'consumo_frigobar' ? <>
      <label className="form-field form-wide"><span>Forma de cobrança *</span><select name="settlement" value={minibarSettlement} onChange={(event) => setMinibarSettlement(event.target.value as MinibarSettlement)}><option value="pago_na_recepcao">Cobrar e receber na recepção</option><option value="cobrar_no_checkout">Lançar no quarto para cobrar no checkout</option></select></label>
      {minibarSettlement === 'pago_na_recepcao' ? <label className="form-field form-wide"><span>Forma de pagamento *</span><select name="paymentMethod" required defaultValue=""><option value="" disabled>Selecione</option><option value="dinheiro">Dinheiro</option><option value="pix">Pix</option><option value="cartao_debito">Cartão de débito</option><option value="cartao_credito">Cartão de crédito</option></select></label> : null}
      <label className="form-field"><span>Quarto {minibarSettlement === 'cobrar_no_checkout' ? '*' : '(opcional)'}</span><input name="roomNumber" required={minibarSettlement === 'cobrar_no_checkout'} placeholder="Ex.: 205" /></label>
      <label className="form-field"><span>Hóspede (opcional)</span><input name="guestName" placeholder="Nome do hóspede" /></label>
    </> : <label className="form-field"><span>Referência</span><input name="reference" placeholder="Nota, pedido ou setor" /></label>}
    <label className="form-field"><span>Responsável</span><input value={actor} readOnly /></label>
    <label className="form-field form-wide"><span>Observação</span><textarea name="note" rows={2} placeholder="Informação complementar" /></label>
    {product && (isOutbound || isTransfer || isCount) && <p className="form-hint form-wide">Saldo atual em {isCount ? 'local' : 'origem'}: {product.locationQuantities[source] ?? 0} {product.unit}.</p>}
    {movementType === 'consumo_frigobar' && <p className="form-hint form-wide">O produto sai da Geladeira - Recepção. A opção de checkout cria uma pendência no histórico do quarto; ela não lança automaticamente na conta de uma reserva.</p>}
  </div><datalist id="stock-locations">{locations.map((location) => <option key={location} value={location} />)}</datalist><ModalFooter saving={saving} onClose={onClose} submitLabel="Confirmar movimentação" disabled={!products.length} /></form>;
}

function CheckoutForm({ movement, saving, canViewFinancials, onClose, onSubmit }: { movement: StockMovement; saving: boolean; canViewFinancials: boolean; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <form onSubmit={onSubmit}><ModalHeader title={`Checkout · quarto ${movement.roomNumber}`} onClose={onClose} /><div className="modal-body">
    <div className="checkout-summary form-wide"><strong>{movement.productName}</strong><span>{movement.quantity} {movement.unit}{canViewFinancials && ` · ${money(movement.quantity * movement.unitPrice)}`}</span>{movement.guestName && <small>Hóspede: {movement.guestName}</small>}</div>
    <label className="form-field form-wide"><span>Forma de pagamento recebida *</span><select name="paymentMethod" required defaultValue=""><option value="" disabled>Selecione</option><option value="dinheiro">Dinheiro</option><option value="pix">Pix</option><option value="cartao_debito">Cartão de débito</option><option value="cartao_credito">Cartão de crédito</option></select></label>
    <p className="form-hint form-wide">Confirmar o recebimento remove este item do total pendente e registra quem deu baixa no checkout.</p>
  </div><ModalFooter saving={saving} onClose={onClose} submitLabel="Confirmar recebimento" /></form>;
}

function CategoriesManager({ categories, usage, saving, error, onClose, onAdd, onRename, onRemove }: { categories: StockCategoryRecord[]; usage: Record<string, number>; saving: boolean; error: string; onClose: () => void; onAdd: (name: string) => void; onRename: (id: string, name: string) => void; onRemove: (category: StockCategoryRecord) => void }) {
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState('');
  const [draft, setDraft] = useState('');
  return <div><ModalHeader title="Categorias do estoque" onClose={onClose} /><div className="modal-body">
    <form className="category-add-form form-wide" onSubmit={(event) => { event.preventDefault(); if (!newName.trim()) return; onAdd(newName); setNewName(''); }}>
      <label className="form-field"><span>Nova categoria</span><input value={newName} maxLength={60} onChange={(event) => setNewName(event.target.value)} placeholder="Ex.: Lavanderia" /></label>
      <button className="button button-primary" type="submit" disabled={saving || !newName.trim()}>Adicionar</button>
    </form>
    {error && <p className="form-hint form-wide category-error" role="alert">{error}</p>}
    <ul className="category-manage-list form-wide">
      {categories.map((category) => <li key={category.id}>
        {editingId === category.id
          ? <><input value={draft} maxLength={60} autoFocus aria-label={`Nome de ${category.name}`} onChange={(event) => setDraft(event.target.value)} /><button className="button button-primary" type="button" disabled={saving || !draft.trim()} onClick={() => { onRename(category.id, draft); setEditingId(''); }}>Salvar</button><button className="button button-plain" type="button" onClick={() => setEditingId('')}>Cancelar</button></>
          : <><span>{category.name}<small>{usage[category.id] ?? 0} {(usage[category.id] ?? 0) === 1 ? 'item' : 'itens'}</small></span><button className="button button-plain" type="button" disabled={saving} onClick={() => { setEditingId(category.id); setDraft(category.name); }}>Editar</button><button className="button button-plain" type="button" disabled={saving} onClick={() => onRemove(category)}>Excluir</button></>}
      </li>)}
      <li className="category-fixed"><span>{SALES_CATEGORY.name}<small>Fixa · única categoria com itens à venda · {usage[SALES_CATEGORY.id] ?? 0} itens</small></span></li>
    </ul>
  </div><div className="modal-footer"><button type="button" className="button button-plain" onClick={onClose}>Fechar</button></div></div>;
}

function ModalHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return <div className="modal-header"><div><p className="eyebrow">ESTOQUE DO HOTEL</p><h2 id="stock-modal-title">{title}</h2></div><button type="button" className="close-button" onClick={onClose} aria-label="Fechar">×</button></div>;
}

function ModalFooter({ saving, onClose, submitLabel, disabled = false }: { saving: boolean; onClose: () => void; submitLabel: string; disabled?: boolean }) {
  return <div className="modal-footer"><button type="button" className="button button-plain" onClick={onClose}>Cancelar</button><button className="button button-primary" type="submit" disabled={saving || disabled}>{saving ? 'Salvando...' : submitLabel}</button></div>;
}