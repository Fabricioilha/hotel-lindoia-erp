import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { UserRole } from '../../types';
import { PAYMENT_METHOD_LABELS, type FinancePaymentMethod } from '../../types/finance';
import {
  ATTENDANT_STORAGE_KEY, DEFAULT_ATTENDANTS, EXTRA_LABELS, FOLIO_PAYMENT_METHODS, ROOM_BEDS, ROOM_TYPE_LABELS, SELECTABLE_ROOM_TYPES, extraTotal, stayTotals,
  type Attendant, type ExtraMode, type ExtraType, type GuestStay, type ReceptionData, type ReceptionRoom, type RoomType, type StayExtra, type StayKind,
} from '../../types/reception';
import { deleteAttendant, deleteRoom, deleteStay, emptyReception, localDateKey, saveAttendant, saveRoom, saveStay, seedDefaultAttendants, subscribeReception, useReceptionFinanceSync } from '../../services/receptionStore';
import '../venda-geladeira.css';
import './recepcao.css';

const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const formatDate = (key: string) => key.split('-').reverse().slice(0, 2).join('/');
const taxLabel = (method: FinancePaymentMethod) => method === 'prepaid' ? 'Pré-pago' : `Balcão - ${PAYMENT_METHOD_LABELS[method]}`;

function addDays(key: string, days: number) {
  const [year, month, day] = key.split('-').map(Number);
  return localDateKey(new Date(year, month - 1, day + days));
}

function parseAmount(value: string) {
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) / 100 : 0;
}

interface ExtraDraft { id: string; type: ExtraType; label: string; amount: string; mode: ExtraMode }

