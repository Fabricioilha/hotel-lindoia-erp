import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { UserRole } from '../../types';
import { PAYMENT_METHOD_LABELS, type FinancePaymentMethod } from '../../types/finance';
import type { MinibarPaymentMethod } from '../../types/inventory';
import { DEFAULT_ATTENDANTS, FLOAT_AMOUNT, stayPayments, stayTotals, type ReceptionData } from '../../types/reception';
import type { FrigobarData } from '../../types/frigobar';
import { deleteFrigobarSale, emptyFrigobar, subscribeFrigobar } from '../../services/frigobarStore';
import { deleteCashOut, deleteStay, emptyReception, localDateKey, subscribeReception } from '../../services/receptionStore';
import { currentDuty } from '../../services/dutyRoster';
import { emptySchedule, subscribeSchedule, type ScheduleStoreData } from '../../services/scheduleStore';
import { BackToPanel } from '../../components/ui/BackToPanel';
import { useAttendant } from '../../services/useAttendant';
import './caixa.css';

const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dateLabel = (key: string) => new Date(`${key}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
const FRIGOBAR_METHODS: Record<MinibarPaymentMethod, FinancePaymentMethod> = { dinheiro: 'cash', pix: 'pix', cartao_debito: 'debit', cartao_credito: 'credit' };

interface Entry { time: string; kind: 'stay' | 'sale'; remove?: () => void; title: string; detail: string; total: number; payments: { method: FinancePaymentMethod; amount: number }[] }
interface Day { date: string; entries: Entry[]; cashOuts: { id: string; time: string; reason: string; note: string; amount: number; remove?: () => void }[] }

export function ConferirCaixa({ userRole }: { userRole: UserRole }) {
  const isAdmin = userRole === 'admin';
  const [data, setData] = useState<ReceptionData>(emptyReception());
  const [frigobar, setFrigobar] = useState<FrigobarData>(emptyFrigobar());
  const [error, setError] = useState('');
  const sessionAttendant = useAttendant();
  const [chosen, setChosen] = useState('');

  function removeRecord(message: string, action: () => Promise<void>) {
    if (!window.confirm(message)) return;
    setError('');
    void action().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Não foi possível excluir o registro.'));
  }

  useEffect(() => subscribeReception(setData, (cause) => setError(cause.message)), []);
  const [schedule, setSchedule] = useState<ScheduleStoreData>(emptySchedule());
  useEffect(() => subscribeSchedule(setSchedule, () => undefined), []);
  useEffect(() => subscribeFrigobar(setFrigobar, () => setFrigobar(emptyFrigobar())), []);

  const names = [...new Set([...DEFAULT_ATTENDANTS, ...Object.values(data.attendants).map((item) => item.name)])].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const attendant = isAdmin ? chosen || names[0] : sessionAttendant;

  if (!attendant) {
    return <div className="cx-page"><div className="cx-panel"><h1>Conferir caixa</h1><p>Não há plantonista na escala neste horário. O plantonista é definido automaticamente pela escala; avise a gerência para ajustá-la.</p><Link className="cx-primary" to="/">Voltar ao Painel principal</Link></div></div>;
  }

  const days = new Map<string, Day>();
  const dayOf = (date: string) => {
    if (!days.has(date)) days.set(date, { date, entries: [], cashOuts: [] });
    return days.get(date) as Day;
  };
  dayOf(localDateKey());
  // Plantões noturnos atravessam a meia-noite: o movimento conta no dia em que o turno começou.
  const shiftDay = (when: string) => {
    const at = new Date(when);
    const duty = currentDuty(schedule.days, [attendant], at);
    return localDateKey(duty ? duty.start : at);
  };

  Object.values(data.stays).filter((stay) => stay.attendant === attendant).forEach((stay) => {
    dayOf(shiftDay(stay.createdAt)).entries.push({
      time: stay.createdAt,
      kind: 'stay',
      remove: isAdmin ? () => removeRecord(`Excluir o lançamento do quarto ${stay.roomNumber}? A receita no Financeiro também será removida.`, () => deleteStay(stay)) : undefined,
      title: `${stay.kind === 'periodo' ? 'Rotativo' : 'Hóspede'} · Quarto ${stay.roomNumber}`,
      detail: stay.kind === 'periodo' ? `${stay.hours ?? 4} hora(s)` : stay.guestName,
      total: stayTotals(stay).total,
      payments: stayPayments(stay),
    });
  });
  Object.values(frigobar.sales).filter((sale) => sale.settlement !== 'cobrar_no_checkout' && sale.paymentMethod && (sale.settledBy ?? sale.actor) === attendant).forEach((sale) => {
    const when = sale.settledAt ?? sale.createdAt;
    dayOf(shiftDay(when)).entries.push({
      time: when,
      kind: 'sale',
      remove: isAdmin ? () => removeRecord(`Excluir esta venda da geladeira (${money(sale.amount)})? Os itens voltam ao saldo da geladeira e a receita no Financeiro também será removida.`, () => deleteFrigobarSale(sale)) : undefined,
      title: 'Venda da geladeira',
      detail: sale.items.map((item) => `${item.quantity}× ${item.productName}`).join(', '),
      total: sale.amount,
      payments: [{ method: FRIGOBAR_METHODS[sale.paymentMethod as MinibarPaymentMethod], amount: sale.amount }],
    });
  });
  Object.values(data.cashOuts).filter((item) => item.attendant === attendant).forEach((item) => {
    dayOf(shiftDay(item.createdAt)).cashOuts.push({ id: item.id, time: item.createdAt, reason: item.reason, note: item.note, amount: item.amount, remove: isAdmin ? () => removeRecord(`Excluir a saída de caixa de ${money(item.amount)} (${item.reason})? A despesa no Financeiro também será removida.`, () => deleteCashOut(item.id)) : undefined });
  });
  const currentKey = shiftDay(new Date().toISOString());
  const ordered = [...days.values()].filter((day) => isAdmin || day.date === currentKey).sort((a, b) => b.date.localeCompare(a.date));

  return (
    <div className="cx-page">
      <BackToPanel />
      <header className="cx-title">
        <p className="cx-eyebrow">PLANTÃO <span>/</span> CAIXA</p>
        <h1>Conferir caixa</h1>
        <p>{isAdmin ? 'Resumo de tudo que o plantonista lançou em cada dia: entradas por forma de pagamento, retiradas e dinheiro que deve estar no caixa.' : 'Resumo do seu plantão de hoje: entradas por forma de pagamento, retiradas e dinheiro que deve estar no caixa.'}</p>
      </header>
      {error && <div className="cx-alert" role="alert">{error}</div>}

      <div className="cx-panel cx-who-row">
        {isAdmin ? <label className="cx-field">Plantonista
          <select value={attendant} onChange={(event) => setChosen(event.target.value)}>{names.map((name) => <option key={name} value={name}>{name}</option>)}</select>
        </label> : <p className="cx-who">Plantonista: <strong>{attendant}</strong></p>}
      </div>

      {ordered.map((day, index) => {
        const byMethod = new Map<FinancePaymentMethod, number>();
        day.entries.forEach((entry) => entry.payments.forEach((payment) => byMethod.set(payment.method, (byMethod.get(payment.method) ?? 0) + payment.amount)));
        const income = day.entries.reduce((sum, entry) => sum + entry.total, 0);
        const outs = day.cashOuts.reduce((sum, item) => sum + item.amount, 0);
        const cashIn = byMethod.get('cash') ?? 0;
        const check = Object.values(data.floatChecks).find((item) => item.attendant === attendant && shiftDay(item.createdAt) === day.date);
        const opening = check?.counted ?? FLOAT_AMOUNT;
        const expectedCash = opening + cashIn - outs;
        const toStore = Math.max(0, expectedCash - FLOAT_AMOUNT);
        return (
          <details key={day.date} className="cx-day" open={index === 0}>
            <summary>
              <span className="cx-day-date">{day.date === localDateKey() ? 'Hoje · ' : ''}{dateLabel(day.date)}</span>
              <span className="cx-day-total">Entradas {money(income)} · Dinheiro no caixa {money(expectedCash)}</span>
            </summary>
            <div className="cx-day-body">
              <div className="cx-stats">
                <div className="cx-stat"><small>Total de entradas</small><strong>{money(income)}</strong></div>
                <div className="cx-stat is-out"><small>Saídas de caixa</small><strong>− {money(outs)}</strong></div>
                <div className="cx-stat is-cash"><small>Dinheiro que deve estar no caixa</small><strong>{money(expectedCash)}</strong></div>
                <div className="cx-stat is-store"><small>Guardar ao fechar (manter {money(FLOAT_AMOUNT)} de troco)</small><strong>{money(toStore)}</strong></div>
              </div>
              <p className={`cx-float ${check && check.counted !== check.expected ? 'is-diff' : ''}`}>
                Troco ao assumir: <strong>{money(opening)}</strong>{check ? (check.counted === check.expected ? ' (conferido, sem diferença)' : ` — diferença de ${money(check.counted - check.expected)} em relação a ${money(check.expected)}${check.previousAttendant ? `, deixado por ${check.previousAttendant}` : ''}. Justificativa: ${check.justification}`) : ' (não conferido)'}.
              </p>

              <h3>Entradas por forma de pagamento</h3>
              {byMethod.size === 0 ? <p className="cx-muted">Nenhuma entrada neste dia.</p> : <ul className="cx-methods">
                {[...byMethod.entries()].map(([method, value]) => <li key={method}><span>{PAYMENT_METHOD_LABELS[method]}</span><strong>{money(value)}</strong></li>)}
              </ul>}

              <h3>Lançamentos</h3>
              {day.entries.length === 0 ? <p className="cx-muted">Nenhum lançamento neste dia.</p> : <ul className="cx-list">
                {day.entries.sort((a, b) => a.time.localeCompare(b.time)).map((entry, position) => <li key={`${entry.time}-${position}`}>
                  <span className="cx-time">{timeOf(entry.time)}</span>
                  <span><strong>{entry.title}</strong><small>{entry.detail}{entry.payments.length > 0 ? ` · ${entry.payments.map((payment) => `${PAYMENT_METHOD_LABELS[payment.method]} ${money(payment.amount)}`).join(' + ')}` : ''}</small></span>
                  <strong>{money(entry.total)}{entry.remove && <button type="button" className="cx-delete" onClick={entry.remove}>Excluir</button>}</strong>
                </li>)}
              </ul>}

              <h3>Saídas de caixa</h3>
              {day.cashOuts.length === 0 ? <p className="cx-muted">Nenhuma retirada neste dia.</p> : <ul className="cx-list">
                {day.cashOuts.sort((a, b) => a.time.localeCompare(b.time)).map((item) => <li key={item.id}><span className="cx-time">{timeOf(item.time)}</span><span>{item.reason}{item.note ? ` · ${item.note}` : ''}</span><strong>− {money(item.amount)}{item.remove && <button type="button" className="cx-delete" onClick={item.remove}>Excluir</button>}</strong></li>)}
              </ul>}
            </div>
          </details>
        );
      })}
    </div>
  );
}
