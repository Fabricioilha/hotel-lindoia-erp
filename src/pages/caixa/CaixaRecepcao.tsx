import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { BackToPanel } from '../../components/ui/BackToPanel';
import { useAttendant } from '../../services/useAttendant';
import { ActionCard } from '../../components/ui/ActionCard';
import type { UserRole } from '../../types';
import { DateInput } from '../../components/ui/DateInput';
import { PAYMENT_METHOD_LABELS, type FinancePaymentMethod } from '../../types/finance';
import {
  DEFAULT_ATTENDANTS, EXTRA_LABELS, FOLIO_PAYMENT_METHODS, SELECTABLE_EXTRAS, extraTotal,
  type Attendant, type ExtraType, type GuestStay, type ReceptionData, type StayExtra, type StayKind,
} from '../../types/reception';
import { emptyHousekeeping, subscribeHousekeeping } from '../../services/housekeepingStore';
import { deleteAttendant, emptyReception, localDateKey, saveAttendant, saveStay, seedDefaultAttendants, subscribeReception, useReceptionFinanceSync } from '../../services/receptionStore';
import '../venda-geladeira.css';
import './recepcao.css';

const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const taxLabel = (method: FinancePaymentMethod) => method === 'prepaid' ? 'Pré-pago' : `Balcão - ${PAYMENT_METHOD_LABELS[method]}`;

function parseAmount(value: string) {
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) / 100 : 0;
}

interface ExtraDraft { id: string; type: ExtraType; label: string; amount: string; method: FinancePaymentMethod }