export function CaixaRecepcao({ userRole }: { userRole: UserRole }) {
  const isAdmin = userRole === 'admin';
  const [data, setData] = useState<ReceptionData>(emptyReception());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [attendant, setAttendant] = useState(() => sessionStorage.getItem(ATTENDANT_STORAGE_KEY) ?? '');
  const [newName, setNewName] = useState('');
  const [formKind, setFormKind] = useState<StayKind | null>(null);
  const [roomNumber, setRoomNumber] = useState('');
  const [guestName, setGuestName] = useState('');
  const [nights, setNights] = useState('1');
  const [dailyRate, setDailyRate] = useState('');
  const [dailyMethod, setDailyMethod] = useState<FinancePaymentMethod>('pix');
  const [hasBreakfast, setHasBreakfast] = useState(false);
  const [breakfastRate, setBreakfastRate] = useState('');
  const [taxAmount, setTaxAmount] = useState('');
  const [taxMethod, setTaxMethod] = useState<FinancePaymentMethod>('cash');
  const [extras, setExtras] = useState<ExtraDraft[]>([]);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [roomsOpen, setRoomsOpen] = useState(false);
  const [newRoomNumber, setNewRoomNumber] = useState('');
  const [newRoomType, setNewRoomType] = useState<RoomType>('casal');

  useEffect(() => subscribeReception((next) => {
    setData(next);
    setLoading(false);
  }, (cause) => {
    setError(cause.message);
    setLoading(false);
  }), []);

  useEffect(() => {
    if (isAdmin && !loading && Object.keys(data.attendants).length === 0) {
      void seedDefaultAttendants().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Não foi possível criar os plantonistas.'));
    }
  }, [isAdmin, loading, data.attendants]);

  useReceptionFinanceSync(data.stays, isAdmin, setError);

  const attendants: Attendant[] = Object.keys(data.attendants).length > 0
    ? Object.values(data.attendants).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
    : DEFAULT_ATTENDANTS.map((name) => ({ id: `default-${name}`, name }));
  const today = localDateKey();
  const rooms = Object.values(data.rooms).sort((a, b) => a.number.localeCompare(b.number, 'pt-BR', { numeric: true }));
  const allStays = Object.values(data.stays);
  const byRoom = (a: GuestStay, b: GuestStay) => a.roomNumber.localeCompare(b.roomNumber, 'pt-BR', { numeric: true });
  const active = allStays.filter((stay) => stay.kind === 'periodo' ? stay.checkInDate === today : addDays(stay.checkInDate, stay.nights) >= today).sort(byRoom);
  const guests = active.filter((stay) => stay.kind === 'hospede');
  const periods = active.filter((stay) => stay.kind === 'periodo');
  const sheetStart = active.reduce((min, stay) => stay.checkInDate < min ? stay.checkInDate : min, today);
  const sheetTotal = active.reduce((total, stay) => total + stayTotals(stay).total, 0);

  const draftNights = formKind === 'periodo' ? 1 : Math.min(60, Math.max(1, Math.floor(Number(nights) || 1)));
  const draftExtras = extras.map((extra) => ({ ...extra, amount: parseAmount(extra.amount) }));
  const draftTotal = parseAmount(dailyRate) * draftNights
    + (formKind === 'hospede' && hasBreakfast ? parseAmount(breakfastRate) * draftNights : 0)
    + (formKind === 'hospede' ? parseAmount(taxAmount) : 0)
    + draftExtras.reduce((total, extra) => total + extraTotal(extra, draftNights), 0);

  function chooseAttendant(name: string) {
    sessionStorage.setItem(ATTENDANT_STORAGE_KEY, name);
    setAttendant(name);
  }

  function changeAttendant() {
    sessionStorage.removeItem(ATTENDANT_STORAGE_KEY);
    setAttendant('');
  }

  async function run(action: () => Promise<void>, success = '') {
    setError('');
    setNotice('');
    try {
      await action();
      if (success) setNotice(success);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível concluir a operação.');
    }
  }

  async function addAttendant(event: FormEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    if (attendants.some((item) => item.name.toLocaleLowerCase('pt-BR') === name.toLocaleLowerCase('pt-BR'))) {
      setError('Já existe um plantonista com esse nome.');
      return;
    }
    await run(async () => {
      await saveAttendant({ id: crypto.randomUUID(), name });
      setNewName('');
    });
  }

  function renameAttendant(item: Attendant) {
    const name = window.prompt('Novo nome do plantonista', item.name)?.trim();
    if (!name || name === item.name) return;
    void run(() => saveAttendant({ id: item.id, name }));
  }

  function removeAttendant(item: Attendant) {
    if (!window.confirm(`Excluir o plantonista ${item.name}?`)) return;
    void run(() => deleteAttendant(item.id));
  }

  function openForm(kind: StayKind, room = '') {
    setError('');
    setRoomNumber(room);
    setFormKind(kind);
  }

  async function addRoom(event: FormEvent) {
    event.preventDefault();
    const number = newRoomNumber.trim();
    if (!number) return;
    if (rooms.some((room) => room.number.toLocaleLowerCase('pt-BR') === number.toLocaleLowerCase('pt-BR'))) {
      setError('Já existe um quarto com esse número.');
      return;
    }
    await run(async () => {
      await saveRoom({ id: crypto.randomUUID(), number, type: newRoomType });
      setNewRoomNumber('');
    });
  }

  function removeRoom(room: ReceptionRoom) {
    if (!window.confirm(`Excluir o quarto ${room.number} da folha?`)) return;
    void run(() => deleteRoom(room.id));
  }

  function addExtra(type: ExtraType) {
    setExtras((current) => [...current, { id: crypto.randomUUID(), type, label: type === 'outros' ? '' : EXTRA_LABELS[type], amount: '', mode: 'fixo' }]);
  }

  function updateExtra(id: string, patch: Partial<ExtraDraft>) {
    setExtras((current) => current.map((extra) => extra.id === id ? { ...extra, ...patch } : extra));
  }

  function resetForm() {
    setRoomNumber('');
    setGuestName('');
    setNights('1');
    setDailyRate('');
    setHasBreakfast(false);
    setBreakfastRate('');
    setTaxAmount('');
    setExtras([]);
    setNote('');
  }

  async function submitStay(event: FormEvent) {
    event.preventDefault();
    if (!formKind) return;
    const rate = parseAmount(dailyRate);
    const withBreakfast = formKind === 'hospede' && hasBreakfast;
    const breakfast = withBreakfast ? parseAmount(breakfastRate) : 0;
    if (!roomNumber.trim() || !guestName.trim()) return setError('Informe o apartamento e o nome do hóspede titular.');
    if (!rate) return setError('Informe o valor da diária.');
    if (withBreakfast && !breakfast) return setError('Informe o valor do café.');
    if (draftExtras.some((extra) => !extra.amount || !extra.label.trim())) return setError('Preencha o nome e o valor de todos os extras.');
    const stay: GuestStay = {
      id: crypto.randomUUID(),
      kind: formKind,
      checkInDate: today,
      nights: draftNights,
      roomNumber: roomNumber.trim(),
      guestName: guestName.trim(),
      dailyRate: rate,
      dailyMethod,
      hasBreakfast: withBreakfast,
      breakfastRate: breakfast,
      taxAmount: formKind === 'hospede' ? parseAmount(taxAmount) : 0,
      taxMethod,
      extras: draftExtras.map<StayExtra>((extra) => ({ ...extra, label: extra.label.trim() })),
      note: note.trim(),
      attendant,
      status: 'hospedado',
      createdAt: new Date().toISOString(),
    };
    setSaving(true);
    await run(async () => {
      await saveStay(stay);
      resetForm();
      setFormKind(null);
    }, formKind === 'periodo' ? 'Período adicionado à folha.' : 'Hóspede adicionado à folha.');
    setSaving(false);
  }

  function removeStay(stay: GuestStay) {
    if (!window.confirm(`Excluir o lançamento do quarto ${stay.roomNumber}? A receita no financeiro também será removida.`)) return;
    void run(() => deleteStay(stay), 'Lançamento excluído.');
  }

  const header = (
    <header className="sales-header">
      <Link to="/" className="sales-brand"><span className="sales-brand-mark">HL</span><span><strong>Hotel Lindoia</strong><small>CAIXA - RECEPÇÃO</small></span></Link>
      <nav className="sales-header-links" aria-label="Navegação"><Link to="/vendas">Lançar venda</Link><Link to="/escala">Escala</Link><Link to="/">Painel inicial</Link></nav>
    </header>
  );

  const alerts = <>
    {error && <div className="sales-alert" role="alert">{error}</div>}
    {notice && <div className="sales-success" role="status">{notice}</div>}
  </>;

  if (!attendant) {
    return (
      <div className="sales-page">
        {header}
        <main className="sales-content">
          <div className="sales-title-row"><div><p className="sales-eyebrow">CAIXA <span>/</span> RECEPÇÃO</p><h1>Quem está de plantão?</h1><p>Todos os lançamentos do turno ficarão registrados em nome do plantonista.</p></div></div>
          {alerts}
          {loading ? <div className="sales-empty">Carregando plantonistas...</div> : <div className="reception-attendants">
            {attendants.map((item) => (
              <div key={item.id} className="reception-attendant">
                <button type="button" className="reception-attendant-pick" onClick={() => chooseAttendant(item.name)}>{item.name}</button>
                {isAdmin && !item.id.startsWith('default-') && <span className="reception-attendant-tools">
                  <button type="button" className="reception-link-button" onClick={() => renameAttendant(item)}>Renomear</button>
                  <button type="button" className="reception-link-button" onClick={() => removeAttendant(item)}>Excluir</button>
                </span>}
              </div>
            ))}
          </div>}
          {isAdmin && <form className="reception-panel reception-add" onSubmit={(event) => void addAttendant(event)}>
            <label className="sales-field"><span>Novo plantonista</span><input value={newName} onChange={(event) => setNewName(event.target.value)} maxLength={60} placeholder="Nome" /></label>
            <button className="reception-primary" type="submit">Adicionar</button>
          </form>}
        </main>
      </div>
    );
  }

  return (
    <div className="sales-page">
      {header}
      <main className="sales-content">
        <div className="sales-title-row">
          <div><p className="sales-eyebrow">CAIXA <span>/</span> RECEPÇÃO</p><h1>Folha de diárias</h1><p>Data de <strong>{formatDate(sheetStart)}</strong> a <strong>{formatDate(today)}</strong> · hóspedes ficam na folha até o fim das diárias; períodos valem apenas no dia.</p></div>
          <span className="sales-operator">Plantonista <strong>{attendant}</strong><button type="button" className="reception-link-button" onClick={changeAttendant}>Trocar</button></span>
        </div>
        {alerts}

        <div className="reception-actions">
          <button type="button" className="reception-primary" onClick={() => openForm('hospede')}>Adicionar hóspede</button>
          <button type="button" className="reception-primary" onClick={() => openForm('periodo')}>Adicionar período</button>
          <button type="button" className="sales-outline-button" onClick={() => { setError(''); setRoomsOpen(true); }}>Cadastrar quartos</button>
          <Link className="sales-outline-button" to="/vendas">Lançar venda da geladeira →</Link>
        </div>

        <StaySheet title="Hóspedes" stays={guests} rooms={rooms} loading={loading} isAdmin={isAdmin} onDelete={removeStay} onFill={(room) => openForm('hospede', room)} />
        <StaySheet title="Períodos" stays={periods} loading={loading} isAdmin={isAdmin} onDelete={removeStay} />
        <p className="reception-total">Total da folha: <strong>{money(sheetTotal)}</strong></p>
      </main>

      {roomsOpen && <div className="reception-overlay" role="dialog" aria-modal="true" aria-label="Cadastrar quartos">
        <div className="reception-panel reception-modal">
          <h2>Quartos da folha</h2>
          {error && <div className="sales-alert" role="alert">{error}</div>}
          <form className="reception-room-form" onSubmit={(event) => void addRoom(event)}>
            <label className="sales-field"><span>Número</span><input value={newRoomNumber} onChange={(event) => setNewRoomNumber(event.target.value)} maxLength={10} required /></label>
            <label className="sales-field"><span>Tipo</span><select value={newRoomType} onChange={(event) => setNewRoomType(event.target.value as RoomType)}>
              {SELECTABLE_ROOM_TYPES.map((type) => <option key={type} value={type}>{ROOM_TYPE_LABELS[type]}</option>)}
            </select></label>
            <button className="reception-primary" type="submit">Cadastrar</button>
          </form>
          {rooms.length === 0 ? <div className="sales-empty">Nenhum quarto cadastrado.</div> : <ul className="reception-entries">
            {rooms.map((room) => <li key={room.id}><div><strong>Quarto {room.number}</strong><small><BedIcons type={room.type} /></small></div>{isAdmin && <button type="button" className="reception-link-button" onClick={() => removeRoom(room)}>Excluir</button>}</li>)}
          </ul>}
          <div className="reception-actions"><button type="button" className="sales-outline-button" onClick={() => setRoomsOpen(false)}>Fechar</button></div>
        </div>
      </div>}

      {formKind && <div className="reception-overlay" role="dialog" aria-modal="true" aria-label={formKind === 'periodo' ? 'Adicionar período' : 'Adicionar hóspede'}>
        <form className="reception-panel reception-modal" onSubmit={(event) => void submitStay(event)}>
          <h2>{formKind === 'periodo' ? 'Adicionar período' : 'Adicionar hóspede'}</h2>
          {error && <div className="sales-alert" role="alert">{error}</div>}
          <div className="reception-grid">
            <label className="sales-field"><span>Data (automática)</span><input value={today.split('-').reverse().join('/')} readOnly /></label>
            <label className="sales-field"><span>Apartamento</span><input value={roomNumber} list="reception-room-options" onChange={(event) => setRoomNumber(event.target.value)} maxLength={10} required /><datalist id="reception-room-options">{rooms.map((room) => <option key={room.id} value={room.number}>{ROOM_TYPE_LABELS[room.type]}</option>)}</datalist></label>
            <label className="sales-field reception-wide"><span>Hóspede titular</span><input value={guestName} onChange={(event) => setGuestName(event.target.value)} maxLength={120} required /></label>
            {formKind === 'hospede' && <label className="sales-field"><span>Quantidade de diárias</span><input type="number" min={1} max={60} value={nights} onChange={(event) => setNights(event.target.value)} /></label>}
            <label className="sales-field"><span>{formKind === 'hospede' ? 'Valor de 1 diária (R$)' : 'Valor do período (R$)'}</span><input inputMode="decimal" value={dailyRate} onChange={(event) => setDailyRate(event.target.value)} required /></label>
            <label className="sales-field"><span>Forma de pagamento (FP)</span><select value={dailyMethod} onChange={(event) => setDailyMethod(event.target.value as FinancePaymentMethod)}>
              {FOLIO_PAYMENT_METHODS.map((method) => <option key={method} value={method}>{PAYMENT_METHOD_LABELS[method]}</option>)}
            </select></label>
            {formKind === 'periodo' && <p className="reception-hint reception-wide">Período com duração fixa de 4 horas, sem café da manhã e sem taxa.</p>}
            {formKind === 'hospede' && <label className="reception-check reception-wide"><input type="checkbox" checked={hasBreakfast} onChange={(event) => setHasBreakfast(event.target.checked)} /> Inclui café da manhã</label>}
            {formKind === 'hospede' && hasBreakfast && <label className="sales-field reception-wide"><span>Valor do café por dia (R$)</span><input inputMode="decimal" value={breakfastRate} onChange={(event) => setBreakfastRate(event.target.value)} /></label>}
            {formKind === 'hospede' && <><label className="sales-field"><span>Taxa (R$)</span><input inputMode="decimal" value={taxAmount} onChange={(event) => setTaxAmount(event.target.value)} /></label>
            <label className="sales-field"><span>Pagamento da taxa</span><select value={taxMethod} onChange={(event) => setTaxMethod(event.target.value as FinancePaymentMethod)}>
              {FOLIO_PAYMENT_METHODS.map((method) => <option key={method} value={method}>{taxLabel(method)}</option>)}
            </select></label></>}
          </div>

          <div className="reception-extras">
            <div className="reception-extras-head"><strong>Extras</strong>
              <span>{(Object.keys(EXTRA_LABELS) as ExtraType[]).map((type) => <button key={type} type="button" className="reception-chip" onClick={() => addExtra(type)}>+ {EXTRA_LABELS[type]}</button>)}</span>
            </div>
            {extras.map((extra) => (
              <div key={extra.id} className="reception-extra-row">
                {extra.type === 'outros'
                  ? <input aria-label="Descrição do extra" placeholder="Descrição" value={extra.label} onChange={(event) => updateExtra(extra.id, { label: event.target.value })} maxLength={60} />
                  : <strong>{extra.label}</strong>}
                <input aria-label={`Valor de ${extra.label || 'extra'}`} inputMode="decimal" placeholder="Valor (R$)" value={extra.amount} onChange={(event) => updateExtra(extra.id, { amount: event.target.value })} />
                <select aria-label="Tipo de cobrança" value={extra.mode} onChange={(event) => updateExtra(extra.id, { mode: event.target.value as ExtraMode })}>
                  <option value="fixo">Valor fixo</option>
                  <option value="por_diaria">Varia com as diárias</option>
                </select>
                <button type="button" className="reception-link-button" onClick={() => setExtras((current) => current.filter((item) => item.id !== extra.id))}>Remover</button>
              </div>
            ))}
          </div>

          <label className="sales-field"><span>Observações</span><textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} rows={2} /></label>
          <p className="reception-total">Total: <strong>{money(draftTotal)}</strong></p>
          <div className="reception-actions">
            <button className="reception-primary" type="submit" disabled={saving}>{saving ? 'Salvando...' : 'Salvar na folha'}</button>
            <button type="button" className="sales-outline-button" onClick={() => setFormKind(null)}>Cancelar</button>
          </div>
        </form>
      </div>}
    </div>
  );
}

