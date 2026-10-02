import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { createFrigobarSale, emptyFrigobar, settleFrigobarSale, subscribeFrigobar } from '../services/frigobarStore';
import { useFrigobarFinanceSync } from '../services/minibarFinanceSync';
import type { MinibarPaymentMethod, MinibarSettlement } from '../types/inventory';
import type { FrigobarData, FrigobarProduct } from '../types/frigobar';
import { emptyHousekeeping, recordReservationExtra, subscribeHousekeeping } from '../services/housekeepingStore';
import type { HousekeepingData, ReservationExtraType } from '../types/housekeeping';
import './venda-geladeira.css';

const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const extraLabels: Record<ReservationExtraType, string> = {
  cafe_manha: 'Café da manhã',
  colchao_extra: 'Colchão extra',
  pessoa_adicional: 'Pessoa adicional',
  checkin_antecipado: 'Check-in antecipado',
  checkout_tardio: 'Check-out tardio',
  consumo: 'Consumo',
};
const createExtraIds = () => Object.fromEntries(Object.keys(extraLabels).map((type) => [type, crypto.randomUUID()])) as Record<ReservationExtraType, string>;

export function VendaGeladeira({ actor, isAdmin }: { actor: string; isAdmin: boolean }) {
  const [data, setData] = useState<FrigobarData>(emptyFrigobar());
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
  const [selectedReservationId, setSelectedReservationId] = useState('');
  const [extraAmounts, setExtraAmounts] = useState<Partial<Record<ReservationExtraType, string>>>({});
  const [extraIds, setExtraIds] = useState(createExtraIds);
  const [saleId, setSaleId] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const [settlementMethods, setSettlementMethods] = useState<Record<string, MinibarPaymentMethod>>({});

  useEffect(() => subscribeFrigobar((next) => {
    setData(next);
    setLoading(false);
    setLoadError('');
  }, (error) => {
    setLoadError(error.message);
    setLoading(false);
  }), []);

  useEffect(() => subscribeHousekeeping(setHousekeeping, () => setHousekeeping(emptyHousekeeping())), []);

  useFrigobarFinanceSync(data.sales, isAdmin, setSaveError);

  const products = Object.values(data.products)
    .filter((product) => product.active)
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const filteredProducts = products.filter((product) => product.name.toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR')));
  const hasReceptionStock = products.some((product) => Number(data.stock[product.id] ?? 0) > 0);
  const cartItems = Object.entries(cart)
    .map(([productId, quantity]) => ({ product: data.products[productId], quantity, available: Number(data.stock[productId] ?? 0) }))
    .filter((item): item is { product: FrigobarProduct; quantity: number; available: number } => Boolean(item.product) && item.quantity > 0);
  const totalItems = cartItems.reduce((total, item) => total + item.quantity, 0);
  const productTotal = cartItems.reduce((amount, item) => amount + item.product.salePrice * item.quantity, 0);
  const extras = Object.entries(extraAmounts).filter((entry): entry is [ReservationExtraType, string] => entry[1] !== undefined).map(([type, amount]) => ({ type, amount: Number(amount), id: extraIds[type] }));
  const extrasTotal = extras.reduce((sum, extra) => sum + extra.amount, 0);
  const total = productTotal + extrasTotal;
  const pendingSales = Object.values(data.sales).filter((sale) => sale.settlement === 'cobrar_no_checkout').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const occupiedReservations = Object.values(housekeeping.reservations)
    .filter((reservation) => reservation.status === 'hospedado')
    .sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, 'pt-BR', { numeric: true }));
  const selectedReservation = housekeeping.reservations[selectedReservationId];

  function changeQuantity(product: FrigobarProduct, change: number) {
    const available = Number(data.stock[product.id] ?? 0);
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
    if (extras.length > 0 && (!selectedReservation || selectedReservation.status !== 'hospedado')) {
      setSaveError('Selecione um hóspede com check-in realizado para lançar extras no quarto.');
      return;
    }
    if (extras.some((extra) => !Number.isFinite(extra.amount) || extra.amount <= 0)) {
      setSaveError('Informe um valor maior que zero para cada adicional.');
      return;
    }
    const sale = {
      id: saleId,
      items: cartItems.map(({ product, quantity }) => ({ productId: product.id, quantity })),
      settlement,
      paymentMethod,
      roomNumber,
      guestName,
      actor,
    };
    setSaving(true);
    try {
      if (selectedReservation) {
        for (const extra of extras) {
          await recordReservationExtra({
            id: extra.id,
            reservationId: selectedReservation.id,
            type: extra.type,
            description: extraLabels[extra.type],
            amount: extra.amount,
            date: new Date().toISOString().slice(0, 10),
            actor,
            createdAt: new Date().toISOString(),
          });
        }
      }
      if (cartItems.length > 0) await createFrigobarSale({ ...sale, catalog: data.products });
      setCart({});
      setPaymentMethod('');
      setRoomNumber('');
      setGuestName('');
      setSelectedReservationId('');
      setExtraAmounts({});
      setExtraIds(createExtraIds());
      setSaleId(crypto.randomUUID());
      setNotice(cartItems.length === 0 ? `Adicionais lançados no quarto ${roomNumber}.` : settlement === 'pago_na_recepcao' ? 'Venda recebida na recepção; adicionais lançados no quarto.' : `Venda e adicionais lançados no quarto ${roomNumber}.`);
      window.setTimeout(() => setNotice(''), 4500);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Não foi possível registrar a venda.');
    } finally {
      setSaving(false);
    }
  }

  async function settlePendingSale(saleId: string) {
    setSaveError('');
    try {
      await settleFrigobarSale(saleId, settlementMethods[saleId] ?? 'dinheiro', actor);
      setNotice('Cobrança do frigobar recebida e registrada.');
      window.setTimeout(() => setNotice(''), 4500);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Não foi possível registrar o recebimento.');
    }
  }

  return (
    <div className="sales-page">
      <header className="sales-header">
        <Link to="/" className="sales-brand"><span className="sales-brand-mark">HL</span><span><strong>Hotel Lindoia</strong><small>CAIXA DA RECEPÇÃO</small></span></Link>
        <nav className="sales-header-links" aria-label="Navegação"><Link to="/reservas">Reservas</Link><Link to="/quartos">Serviço de quarto</Link>{isAdmin && <Link to="/estoque">Estoque</Link>}<Link to="/">Painel inicial</Link></nav>
      </header>

      <main className="sales-content">
        <div className="sales-title-row">
          <div><p className="sales-eyebrow">PONTO DE VENDA <span>/</span> RECEPÇÃO</p><h1>Lançar Venda</h1><p>Selecione produtos e adicionais da hospedagem.</p></div>
          <span className="sales-operator">Atendente <strong>{actor}</strong></span>
        </div>

        {loadError && <div className="sales-alert" role="alert">Não foi possível carregar o estoque: {loadError}</div>}
        {saveError && <div className="sales-alert" role="alert">{saveError}</div>}
        {notice && <div className="sales-success" role="status">{notice}</div>}

        <div className="sales-layout">
          <section className="catalog-panel">
            <div className="catalog-heading"><div><h2>Produtos disponíveis</h2><p>{products.length} {products.length === 1 ? 'produto cadastrado' : 'produtos cadastrados'}</p></div><label className="catalog-search"><span className="sr-only">Buscar produto</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar bebida" /></label></div>
            {!loading && products.length > 0 && !hasReceptionStock && <div className="sales-stock-notice"><span>Os produtos estão cadastrados, mas ainda não têm saldo na Geladeira - Recepção.</span>{isAdmin && <Link to="/estoque">Registrar entrada no estoque <span aria-hidden="true">→</span></Link>}</div>}
            {loading ? <div className="sales-empty">Carregando produtos do Firebase...</div> : filteredProducts.length === 0 ? (
              <div className="sales-empty"><strong>{products.length === 0 ? 'Nenhum produto cadastrado' : 'Nenhum produto encontrado'}</strong><p>{products.length === 0 ? 'Solicite à gerência o cadastro dos produtos da Geladeira - Recepção.' : 'Tente outro nome de produto.'}</p>{products.length === 0 && isAdmin && <Link className="sales-outline-button" to="/estoque">Abrir estoque</Link>}</div>
            ) : <div className="sales-product-grid">
              {filteredProducts.map((product) => {
                const available = Number(data.stock[product.id] ?? 0);
                const inCart = cart[product.id] ?? 0;
                return <article className="sales-product" key={product.id}>
                  <div className="sales-product-top"><span className="sales-product-kind">BEBIDA</span><span className={available > 0 ? 'sales-stock-ok' : 'sales-stock-empty'}>{available > 0 ? `${available} ${product.unit}` : 'Sem saldo'}</span></div>
                  <strong className="sales-product-name">{product.name}</strong>
                  {product.salePrice > 0 ? <span className="sales-product-price">{money(product.salePrice)}</span> : <span className="sales-product-no-price">Preço não cadastrado</span>}
                  {available <= 0 || product.salePrice <= 0 ? <span className="sales-product-no-price">Consulte a gerência</span> : <button className="sales-add-button" disabled={inCart >= available} onClick={() => changeQuantity(product, 1)}>{inCart >= available ? `Limite · ${inCart} no pedido` : inCart ? `Adicionar · ${inCart} no pedido` : 'Adicionar ao pedido'} <span aria-hidden="true">+</span></button>}
                </article>;
              })}
            </div>}
          </section>

          <form className="sale-order" onSubmit={finishSale}>
            <div className="order-heading"><div><p className="sales-eyebrow">VENDA ATUAL</p><h2>Pedido</h2></div><span className="order-count">{totalItems + extras.length}</span></div>
            {cartItems.length === 0 && extras.length === 0 ? <div className="order-empty">Adicione produtos ou extras para iniciar a venda.</div> : cartItems.length > 0 && <div className="order-lines">
              {cartItems.map(({ product, quantity, available }) => {
                return <div className="order-line" key={product.id}>
                  <div className="order-line-info"><strong>{product.name}</strong><small>{money(product.salePrice)} / {product.unit}</small><b>{money(product.salePrice * quantity)}</b></div>
                  <div className="quantity-stepper"><button type="button" onClick={() => changeQuantity(product, -1)} aria-label={`Diminuir ${product.name}`}>−</button><span>{quantity}</span><button type="button" disabled={quantity >= available} onClick={() => changeQuantity(product, 1)} aria-label={`Aumentar ${product.name}`}>+</button></div>
                </div>;
              })}
            </div>}
            {extras.length > 0 && <div className="order-lines sales-extra-order-lines">{extras.map((extra) => <div className="order-line" key={extra.type}><div className="order-line-info"><strong>{extraLabels[extra.type]}</strong><small>Adicional da hospedagem</small><b>{money(extra.amount)}</b></div><button type="button" className="remove-extra-button" onClick={() => setExtraAmounts((current) => { const next = { ...current }; delete next[extra.type]; return next; })} aria-label={`Remover ${extraLabels[extra.type]}`}>×</button></div>)}</div>}

            <section className="sales-extras-fieldset"><div><strong>Extras da hospedagem</strong><small>Serão adicionados ao saldo do quarto selecionado.</small></div><div className="sales-extra-grid">{(Object.entries(extraLabels) as [ReservationExtraType, string][]).map(([type, label]) => <div className="sales-extra-option" key={type}><label><input type="checkbox" checked={extraAmounts[type] !== undefined} onChange={(event) => setExtraAmounts((current) => { const next = { ...current }; if (event.target.checked) next[type] = ''; else delete next[type]; return next; })} /><span>{label}</span></label>{extraAmounts[type] !== undefined && <label className="sales-extra-amount"><span>Valor (R$)</span><input type="number" min="0.01" step="0.01" required value={extraAmounts[type] ?? ''} onChange={(event) => setExtraAmounts((current) => ({ ...current, [type]: event.target.value }))} /></label>}</div>)}</div></section>

            {cartItems.length > 0 && <fieldset className="settlement-fieldset">
              <legend>Forma de cobrança</legend>
              <div className="settlement-options">
                <label className={settlement === 'pago_na_recepcao' ? 'settlement-option chosen' : 'settlement-option'}><input type="radio" name="settlement" value="pago_na_recepcao" checked={settlement === 'pago_na_recepcao'} onChange={() => { setSettlement('pago_na_recepcao'); setPaymentMethod(''); }} /><span>Receber agora</span></label>
                <label className={settlement === 'cobrar_no_checkout' ? 'settlement-option chosen' : 'settlement-option'}><input type="radio" name="settlement" value="cobrar_no_checkout" checked={settlement === 'cobrar_no_checkout'} onChange={() => { setSettlement('cobrar_no_checkout'); setPaymentMethod(''); }} /><span>Lançar no quarto</span></label>
              </div>
            </fieldset>}

            {cartItems.length > 0 && settlement === 'pago_na_recepcao' && <label className="sales-field"><span>Forma de pagamento *</span><select required value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value as MinibarPaymentMethod | '')}><option value="">Selecione</option><option value="dinheiro">Dinheiro</option><option value="pix">Pix</option><option value="cartao_debito">Cartão de débito</option><option value="cartao_credito">Cartão de crédito</option></select></label>}
            {extras.length > 0 || (cartItems.length > 0 && settlement === 'cobrar_no_checkout') ? <div className="room-fields"><label className="sales-field"><span>Quarto ocupado *</span><select required value={selectedReservationId} onChange={(event) => { const reservation = occupiedReservations.find((item) => item.id === event.target.value); setSelectedReservationId(event.target.value); setRoomNumber(reservation?.roomNumber ?? ''); setGuestName(reservation?.guestName ?? ''); }}><option value="">Selecione a hospedagem</option>{occupiedReservations.map((reservation) => <option key={reservation.id} value={reservation.id}>Quarto {reservation.roomNumber} · {reservation.guestName}</option>)}</select>{occupiedReservations.length === 0 && <small>Nenhuma hospedagem ativa. Faça check-in em Reservas antes de lançar no quarto.</small>}</label><label className="sales-field"><span>Hóspede vinculado</span><input value={guestName} readOnly placeholder="Selecione um quarto ocupado" /></label></div> : null}

            <div className="order-total"><span>Total</span><strong>{money(total)}</strong></div>
            <button className="sale-submit" type="submit" disabled={saving || loading || (cartItems.length === 0 && extras.length === 0)}>{saving ? 'Registrando venda...' : cartItems.length === 0 ? 'Lançar extras no quarto' : settlement === 'pago_na_recepcao' ? 'Confirmar venda' : 'Lançar para checkout'}</button>
            <p className="sale-note">Bebidas atualizam o estoque. Extras ficam no saldo da hospedagem selecionada.</p>
          </form>
        </div>
        {pendingSales.length > 0 && <section className="pending-minibar-panel"><div><h2>Cobranças no checkout</h2><p>{pendingSales.length} venda(s) aguardando pagamento</p></div>{pendingSales.map((sale) => <div className="pending-minibar-sale" key={sale.id}><span>Quarto {sale.roomNumber} · {sale.guestName}</span><strong>{money(sale.amount)}</strong><label><span className="sr-only">Forma de pagamento</span><select value={settlementMethods[sale.id] ?? 'dinheiro'} onChange={(event) => setSettlementMethods((current) => ({ ...current, [sale.id]: event.target.value as MinibarPaymentMethod }))}><option value="dinheiro">Dinheiro</option><option value="pix">Pix</option><option value="cartao_debito">Cartão de débito</option><option value="cartao_credito">Cartão de crédito</option></select></label><button type="button" onClick={() => void settlePendingSale(sale.id)}>Receber no checkout</button></div>)}</section>}
      </main>
    </div>
  );
}