import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { applyMinibarSale, type MinibarSaleInput } from '../services/minibarSales';
import { subscribeInventory, updateInventory } from '../services/inventoryStore';
import type { InventoryData, MinibarPaymentMethod, MinibarSettlement, StockProduct } from '../types/inventory';
import { emptyHousekeeping, subscribeHousekeeping } from '../services/housekeepingStore';
import type { HousekeepingData } from '../types/housekeeping';
import './venda-geladeira.css';

const LOCATION = 'Geladeira - Recepção';
const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const emptyInventory: InventoryData = { products: {}, suppliers: {}, movements: {}, assets: {} };

export function VendaGeladeira({ actor }: { actor: string }) {
  const [data, setData] = useState<InventoryData>(emptyInventory);
  const [housekeeping, setHousekeeping] = useState<HousekeepingData>(emptyHousekeeping());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<Record<string, number>>({});
  const [settlement, setSettlement] = useState<MinibarSettlement>('pago_na_recepcao');
  const [paymentMethod, setPaymentMethod] = useState<MinibarPaymentMethod | ''>('');
  const [roomNumber, setRoomNumber] = useState('');
  const [guestName, setGuestName] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => subscribeInventory((next) => {
    setData(next);
    setLoading(false);
    setLoadError('');
  }, (error) => {
    setLoadError(error.message);
    setLoading(false);
  }), []);

  useEffect(() => subscribeHousekeeping(setHousekeeping, () => setHousekeeping(emptyHousekeeping())), []);

  const products = Object.values(data.products)
    .filter((product) => product.category === 'frigobar' && product.active !== false)
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const filteredProducts = products.filter((product) => product.name.toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR')));
  const hasReceptionStock = products.some((product) => Number(product.locationQuantities[LOCATION] ?? 0) > 0);
  const cartItems = Object.entries(cart)
    .map(([productId, quantity]) => ({ product: data.products[productId], quantity }))
    .filter((item): item is { product: StockProduct; quantity: number } => Boolean(item.product) && item.quantity > 0);
  const totalItems = cartItems.reduce((total, item) => total + item.quantity, 0);
  const total = cartItems.reduce((amount, item) => amount + item.product.salePrice * item.quantity, 0);
  const occupiedReservations = Object.values(housekeeping.reservations)
    .filter((reservation) => reservation.status === 'hospedado')
    .sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, 'pt-BR', { numeric: true }));

  function changeQuantity(product: StockProduct, change: number) {
    const available = Number(product.locationQuantities[LOCATION] ?? 0);
    setCart((current) => {
      const nextQuantity = Math.max(0, Math.min(available, (current[product.id] ?? 0) + change));
      const next = { ...current };
      if (nextQuantity === 0) delete next[product.id];
      else next[product.id] = nextQuantity;
      return next;
    });
  }

  async function finishSale(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaveError('');
    setNotice('');
    const sale: MinibarSaleInput = {
      items: cartItems.map(({ product, quantity }) => ({ productId: product.id, quantity })),
      settlement,
      paymentMethod,
      roomNumber,
      guestName,
      actor,
    };
    setSaving(true);
    try {
      await updateInventory((current) => applyMinibarSale(current, sale));
      setCart({});
      setPaymentMethod('');
      setRoomNumber('');
      setGuestName('');
      setNotice(settlement === 'pago_na_recepcao' ? 'Venda recebida na recepção.' : `Venda lançada no quarto ${roomNumber}.`);
      window.setTimeout(() => setNotice(''), 4500);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Não foi possível registrar a venda.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="sales-page">
      <header className="sales-header">
        <Link to="/" className="sales-brand"><span className="sales-brand-mark">HL</span><span><strong>Hotel Lindoia</strong><small>CAIXA DA RECEPÇÃO</small></span></Link>
        <nav className="sales-header-links" aria-label="Navegação"><Link to="/reservas">Reservas</Link><Link to="/quartos">Serviço de quarto</Link><Link to="/estoque">Estoque</Link><Link to="/">Painel inicial</Link></nav>
      </header>

      <main className="sales-content">
        <div className="sales-title-row">
          <div><p className="sales-eyebrow">PONTO DE VENDA <span>/</span> RECEPÇÃO</p><h1>Geladeira - Recepção</h1><p>Selecione os produtos e escolha como cobrar.</p></div>
          <span className="sales-operator">Atendente <strong>{actor}</strong></span>
        </div>

        {loadError && <div className="sales-alert" role="alert">Não foi possível carregar o estoque: {loadError}</div>}
        {saveError && <div className="sales-alert" role="alert">{saveError}</div>}
        {notice && <div className="sales-success" role="status">{notice}</div>}

        <div className="sales-layout">
          <section className="catalog-panel">
            <div className="catalog-heading"><div><h2>Produtos disponíveis</h2><p>{products.length} {products.length === 1 ? 'produto cadastrado' : 'produtos cadastrados'}</p></div><label className="catalog-search"><span className="sr-only">Buscar produto</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar bebida" /></label></div>
            {!loading && products.length > 0 && !hasReceptionStock && <div className="sales-stock-notice"><span>Os produtos estão cadastrados, mas ainda não têm saldo na Geladeira - Recepção.</span><Link to="/estoque">Registrar entrada no estoque <span aria-hidden="true">→</span></Link></div>}
            {loading ? <div className="sales-empty">Carregando produtos do Firebase...</div> : filteredProducts.length === 0 ? (
              <div className="sales-empty"><strong>{products.length === 0 ? 'Nenhum produto cadastrado' : 'Nenhum produto encontrado'}</strong><p>{products.length === 0 ? 'Cadastre produtos na categoria Geladeira - Recepção e registre uma entrada no estoque.' : 'Tente outro nome de produto.'}</p>{products.length === 0 && <Link className="sales-outline-button" to="/estoque">Abrir estoque</Link>}</div>
            ) : <div className="sales-product-grid">
              {filteredProducts.map((product) => {
                const available = Number(product.locationQuantities[LOCATION] ?? 0);
                const inCart = cart[product.id] ?? 0;
                const restockPath = `/estoque?produto=${encodeURIComponent(product.id)}&movimento=entrada`;
                return <article className="sales-product" key={product.id}>
                  <div className="sales-product-top"><span className="sales-product-kind">BEBIDA</span><span className={available > 0 ? 'sales-stock-ok' : 'sales-stock-empty'}>{available > 0 ? `${available} ${product.unit}` : 'Sem saldo'}</span></div>
                  <strong className="sales-product-name">{product.name}</strong>
                  {product.salePrice > 0 ? <span className="sales-product-price">{money(product.salePrice)}</span> : <span className="sales-product-no-price">Preço não cadastrado</span>}
                  {available <= 0 ? <Link className="sales-restock-button" to={restockPath}>Registrar entrada <span aria-hidden="true">→</span></Link> : product.salePrice <= 0 ? <Link className="sales-restock-button" to={restockPath}>Cadastrar preço <span aria-hidden="true">→</span></Link> : <button className="sales-add-button" disabled={inCart >= available} onClick={() => changeQuantity(product, 1)}>{inCart >= available ? `Limite · ${inCart} no pedido` : inCart ? `Adicionar · ${inCart} no pedido` : 'Adicionar ao pedido'} <span aria-hidden="true">+</span></button>}
                </article>;
              })}
            </div>}
          </section>

          <form className="sale-order" onSubmit={finishSale}>
            <div className="order-heading"><div><p className="sales-eyebrow">VENDA ATUAL</p><h2>Pedido</h2></div><span className="order-count">{totalItems}</span></div>
            {cartItems.length === 0 ? <div className="order-empty">Adicione bebidas para iniciar a venda.</div> : <div className="order-lines">
              {cartItems.map(({ product, quantity }) => {
                const available = Number(product.locationQuantities[LOCATION] ?? 0);
                return <div className="order-line" key={product.id}>
                  <div className="order-line-info"><strong>{product.name}</strong><small>{money(product.salePrice)} / {product.unit}</small><b>{money(product.salePrice * quantity)}</b></div>
                  <div className="quantity-stepper"><button type="button" onClick={() => changeQuantity(product, -1)} aria-label={`Diminuir ${product.name}`}>−</button><span>{quantity}</span><button type="button" disabled={quantity >= available} onClick={() => changeQuantity(product, 1)} aria-label={`Aumentar ${product.name}`}>+</button></div>
                </div>;
              })}
            </div>}

            <fieldset className="settlement-fieldset">
              <legend>Forma de cobrança</legend>
              <div className="settlement-options">
                <label className={settlement === 'pago_na_recepcao' ? 'settlement-option chosen' : 'settlement-option'}><input type="radio" name="settlement" value="pago_na_recepcao" checked={settlement === 'pago_na_recepcao'} onChange={() => { setSettlement('pago_na_recepcao'); setPaymentMethod(''); }} /><span>Receber agora</span></label>
                <label className={settlement === 'cobrar_no_checkout' ? 'settlement-option chosen' : 'settlement-option'}><input type="radio" name="settlement" value="cobrar_no_checkout" checked={settlement === 'cobrar_no_checkout'} onChange={() => { setSettlement('cobrar_no_checkout'); setPaymentMethod(''); }} /><span>Lançar no quarto</span></label>
              </div>
            </fieldset>

            {settlement === 'pago_na_recepcao' ? <label className="sales-field"><span>Forma de pagamento *</span><select required value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value as MinibarPaymentMethod | '')}><option value="">Selecione</option><option value="dinheiro">Dinheiro</option><option value="pix">Pix</option><option value="cartao_debito">Cartão de débito</option><option value="cartao_credito">Cartão de crédito</option></select></label> : <div className="room-fields"><label className="sales-field"><span>Quarto ocupado *</span><select required value={roomNumber} onChange={(event) => { const reservation = occupiedReservations.find((item) => item.roomNumber === event.target.value); setRoomNumber(event.target.value); setGuestName(reservation?.guestName ?? ''); }}><option value="">Selecione a hospedagem</option>{occupiedReservations.map((reservation) => <option key={reservation.id} value={reservation.roomNumber}>Quarto {reservation.roomNumber} · {reservation.guestName}</option>)}</select>{occupiedReservations.length === 0 && <small>Nenhuma hospedagem ativa. Faça check-in em Reservas antes de lançar consumo no quarto.</small>}</label><label className="sales-field"><span>Hóspede vinculado</span><input value={guestName} readOnly placeholder="Selecione um quarto ocupado" /></label></div>}

            <div className="order-total"><span>Total</span><strong>{money(total)}</strong></div>
            <button className="sale-submit" type="submit" disabled={saving || loading || cartItems.length === 0}>{saving ? 'Registrando venda...' : settlement === 'pago_na_recepcao' ? 'Confirmar e receber' : 'Lançar para checkout'}</button>
            <p className="sale-note">O saldo da Geladeira - Recepção e o histórico são atualizados juntos.</p>
          </form>
        </div>
      </main>
    </div>
  );
}