const ROOM_SHORT_LABELS: Record<RoomType, string> = {
  casal: 'Casal', casal_twin: 'Casal (Twin)', solteiro: 'Solteiro', triplo_casal_solteiro: 'Triplo', triplo_solteiros: 'Triplo', triplo: 'Triplo',
};

function BedIcon({ double }: { double: boolean }) {
  return (
    <svg className="bed-icon" width={double ? 26 : 20} height="16" viewBox={double ? '0 0 26 16' : '0 0 20 16'} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d={double ? 'M1 14V2M25 14v-3M1 11h24V8a2 2 0 0 0-2-2H3v5M4 6V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v1M14 6V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v1' : 'M1 14V2M19 14v-3M1 11h18V8a2 2 0 0 0-2-2H3v5M4 6V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v1'} />
    </svg>
  );
}

function BedIcons({ type }: { type: RoomType }) {
  return (
    <span className="bed-icons" title={ROOM_TYPE_LABELS[type]}>
      <span className="bed-icons-row">{ROOM_BEDS[type].map((bed, index) => <BedIcon key={index} double={bed === 'd'} />)}</span>
      <span className="bed-icons-label">{ROOM_SHORT_LABELS[type]}</span>
      <span className="sr-only">{ROOM_TYPE_LABELS[type]}</span>
    </span>
  );
}

