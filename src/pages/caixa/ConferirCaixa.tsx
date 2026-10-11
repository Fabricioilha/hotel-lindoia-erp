import { useStaff } from '../../services/staffStore';
import { findStaff, staffMembers } from '../../types/staff';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { UserRole } from '../../types';
import { PAYMENT_METHOD_LABELS, type FinancePaymentMethod } from '../../types/finance';
import type { MinibarPaymentMethod } from '../../types/inventory';
import { FLOAT_AMOUNT, roomChargePayments, stayPayments, stayTotals, type ReceptionData } from '../../types/reception';
import type { FrigobarData } from '../../types/frigobar';
import { deleteFrigobarSale, emptyFrigobar, subscribeFrigobar } from '../../services/frigobarStore';
import { deleteCashOut, deleteStay, deleteRoomCharge, deleteFloatCheck, emptyReception, localDateKey, subscribeReception } from '../../services/receptionStore';
import { currentDuty } from '../../services/dutyRoster';
import { emptySchedule, subscribeSchedule, type ScheduleStoreData } from '../../services/scheduleStore';
import { BackToPanel } from '../../components/ui/BackToPanel';
import { useAttendant, useDuty } from '../../services/useAttendant';
import { effectiveDuty, nextScheduledDuty } from '../../services/dutyRoster';
import { deleteShiftHandoff, saveShiftHandoff, subscribeShiftHandoffs } from '../../services/shiftHandoffStore';
import type { ShiftHandoff } from '../../types/reception';
import './caixa.css';

