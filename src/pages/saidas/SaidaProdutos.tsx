import { useEffect, useState } from 'react';
import type { UserRole } from '../../types';
import { OUTPUT_DESTINATIONS, type OutputData, type OutputRecord } from '../../types/outputs';
import { createOutput, emptyOutputs, subscribeOutputs, useInternalOutputSync } from '../../services/internalOutputs';
import { localDateKey } from '../../services/receptionStore';
import { BackToPanel } from '../../components/ui/BackToPanel';
import { useAttendant } from '../../services/useAttendant';
import './saidas.css';

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

export function SaidaProdutos({ userRole }: { userRole: UserRole }) {
  const isAdmin = userRole === 'admin';
  const sessionAttendant = useAttendant();
  const actor = isAdmin ? 'Gerência' : sessionAttendant || 'Equipe';
  const [data, setData] = useState<OutputData>(emptyOutputs());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('todas');
  const [cart, setCart] = useState<Record<string, number>>({});
  const [destination, setDestination] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useInternalOutputSync(isAdmin, setError);

  useEffect(() => subscribeOutputs((next) => {
    setData(next);
    setLoading(false);
  }, (cause) => {
    setError(cause.message);
    setLoading(false);
  }), []);

  const records = Object.values(data.records);
  const pending = new Map<string, number>();
  records.filter((record) => !record.applied).forEach((record) => record.items.forEach((item) => pending.set(item.productId, (pending.get(item.productId) ?? 0) + item.quantity)));
  const remainingOf = (id: string) => Math.max(0, (data.catalog[id]?.available ?? 0) - (pending.get(id) ?? 0));

  const products = Object.values(data.catalog).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const categories = [...new Map(products.map((product) => [product.category, product.categoryName])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'));
  const visible = products.filter((product) => (category === 'todas' || product.category === category) && product.name.toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR')));
  const cartItems = Object.entries(cart).filter(([, quantity]) => quantity > 0).map(([id, quantity]) => ({ product: data.catalog[id], quantity })).filter((item) => item.product);
  const todayRecords = records.filter((record) => localDateKey(new Date(record.createdAt)) === localDateKey()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10);

  function change(id: string, delta: number) {
    setCart((current) => {
      const next = Math.max(0, Math.min(remainingOf(id), (current[id] ?? 0) + delta));
      const copy = { ...current };
      if (next === 0) delete copy[id];
      else copy[id] = next;
      return copy;
    });
  }

  async function confirm() {
    if (cartItems.length === 0) return;
    setError('');
    setNotice('');
    setSaving(true);
    const record: OutputRecord = {
      id: crypto.randomUUID(),
      items: cartItems.map(({ product, quantity }) => ({ productId: product.id, productName: product.name, unit: product.unit, quantity })),
      destination: destination.trim(),
      note: note.trim(),
      actor,
      createdAt: new Date().toISOString(),
    };
    try {
      await createOutput(record);
      setCart({});
      setDestination('');
      setNote('');
      setNotice(`Saída registrada: ${record.items.map((item) => `${item.quantity} ${item.unit} de ${item.productName}`).join(', ')}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível registrar a saída.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="out-page">
      <BackToPanel />
      <header className="out-title">
        <p className="out-eyebrow">OPERAÇÃO <span>/</span> ESTOQUE</p>
        <h1>Saída de Produtos</h1>
        <p>Use esta tela para retirar produtos do estoque para uso do hotel (shampoo, sabonete, etc.). Não é uma venda.</p>
      </header>

      {error && <div className="out-alert" role="alert">{error}</div>}
      {notice && <div className="out-success" role="status">{notice}</div>}

      <div className="out-layout">
        <section className="out-panel">
          <h2><span className="out-step">1</span> O que está saindo?</h2>
          <input className="out-search" type="search" placeholder="Digite para buscar um produto..." value={search} onChange={(event) => setSearch(event.target.value)} />
          <div className="out-chips">
            <button type="button" className={`out-chip ${category === 'todas' ? 'is-on' : ''}`} onClick={() => setCategory('todas')}>Todos</button>
            {categories.map(([id, name]) => <button key={id} type="button" className={`out-chip ${category === id ? 'is-on' : ''}`} onClick={() => setCategory(id)}>{name}</button>)}
          </div>
          {loading ? <p className="out-muted">Carregando produtos...</p> : products.length === 0 ? <p className="out-muted">Nenhum produto disponível ainda. Peça à gerência para abrir o sistema e atualizar o estoque.</p> : <ul className="out-products">
            {visible.map((product) => {
              const left = remainingOf(product.id);
              const quantity = cart[product.id] ?? 0;
              return <li key={product.id} className={`out-product ${quantity > 0 ? 'is-in-cart' : ''} ${left === 0 ? 'is-empty' : ''}`}>
                <div><strong>{product.name}</strong><small>{product.categoryName} · {left === 0 ? 'Sem saldo' : `Disponível: ${left} ${product.unit}`}</small></div>
                <div className="out-stepper">
                  <button type="button" onClick={() => change(product.id, -1)} disabled={quantity === 0} aria-label={`Diminuir ${product.name}`}>−</button>
                  <span aria-live="polite">{quantity}</span>
                  <button type="button" onClick={() => change(product.id, 1)} disabled={quantity >= left} aria-label={`Aumentar ${product.name}`}>+</button>
                </div>
              </li>;
            })}
            {visible.length === 0 && <li className="out-muted">Nenhum produto encontrado.</li>}
          </ul>}
        </section>

        <aside className="out-panel out-summary">
          <h2><span className="out-step">2</span> Confirmar saída</h2>
          {cartItems.length === 0 ? <p className="out-muted">Use os botões + para escolher os produtos.</p> : <ul className="out-cart">
            {cartItems.map(({ product, quantity }) => <li key={product.id}><span>{product.name}</span><strong>{quantity} {product.unit}</strong></li>)}
          </ul>}
          <label className="out-field">Para onde vai? (opcional)
            <input value={destination} onChange={(event) => setDestination(event.target.value)} maxLength={60} placeholder="Ex.: Quarto 12" />
          </label>
          <div className="out-chips">{OUTPUT_DESTINATIONS.map((item) => <button key={item} type="button" className={`out-chip ${destination === item ? 'is-on' : ''}`} onClick={() => setDestination(item)}>{item}</button>)}</div>
          <label className="out-field">Observação (opcional)
            <textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} maxLength={300} />
          </label>
          <p className="out-who">Registrado por <strong>{actor}</strong></p>
          <button type="button" className="out-confirm" disabled={cartItems.length === 0 || saving} onClick={() => void confirm()}>{saving ? 'Registrando...' : 'Confirmar saída'}</button>
          {cartItems.length > 0 && <button type="button" className="out-clear" onClick={() => setCart({})}>Limpar escolha</button>}
        </aside>
      </div>

      <section className="out-panel">
        <h2>Saídas de hoje</h2>
        {todayRecords.length === 0 ? <p className="out-muted">Nenhuma saída registrada hoje.</p> : <ul className="out-history">
          {todayRecords.map((record) => <li key={record.id}>
            <span className="out-time">{timeOf(record.createdAt)}</span>
            <span>{record.items.map((item) => `${item.quantity} ${item.unit} de ${item.productName}`).join(', ')}{record.destination ? ` → ${record.destination}` : ''}</span>
            <small>{record.actor}</small>
          </li>)}
        </ul>}
      </section>
    </div>
  );
}