function StaySheet({ title, stays, rooms, loading, isAdmin, onDelete, onFill }: {
  title: string; stays: GuestStay[]; rooms?: ReceptionRoom[]; loading: boolean; isAdmin: boolean; onDelete: (stay: GuestStay) => void; onFill?: (room: string) => void;
}) {
  const rows: { key: string; room?: ReceptionRoom; stay?: GuestStay }[] = rooms
    ? [
      ...rooms.map((room) => ({ key: room.id, room, stay: stays.find((stay) => stay.roomNumber === room.number) })),
      ...stays.filter((stay) => !rooms.some((room) => room.number === stay.roomNumber)).map((stay) => ({ key: stay.id, stay })),
    ]
    : stays.map((stay) => ({ key: stay.id, stay }));
  return (
    <section className="reception-panel reception-sheet">
      <h2>{title}</h2>
      {loading ? <div className="sales-empty">Carregando folha...</div> : rows.length === 0 ? <div className="sales-empty">{rooms ? 'Cadastre os quartos para exibi-los na folha.' : 'Nenhum lançamento em aberto.'}</div> : <div className="reception-table-wrap"><table className="reception-table">
        <thead><tr><th>Apto</th>{rooms && <th>Tipo</th>}<th>Hóspede</th><th>Entrada</th><th>Diária</th><th>FP</th><th>Café</th><th>Tx</th><th>Extras</th><th>Obs.</th><th>Total</th><th /></tr></thead>
        <tbody>
          {rows.map(({ key, room, stay }) => stay ? (
            <tr key={key}>
              <td><strong>{stay.roomNumber}</strong></td>
              {rooms && <td>{room ? <BedIcons type={room.type} /> : '—'}</td>}
              <td>{stay.guestName}<small>Plantão {stay.attendant}</small></td>
              <td>{formatDate(stay.checkInDate)}</td>
              <td>{stay.kind === 'hospede' ? `${money(stay.dailyRate)} × ${stay.nights}` : '4 horas'}<small>{money(stay.dailyRate * stay.nights)}</small></td>
              <td>{PAYMENT_METHOD_LABELS[stay.dailyMethod]}</td>
              <td>{stay.hasBreakfast ? <>{money(stay.breakfastRate * stay.nights)}{stay.kind === 'hospede' && <small>{money(stay.breakfastRate)}/dia</small>}</> : '—'}</td>
              <td>{stay.taxAmount > 0 ? <>{money(stay.taxAmount)}<small>{taxLabel(stay.taxMethod)}</small></> : '—'}</td>
              <td>{(stay.extras ?? []).length === 0 ? '—' : (stay.extras ?? []).map((extra) => <small key={extra.id}>{extra.label}: {money(extraTotal(extra, stay.nights))} ({extra.mode === 'fixo' ? 'fixo' : `${money(extra.amount)}/dia`})</small>)}</td>
              <td>{stay.note || '—'}</td>
              <td><strong>{money(stayTotals(stay).total)}</strong></td>
              <td className="reception-row-actions">
                {isAdmin && <button type="button" className="reception-link-button" onClick={() => onDelete(stay)}>Excluir</button>}
              </td>
            </tr>
          ) : room && (
            <tr key={key} className="reception-vacant">
              <td><strong>{room.number}</strong></td>
              <td><BedIcons type={room.type} /></td>
              <td colSpan={8}>Livre</td>
              <td className="reception-row-actions"><button type="button" className="reception-link-button" onClick={() => onFill?.(room.number)}>Lançar</button></td>
            </tr>
          ))}
        </tbody>
      </table></div>}
    </section>
  );
}