const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dateLabel = (key: string) => new Date(`${key}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
const FRIGOBAR_METHODS: Record<MinibarPaymentMethod, FinancePaymentMethod> = { dinheiro: 'cash', pix: 'pix', cartao_debito: 'debit', cartao_credito: 'credit' };
const parseMoney = (value: string) => {
  const trimmed = value.trim();
  return Number(trimmed.includes(',') ? trimmed.replace(/\./g, '').replace(',', '.') : trimmed);
};

interface Entry { time: string; kind: 'stay' | 'sale' | 'room-charge'; remove?: () => void; title: string; detail: string; total: number; payments: { method: FinancePaymentMethod; amount: number }[] }
interface Day { date: string; entries: Entry[]; cashOuts: { id: string; time: string; reason: string; note: string; amount: number; remove?: () => void }[] }

export function ConferirCaixa({ userRole }: { userRole: UserRole }) {
  const { data: staff } = useStaff();
  const isAdmin = userRole === 'admin';
  const [data, setData] = useState<ReceptionData>(emptyReception());
  const [frigobar, setFrigobar] = useState<FrigobarData>(emptyFrigobar());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const sessionAttendant = useAttendant();
  const dutyState = useDuty();
  const [chosen, setChosen] = useState('');
  const [handoffs, setHandoffs] = useState<Record<string, ShiftHandoff>>({});
  const [endingTurn, setEndingTurn] = useState(false);
  const [cashLeft, setCashLeft] = useState(String(FLOAT_AMOUNT));
  const [handoffJustification, setHandoffJustification] = useState('');
  const [savingHandoff, setSavingHandoff] = useState(false);

  function removeRecord(message: string, action: () => Promise<void>) {
    if (!window.confirm(message)) return;
    setError('');
    void action().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Não foi possível excluir o registro.'));
  }

  useEffect(() => subscribeReception(setData, (cause) => setError(cause.message)), []);
  const [schedule, setSchedule] = useState<ScheduleStoreData>(emptySchedule());
  useEffect(() => subscribeSchedule(setSchedule, () => undefined), []);
  useEffect(() => subscribeFrigobar(setFrigobar, () => setFrigobar(emptyFrigobar())), []);
  useEffect(() => subscribeShiftHandoffs(setHandoffs, (cause) => setError(cause.message)), []);

  const receptionNames = staffMembers(staff, 'reception').map((member) => member.name);
  const names = [...new Set([...receptionNames, ...Object.values(data.stays).map((item) => findStaff(staff, item.attendant, item.employeeId)?.name ?? item.attendant), ...Object.values(data.cashOuts).map((item) => findStaff(staff, item.attendant, item.employeeId)?.name ?? item.attendant), ...Object.values(data.roomCharges).map((item) => findStaff(staff, item.attendant, item.employeeId)?.name ?? item.attendant), ...Object.values(frigobar.sales).map((item) => findStaff(staff, item.settledBy ?? item.actor)?.name ?? item.settledBy ?? item.actor)])].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const attendant = isAdmin ? chosen || names[0] : sessionAttendant;
  const nextDuty = !isAdmin && dutyState.duty ? nextScheduledDuty(schedule.days, receptionNames, new Date(), attendant) : null;

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
    const effective = effectiveDuty(schedule.days, names, at, handoffs);
    return localDateKey(effective?.start ?? duty?.start ?? at);
  };

  Object.values(data.stays).filter((stay) => (findStaff(staff, stay.attendant, stay.employeeId)?.name ?? stay.attendant) === attendant).forEach((stay) => {
    dayOf(shiftDay(stay.createdAt)).entries.push({
      time: stay.createdAt,
      kind: 'stay',
      remove: isAdmin ? () => removeRecord(`Excluir o lançamento do quarto ${stay.roomNumber}? As diárias convertidas, adicionais e receitas relacionadas também serão removidos.`, () => deleteStay(stay)) : undefined,
      title: `${stay.kind === 'periodo' ? 'Rotativo' : 'Hóspede'} · Quarto ${stay.roomNumber}`,
      detail: stay.kind === 'periodo' ? `${stay.hours ?? 4} hora(s)` : stay.guestName,
      total: stayTotals(stay).total,
      payments: stayPayments(stay),
    });
  });
  Object.values(data.roomCharges).filter((charge) => (findStaff(staff, charge.attendant, charge.employeeId)?.name ?? charge.attendant) === attendant).forEach((charge) => {
    dayOf(shiftDay(charge.createdAt)).entries.push({
      time: charge.createdAt,
      kind: 'room-charge',
      remove: isAdmin ? () => removeRecord('Excluir este adicional do quarto? O financeiro será recalculado e bebidas serão devolvidas ao estoque.', () => deleteRoomCharge(charge)) : undefined,
      title: `${charge.kind === 'cafe_avulso' ? 'Café da manhã' : charge.kind === 'cama_extra' ? 'Cama extra' : charge.kind === 'bebida' ? (charge.productName ?? 'Bebida') : 'Hóspede extra'} · Quarto ${charge.roomNumber}`,
      detail: charge.kind === 'bebida'
        ? `${charge.guestName} · ${charge.quantity ?? 1} unidade(s) em ${charge.days ?? 1} dia(s)`
        : `${charge.guestName} · ${charge.days ?? 1} dia(s)`,
      total: roomChargePayments(charge).reduce((sum, payment) => sum + payment.amount, 0),
      payments: roomChargePayments(charge),
    });
  });
  Object.values(frigobar.sales).filter((sale) => (isAdmin || (sale.settlement !== 'cobrar_no_checkout' && sale.paymentMethod)) && (findStaff(staff, sale.settledBy ?? sale.actor)?.name ?? sale.settledBy ?? sale.actor) === attendant).forEach((sale) => {
    const when = sale.settledAt ?? sale.createdAt;
    dayOf(shiftDay(when)).entries.push({
      time: when,
      kind: 'sale',
      remove: isAdmin ? () => removeRecord(`Excluir esta venda da geladeira (${money(sale.amount)})? Os itens voltam ao saldo da geladeira e a receita no Financeiro também será removida.`, () => deleteFrigobarSale(sale)) : undefined,
      title: sale.settlement === 'cobrar_no_checkout' ? 'Geladeira · a cobrar no checkout' : 'Venda da geladeira',
      detail: sale.items.map((item) => `${item.quantity}× ${item.productName}`).join(', ') + (sale.settlement === 'cobrar_no_checkout' ? ` · pendente ${money(sale.amount)}` : ''),
      total: sale.settlement === 'cobrar_no_checkout' ? 0 : sale.amount,
      payments: sale.settlement === 'cobrar_no_checkout' ? [] : [{ method: FRIGOBAR_METHODS[sale.paymentMethod as MinibarPaymentMethod], amount: sale.amount }],
    });
  });
  Object.values(data.cashOuts).filter((item) => (findStaff(staff, item.attendant, item.employeeId)?.name ?? item.attendant) === attendant).forEach((item) => {
    dayOf(shiftDay(item.createdAt)).cashOuts.push({ id: item.id, time: item.createdAt, reason: item.reason, note: item.note, amount: item.amount, remove: isAdmin ? () => removeRecord(`Excluir a saída de caixa de ${money(item.amount)} (${item.reason})? A despesa no Financeiro também será removida.`, () => deleteCashOut(item.id)) : undefined });
  });
  const currentKey = shiftDay(new Date().toISOString());
  dayOf(currentKey);
  const currentDay = days.get(currentKey);
  const currentCheck = Object.values(data.floatChecks).find((item) => (findStaff(staff, item.attendant, item.employeeId)?.name ?? item.attendant) === attendant && shiftDay(item.createdAt) === currentKey);
  const expectedOpening = currentCheck?.counted ?? FLOAT_AMOUNT;
  const currentCashIn = currentDay?.entries.reduce((sum, entry) => sum + entry.payments.filter((payment) => payment.method === 'cash').reduce((subtotal, payment) => subtotal + payment.amount, 0), 0) ?? 0;
  const currentCashOut = currentDay?.cashOuts.reduce((sum, item) => sum + item.amount, 0) ?? 0;
  const expectedCashAtClose = expectedOpening + currentCashIn - currentCashOut;
  const ordered = [...days.values()].filter((day) => isAdmin || day.date === currentKey).sort((a, b) => b.date.localeCompare(a.date));

  async function submitHandoff(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dutyState.duty || !nextDuty) {
      setError('Não foi possível localizar o próximo plantonista na escala.');
      return;
    }
    const counted = parseMoney(cashLeft);
    if (!Number.isFinite(counted) || counted < 0) {
      setError('Informe um valor válido para o dinheiro deixado no caixa.');
      return;
    }
    if (counted !== FLOAT_AMOUNT && !handoffJustification.trim()) {
      setError('Informe uma justificativa quando o troco deixado for diferente de R$ 300,00.');
      return;
    }
    setSavingHandoff(true);
    setError('');
    try {
      const handoff: ShiftHandoff = {
        id: crypto.randomUUID(),
        fromAttendant: attendant,
        toAttendant: nextDuty.name,
        expectedCash: Math.max(0, Math.round(expectedCashAtClose * 100) / 100),
        cashLeft: Math.round(counted * 100) / 100,
        justification: handoffJustification.trim(),
        createdAt: new Date().toISOString(),
        endsAt: nextDuty.end.toISOString(),
      };
      await saveShiftHandoff(handoff);
      setEndingTurn(false);
      setNotice(`Turno encerrado. ${nextDuty.name} pode assumir agora.`);
      setCashLeft(String(FLOAT_AMOUNT));
      setHandoffJustification('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível encerrar o turno.');
    } finally {
      setSavingHandoff(false);
    }
  }

  return (
    <div className="cx-page">
      <BackToPanel />
      <header className="cx-title">
        <p className="cx-eyebrow">PLANTÃO <span>/</span> CAIXA</p>
        <h1>Conferir caixa</h1>
        <p>{isAdmin ? 'Resumo de tudo que o plantonista lançou em cada dia: entradas por forma de pagamento, retiradas e dinheiro que deve estar no caixa.' : 'Resumo do seu plantão de hoje: entradas por forma de pagamento, retiradas e dinheiro que deve estar no caixa.'}</p>
      </header>
      {error && <div className="cx-alert" role="alert">{error}</div>}
      {notice && <div className="cx-success" role="status">{notice}</div>}

      <div className="cx-panel cx-who-row">
        {isAdmin ? <label className="cx-field">Plantonista
          <select value={attendant} onChange={(event) => setChosen(event.target.value)}>{names.map((name) => <option key={name} value={name}>{name}</option>)}</select>
        </label> : <p className="cx-who">Plantonista: <strong>{attendant}</strong></p>}
      </div>

      {!isAdmin && <div className="cx-handoff-panel">
        <div><strong>Próximo plantonista</strong><span>{nextDuty?.name ?? 'Não encontrado na escala dos próximos 60 dias'}</span></div>
        <button type="button" className="cx-primary" disabled={!dutyState.duty || !nextDuty} onClick={() => { setCashLeft(String(FLOAT_AMOUNT)); setHandoffJustification(''); setError(''); setEndingTurn(true); }}>Encerrar turno</button>
      </div>}

      {ordered.map((day, index) => {
        const byMethod = new Map<FinancePaymentMethod, number>();
        day.entries.forEach((entry) => entry.payments.forEach((payment) => byMethod.set(payment.method, (byMethod.get(payment.method) ?? 0) + payment.amount)));
        const income = [...byMethod.entries()].filter(([method]) => method !== 'prepaid').reduce((sum, [, amount]) => sum + amount, 0);
        const prepaid = byMethod.get('prepaid') ?? 0;
        const outs = day.cashOuts.reduce((sum, item) => sum + item.amount, 0);
        const cashIn = byMethod.get('cash') ?? 0;
        const check = Object.values(data.floatChecks).find((item) => (findStaff(staff, item.attendant, item.employeeId)?.name ?? item.attendant) === attendant && shiftDay(item.createdAt) === day.date);
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
                {isAdmin && check && <button onClick={() => removeRecord('Excluir esta conferência de troco? O caixa será recalculado a partir do troco padrão.', () => deleteFloatCheck(check.id))}>Excluir conferência</button>}
              </p>

              <h3>Recebimentos no hotel por forma de pagamento</h3>
              {prepaid > 0 && <p className="cx-muted">Pré-pagos recebidos pela OYO: <strong>{money(prepaid)}</strong> · fora das entradas do hotel.</p>}
              {[...byMethod.keys()].filter((method) => method !== 'prepaid').length === 0 ? <p className="cx-muted">Nenhuma entrada neste dia.</p> : <ul className="cx-methods">
                {[...byMethod.entries()].filter(([method]) => method !== 'prepaid').map(([method, value]) => <li key={method}><span>{PAYMENT_METHOD_LABELS[method]}</span><strong>{money(value)}</strong></li>)}
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

      {isAdmin && <section className="cx-panel"><h2>Passagens de turno</h2>{Object.values(handoffs).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((item) => <p key={item.id}>{new Date(item.createdAt).toLocaleString('pt-BR')} · {item.fromAttendant} → {item.toAttendant} · {money(item.cashLeft)} <button onClick={() => removeRecord('Excluir esta passagem de turno? A escala volta a definir o plantonista nesse período.', () => deleteShiftHandoff(item.id))}>Excluir</button></p>)}</section>}

      {endingTurn && nextDuty && <div className="cx-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !savingHandoff) setEndingTurn(false); }}>
        <form className="cx-handoff-modal" role="dialog" aria-modal="true" aria-labelledby="cx-handoff-title" onSubmit={(event) => void submitHandoff(event)}>
          <div><p className="cx-eyebrow">PASSAGEM DE PLANTÃO</p><h2 id="cx-handoff-title">Encerrar turno</h2><p>O próximo plantonista será <strong>{nextDuty.name}</strong>. Após confirmar, o sistema libera a conferência de entrada para ele.</p></div>
          <div className="cx-handoff-balance"><span>Dinheiro esperado no caixa agora</span><strong>{money(expectedCashAtClose)}</strong><small>Considere o valor físico que ficará para o próximo turno; o padrão de troco é R$ 300,00.</small></div>
          <label className="cx-field">Dinheiro deixado no caixa (R$)<input inputMode="decimal" value={cashLeft} onChange={(event) => setCashLeft(event.target.value)} required autoFocus /></label>
          {parseMoney(cashLeft) !== FLOAT_AMOUNT && <label className="cx-field">Justificativa da diferença<textarea rows={3} value={handoffJustification} onChange={(event) => setHandoffJustification(event.target.value)} maxLength={300} required /></label>}
          <footer><button type="button" className="cx-secondary" disabled={savingHandoff} onClick={() => setEndingTurn(false)}>Continuar no turno</button><button type="submit" className="cx-primary" disabled={savingHandoff}>{savingHandoff ? 'Encerrando…' : 'Confirmar encerramento'}</button></footer>
        </form>
      </div>}
    </div>
  );
}