export function CaixaRecepcao({ userRole }: { userRole: UserRole }) {
  const isAdmin = userRole === 'admin';
  const [data, setData] = useState<ReceptionData>(emptyReception());
  const [roomNumbers, setRoomNumbers] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const dutyAttendant = useAttendant();
  const attendant = isAdmin ? 'Gerência' : dutyAttendant;
  const navigate = useNavigate();
  const [newName, setNewName] = useState('');
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('novo');
  const [formKind, setFormKind] = useState<StayKind | null>(requested === 'hospede' ? 'hospede' : requested === 'rotativo' ? 'periodo' : null);
  const [checkInDate, setCheckInDate] = useState(() => localDateKey());
  const [roomNumber, setRoomNumber] = useState('');
  const [guestName, setGuestName] = useState('');
  const [nights, setNights] = useState('1');
  const [hours, setHours] = useState('4');
  const [dailyRate, setDailyRate] = useState('');
  const [dailyMethod, setDailyMethod] = useState<FinancePaymentMethod>('pix');
  const [splitPayment, setSplitPayment] = useState(false);
  const [splitMethod, setSplitMethod] = useState<FinancePaymentMethod>('cash');
  const [splitAmount, setSplitAmount] = useState('');
  const [hasBreakfast, setHasBreakfast] = useState(false);
  const [breakfastRate, setBreakfastRate] = useState('');
  const [hasTax, setHasTax] = useState(false);
  const [taxAmount, setTaxAmount] = useState('');
  const [taxMethod, setTaxMethod] = useState<FinancePaymentMethod>('cash');
  const [extras, setExtras] = useState<ExtraDraft[]>([]);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => subscribeReception((next) => {
    setData(next);
    setLoading(false);
  }, (cause) => {
    setError(cause.message);
    setLoading(false);
  }), []);

  useEffect(() => subscribeHousekeeping(
    (next) => setRoomNumbers(Object.values((next ?? emptyHousekeeping()).rooms).map((room) => room.number)),
    () => setRoomNumbers([]),
  ), []);

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
  const allRoomNumbers = [...new Set([...roomNumbers, ...Object.values(data.rooms).map((room) => room.number)])]
    .sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }));

  const draftHours = Math.min(24, Math.max(1, Math.floor(Number(hours) || 4)));
  const draftNights = formKind === 'periodo' ? 1 : Math.min(60, Math.max(1, Math.floor(Number(nights) || 1)));
  const dailyTotal = parseAmount(dailyRate) * draftNights;
  const draftSplit = splitPayment ? parseAmount(splitAmount) : 0;
  const draftExtras = extras.map((extra) => ({ ...extra, amount: parseAmount(extra.amount) }));
  const draftTotal = dailyTotal
    + (formKind === 'hospede' && hasBreakfast ? parseAmount(breakfastRate) * draftNights : 0)
    + (formKind === 'hospede' && hasTax ? parseAmount(taxAmount) : 0)
    + draftExtras.reduce((total, extra) => total + extraTotal(extra, draftNights), 0);

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

  function openForm(kind: StayKind) {
    setExtras([]);
    setError('');
    setNotice('');
    setCheckInDate(localDateKey());
    setFormKind(kind);
  }

  function closeForm() {
    setFormKind(null);
    if (searchParams.has('novo')) setSearchParams({}, { replace: true });
  }

  function cancelForm() {
    navigate('/');
  }

  function addExtra(type: ExtraType) {
    setExtras((current) => [...current, { id: crypto.randomUUID(), type, label: type === 'outros' ? '' : EXTRA_LABELS[type], amount: '', method: 'pix' }]);
  }

  function updateExtra(id: string, patch: Partial<ExtraDraft>) {
    setExtras((current) => current.map((extra) => extra.id === id ? { ...extra, ...patch } : extra));
  }

  function resetForm() {
    setRoomNumber('');
    setGuestName('');
    setNights('1');
    setHours('4');
    setDailyRate('');
    setSplitPayment(false);
    setSplitAmount('');
    setHasBreakfast(false);
    setBreakfastRate('');
    setHasTax(false);
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
    const withTax = formKind === 'hospede' && hasTax;
    const tax = withTax ? parseAmount(taxAmount) : 0;
    if (!checkInDate) return setError('Informe uma data válida.');
    if (!roomNumber.trim()) return setError('Informe o quarto.');
    if (formKind === 'hospede' && !guestName.trim()) return setError('Informe o nome do hóspede titular.');
    if (!rate) return setError('Informe o valor da diária.');
    if (splitPayment && (!draftSplit || draftSplit >= dailyTotal)) return setError('O valor da segunda forma de pagamento deve ser maior que zero e menor que o valor da diária.');
    if (withBreakfast && !breakfast) return setError('Informe o valor do café.');
    if (withTax && !tax) return setError('Informe o valor da taxa ou desmarque "Cobrar taxa".');
    if (formKind === 'hospede' && draftExtras.some((extra) => !extra.amount || !extra.label.trim())) return setError('Preencha o nome e o valor de todos os extras.');
    const stay: GuestStay = {
      id: crypto.randomUUID(),
      kind: formKind,
      checkInDate,
      nights: draftNights,
      roomNumber: roomNumber.trim(),
      guestName: formKind === 'hospede' ? guestName.trim() : '',
      ...(formKind === 'periodo' ? { hours: draftHours } : {}),
      dailyRate: rate,
      dailyMethod,
      ...(splitPayment ? { dailySplit: { method: splitMethod, amount: draftSplit } } : {}),
      hasBreakfast: withBreakfast,
      breakfastRate: breakfast,
      taxAmount: tax,
      taxMethod,
      extras: formKind === 'periodo' ? [] : draftExtras.map<StayExtra>((extra) => ({ ...extra, label: extra.label.trim() })),
      note: note.trim(),
      attendant,
      status: 'hospedado',
      createdAt: new Date().toISOString(),
    };
    setSaving(true);
    const message = formKind === 'periodo' ? `Rotativo do quarto ${stay.roomNumber} registrado com sucesso.` : `Hóspede do quarto ${stay.roomNumber} registrado com sucesso.`;
    await run(async () => {
      await saveStay(stay);
      resetForm();
      closeForm();
      navigate('/', { state: { notice: message } });
    });
    setSaving(false);
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
          <BackToPanel />
          <div className="sales-title-row"><div><p className="sales-eyebrow">CAIXA <span>/</span> RECEPÇÃO</p><h1>Sem plantonista na escala</h1><p>O plantonista é definido automaticamente pela escala do dia. Não há ninguém escalado neste horário; avise a gerência para ajustar a escala.</p></div></div>
        </main>
      </div>
    );
  }

  return (
    <div className="sales-page">
      {header}
      <main className="sales-content" style={formKind ? { display: 'none' } : undefined}>
        <BackToPanel />
        <div className="sales-title-row">
          <div><p className="sales-eyebrow">CAIXA <span>/</span> RECEPÇÃO</p><h1>O que você quer lançar?</h1><p>Toque em uma das opções abaixo para registrar a movimentação do seu plantão.</p></div>
          <span className="reception-today"><small>Hoje</small><strong>{new Date(`${today}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}</strong></span>
          <span className="sales-operator reception-duty">Plantonista <strong>{attendant}</strong></span>
        </div>
        {alerts}

        <div className="action-grid">
          <ActionCard tone="blue" title="Adicionar hóspede" hint="Check-in com diárias, café, taxa e extras" icon="bed" onClick={() => openForm('hospede')} />
          <ActionCard tone="gold" title="Adicionar rotativo" hint="Estadia por horas" icon="clock" onClick={() => openForm('periodo')} />
          <ActionCard tone="red" title="Vender itens da geladeira" hint="Bebidas e itens da recepção" icon="cart" to="/vendas" />
        </div>

        {isAdmin && <details className="reception-panel reception-manage">
          <summary>Plantonistas cadastrados (a escala define quem está de plantão)</summary>
          <ul className="reception-entries">
            {attendants.map((item) => <li key={item.id}><strong>{item.name}</strong>{!item.id.startsWith('default-') && <span>
              <button type="button" className="reception-link-button" onClick={() => renameAttendant(item)}>Renomear</button>
              <button type="button" className="reception-link-button" onClick={() => removeAttendant(item)}>Excluir</button>
            </span>}</li>)}
          </ul>
          <form className="reception-add" onSubmit={(event) => void addAttendant(event)}>
            <label className="sales-field"><span>Novo plantonista</span><input value={newName} onChange={(event) => setNewName(event.target.value)} maxLength={60} placeholder="Nome" /></label>
            <button className="reception-primary" type="submit">Adicionar</button>
          </form>
        </details>}
      </main>

      {formKind && <div className="reception-overlay" role="dialog" aria-modal="true" aria-label={formKind === 'periodo' ? 'Adicionar rotativo' : 'Adicionar hóspede'}>
        <form className="reception-panel reception-modal" onSubmit={(event) => void submitStay(event)}>
          <div className="reception-modal-head">
            <h2>{formKind === 'periodo' ? 'Adicionar rotativo' : 'Adicionar hóspede'}</h2>
            <button type="button" className="reception-close" onClick={cancelForm} aria-label="Fechar">×</button>
          </div>
          {error && <div className="sales-alert" role="alert">{error}</div>}
          <div className="reception-grid">
            <label className="sales-field"><span>Data de entrada (digite ou use o calendário)</span><DateInput name="checkInDate" value={checkInDate} onValueChange={setCheckInDate} required /></label>
            <label className="sales-field"><span>Quarto</span><input value={roomNumber} list="reception-room-options" onChange={(event) => setRoomNumber(event.target.value)} maxLength={10} required /><datalist id="reception-room-options">{allRoomNumbers.map((number) => <option key={number} value={number} />)}</datalist></label>
            {formKind === 'hospede' && <label className="sales-field reception-wide"><span>Hóspede titular</span><input value={guestName} onChange={(event) => setGuestName(event.target.value)} maxLength={120} required /></label>}
            {formKind === 'periodo' && <label className="sales-field"><span>Quantidade de horas</span><input type="number" min={1} max={24} value={hours} onChange={(event) => setHours(event.target.value)} /></label>}
            {formKind === 'hospede' && <label className="sales-field"><span>Quantidade de diárias</span><input type="number" min={1} max={60} value={nights} onChange={(event) => setNights(event.target.value)} /></label>}
            <label className="sales-field"><span>{formKind === 'hospede' ? 'Valor de 1 diária (R$)' : 'Valor do rotativo (R$)'}</span><input inputMode="decimal" value={dailyRate} onChange={(event) => setDailyRate(event.target.value)} required /></label>
            <label className="sales-field"><span>{splitPayment ? '1ª forma de pagamento' : 'Forma de pagamento (FP)'}</span><select value={dailyMethod} onChange={(event) => setDailyMethod(event.target.value as FinancePaymentMethod)}>
              {FOLIO_PAYMENT_METHODS.map((method) => <option key={method} value={method}>{PAYMENT_METHOD_LABELS[method]}</option>)}
            </select></label>
            <label className="reception-check reception-wide"><input type="checkbox" checked={splitPayment} onChange={(event) => setSplitPayment(event.target.checked)} /> Combinar pagamento (o cliente vai pagar com duas formas)</label>
            {splitPayment && <div className="reception-split reception-wide">
              <label className="sales-field"><span>2ª forma de pagamento</span><select value={splitMethod} onChange={(event) => setSplitMethod(event.target.value as FinancePaymentMethod)}>
                {FOLIO_PAYMENT_METHODS.map((method) => <option key={method} value={method}>{PAYMENT_METHOD_LABELS[method]}</option>)}
              </select></label>
              <label className="sales-field"><span>Valor na 2ª forma (R$)</span><input inputMode="decimal" value={splitAmount} onChange={(event) => setSplitAmount(event.target.value)} /></label>
              <p className="reception-hint">{dailyTotal > 0 && draftSplit > 0 && draftSplit < dailyTotal
                ? <>{PAYMENT_METHOD_LABELS[dailyMethod]}: <strong>{money(dailyTotal - draftSplit)}</strong> · {PAYMENT_METHOD_LABELS[splitMethod]}: <strong>{money(draftSplit)}</strong></>
                : 'Informe quanto será pago na 2ª forma; o restante da diária fica na 1ª.'}</p>
            </div>}
            {formKind === 'periodo' && <p className="reception-hint reception-wide">Rotativo por hora, sem café da manhã e sem taxa. Altere a quantidade de horas se precisar.</p>}
            {formKind === 'hospede' && <div className="reception-optional reception-wide">
              <label className="reception-check"><input type="checkbox" checked={hasBreakfast} onChange={(event) => setHasBreakfast(event.target.checked)} /> Inclui café da manhã</label>
              {hasBreakfast && <label className="reception-small-field"><span>Café por dia (R$)</span><input inputMode="decimal" value={breakfastRate} onChange={(event) => setBreakfastRate(event.target.value)} /></label>}
            </div>}
            {formKind === 'hospede' && <div className="reception-optional reception-wide">
              <label className="reception-check"><input type="checkbox" checked={hasTax} onChange={(event) => setHasTax(event.target.checked)} /> Cobrar taxa</label>
              {hasTax && <>
                <label className="reception-small-field"><span>Taxa (R$)</span><input inputMode="decimal" value={taxAmount} onChange={(event) => setTaxAmount(event.target.value)} /></label>
                <label className="reception-small-field"><span>Pagamento da taxa</span><select value={taxMethod} onChange={(event) => setTaxMethod(event.target.value as FinancePaymentMethod)}>
                  {FOLIO_PAYMENT_METHODS.map((method) => <option key={method} value={method}>{taxLabel(method)}</option>)}
                </select></label>
              </>}
            </div>}
          </div>

          {formKind === 'hospede' && <div className="reception-extras">
            <div className="reception-extras-head"><strong>Extras</strong>
              <span>{SELECTABLE_EXTRAS.map((type) => <button key={type} type="button" className="reception-chip" onClick={() => addExtra(type)}>+ {EXTRA_LABELS[type]}</button>)}</span>
            </div>
            {extras.map((extra) => (
              <div key={extra.id} className="reception-extra-row">
                {extra.type === 'outros'
                  ? <input aria-label="Descrição do extra" placeholder="Descrição" value={extra.label} onChange={(event) => updateExtra(extra.id, { label: event.target.value })} maxLength={60} />
                  : <strong>{extra.label}</strong>}
                <input aria-label={`Valor de ${extra.label || 'extra'}`} inputMode="decimal" placeholder="Valor (R$)" value={extra.amount} onChange={(event) => updateExtra(extra.id, { amount: event.target.value })} />
                <select aria-label="Forma de pagamento do extra" value={extra.method} onChange={(event) => updateExtra(extra.id, { method: event.target.value as FinancePaymentMethod })}>
                  {FOLIO_PAYMENT_METHODS.map((method) => <option key={method} value={method}>{PAYMENT_METHOD_LABELS[method]}</option>)}
                </select>
                <button type="button" className="reception-link-button" onClick={() => setExtras((current) => current.filter((item) => item.id !== extra.id))}>Remover</button>
              </div>
            ))}
          </div>}

          <label className="reception-note"><span>Observações</span><textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} rows={3} placeholder="Escreva aqui qualquer informação importante sobre este registro" /></label>
          <p className="reception-total">Total: <strong>{money(draftTotal)}</strong></p>
          <div className="reception-actions">
            <button className="reception-primary" type="submit" disabled={saving}>{saving ? 'Salvando...' : 'Salvar Registro'}</button>
            <button type="button" className="sales-outline-button" onClick={cancelForm}>Cancelar</button>
          </div>
        </form>
      </div>}
    </div>
  );
}
