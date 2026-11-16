import { useEffect, useState } from 'react';
import { PAYMENT_METHOD_LABELS, type FinancePaymentMethod } from '../types/finance';
import { FOLIO_PAYMENT_METHODS, roomChargePayments, stayAmountDue, stayBillingLines, stayBreakfastDays, stayPayments, type GuestStay, type RoomCharge, type StayRenewal } from '../types/reception';
import { subscribeFrigobar } from '../services/frigobarStore';
import type { FrigobarSale } from '../types/frigobar';
import { existingStayReceipts } from '../services/stayReceipts';
import { saveStayReceipt, saveStayRenewal, type StayRenewalDraft } from '../services/receptionStore';
import { financeDateKeyFromTimestamp } from '../services/financePayments';
import { operationalDateKey } from '../services/cashShiftDate';
import { DateInput } from './ui/DateInput';
import { stayCheckOutDate } from '../services/reservationAnalytics';

const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function StayAccount({ stay, attendant, charges = [], onSaved, canManage = false }: { stay: GuestStay; attendant: string; charges?: RoomCharge[]; onSaved: (message: string) => void; canManage?: boolean }) {
  const [sales, setSales] = useState<FrigobarSale[] | null>(null);
  const [salesError, setSalesError] = useState('');
  useEffect(() => subscribeFrigobar((data) => setSales(Object.values(data.sales).filter((sale) => sale.sourceId ? sale.sourceId === stay.id && sale.sourceType === 'stay' : sale.roomNumber.trim() === stay.roomNumber.trim() && sale.settlement === 'cobrar_no_checkout')), (cause) => setSalesError(cause.message)), [stay.id, stay.roomNumber]);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<FinancePaymentMethod>('pix');
  const [date, setDate] = useState(() => operationalDateKey());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [operationId, setOperationId] = useState(() => `recepcao-${stay.id}-${crypto.randomUUID()}`);
  const [renewalEditor, setRenewalEditor] = useState<StayRenewal | 'new' | null>(null);
  const due = stayAmountDue(stay);
  const paid = stayPayments(stay).reduce((sum, receipt) => sum + Math.round(receipt.amount * 100), 0) / 100;
  const courtesies = stayBillingLines(stay).filter((line) => line.method === 'courtesy');
  const additionalDue = charges.reduce((sum, charge) => sum + Math.max(0, Math.round(charge.amount * 100) - roomChargePayments(charge).reduce((paid, payment) => paid + Math.round(payment.amount * 100), 0)), 0) / 100;
  const minibarDue = (sales ?? []).filter((sale) => sale.settlement === 'cobrar_no_checkout').reduce((sum, sale) => sum + Math.round(sale.amount * 100), 0) / 100;

  async function receive() {
    if (saving) return;
    setSaving(true); setError('');
    try {
      await saveStayReceipt(stay.id, { id: operationId, amount: Number(amount.replace(',', '.')), method, date, attendant });
      window.dispatchEvent(new Event('app:form-saved')); setAmount(''); setOperationId(`recepcao-${stay.id}-${crypto.randomUUID()}`); onSaved('Recebimento registrado na conta da hospedagem.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível receber.'); }
    finally { setSaving(false); }
  }

  return <section data-guard-unsaved className="stay-account" aria-label="Conta da hospedagem">
    <h3>Conta da hospedagem</h3><p>Recebido: <strong>{money(paid)}</strong> · Pendente: <strong>{money(due)}</strong></p>
    {stay.kind === 'hospede' && stay.status === 'hospedado' && <div className="stay-renewal-tools">
      <button type="button" className="stay-account-fill-btn" onClick={() => setRenewalEditor('new')}>Renovar diárias</button>
      {Object.values(stay.renewals ?? {}).length > 0 && <details className="stay-renewal-history">
        <summary>Renovações ({Object.values(stay.renewals ?? {}).length})</summary>
        <ul>{Object.values(stay.renewals ?? {}).sort((a, b) => a.startDate.localeCompare(b.startDate)).map((renewal) => <li key={renewal.id}>
          <span>{renewal.startDate.split('-').reverse().join('/')} a {renewal.endDate.split('-').reverse().join('/')} · {renewal.nights} diária(s) · {money(renewal.dailyAmount + renewal.breakfastAmount)}{renewal.hasBreakfast ? ' com café' : ''}</span>
          {canManage && <button type="button" className="stay-account-text-btn" onClick={() => setRenewalEditor(renewal)}>Editar renovação</button>}
        </li>)}</ul>
      </details>}
    </div>}
    {renewalEditor && <StayRenewalEditor stay={stay} renewal={renewalEditor === 'new' ? undefined : renewalEditor} attendant={attendant} canManage={canManage}
      onCancel={() => setRenewalEditor(null)} onSaved={(message) => { setRenewalEditor(null); onSaved(message); }} />}
    {courtesies.length > 0 && <p>Cortesia: {courtesies.map((line) => line.label).join(' · ')}</p>}
    <p className="stay-account-hint">Hospedagem: {money(due)} · Adicionais: {money(additionalDue)} · Geladeira: {sales === null ? 'consultando…' : money(minibarDue)} em aberto.</p>
    {sales !== null && !salesError && <p>Saldo total para checkout: <strong>{money(due + additionalDue + minibarDue)}</strong></p>}
    {salesError && <p role="alert">Não foi possível conferir a geladeira: {salesError}</p>}
    {(charges.length > 0 || (sales?.length ?? 0) > 0) && <details><summary>Consumos e adicionais do quarto</summary><ul>
      {charges.map((charge) => <li key={charge.id}>{charge.productName ?? charge.guestName} · {money(charge.amount)} · recebido {money(roomChargePayments(charge).reduce((sum, payment) => sum + payment.amount, 0))}</li>)}
      {sales?.map((sale) => <li key={sale.id}>{sale.items.map((item) => `${item.productName} × ${item.quantity}`).join(', ')} · {money(sale.amount)} · {sale.settlement === 'cobrar_no_checkout' ? 'pendente na geladeira' : 'pago'}{!sale.sourceId ? ' · lançamento antigo: conferir vínculo' : ''}</li>)}
    </ul><p className="stay-account-hint">Os consumos da geladeira são recebidos na tela da geladeira. O formulário abaixo recebe apenas o saldo da hospedagem.</p></details>}
    <details><summary>Histórico de recebimentos</summary><ul>{Object.values(existingStayReceipts(stay)).map((receipt) => <li key={receipt.id}>{receipt.date.split('-').reverse().join('/')} · {receipt.label} · {money(receipt.amount)} · {PAYMENT_METHOD_LABELS[receipt.method]} · {receipt.attendant}{stay.voidedPayments?.[receipt.id] ? ' · anulado' : ''}</li>)}</ul></details>
    {due > 0 && <fieldset disabled={saving} className="stay-account-receive">
      <legend>Registrar recebimento</legend>
      <label className="modal-field">
        <span>Valor (R$)</span>
        <input inputMode="decimal" placeholder="0,00" value={amount} onChange={(event) => setAmount(event.target.value)} />
      </label>
      <label className="modal-field">
        <span>Forma</span>
        <select value={method} onChange={(event) => setMethod(event.target.value as FinancePaymentMethod)}>
          {FOLIO_PAYMENT_METHODS.map((method) => <option key={method} value={method}>{PAYMENT_METHOD_LABELS[method]}</option>)}
        </select>
      </label>
      <div className="modal-field stay-account-date-field">
        <span>Data</span>
        <div className="stay-account-date-row">
          <DateInput name="receiptDate" value={date} onValueChange={setDate} max={financeDateKeyFromTimestamp(new Date().toISOString())} />
        </div>
      </div>
      <div className="modal-field stay-account-fill-field">
        <span aria-hidden="true" className="stay-account-ActionSpacer">&nbsp;</span>
        <button type="button" className="stay-account-fill-btn" onClick={() => setAmount(String(due))}>Preencher saldo</button>
      </div>
      <button type="button" className="stay-account-submit-btn" disabled={!attendant || !amount} onClick={() => void receive()}>
        {saving ? 'Registrando…' : 'Confirmar recebimento'}
      </button>
    </fieldset>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

function amountText(value: number) { return value ? String(Math.round(value * 100) / 100).replace('.', ',') : ''; }
function amountValue(value: string) {
  const parsed = Number(value.trim().replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) / 100 : NaN;
}

function StayRenewalEditor({ stay, renewal, attendant, canManage, onCancel, onSaved }: {
  stay: GuestStay; renewal?: StayRenewal; attendant: string; canManage: boolean; onCancel: () => void; onSaved: (message: string) => void;
}) {
  const today = operationalDateKey();
  const guestCount = Math.max(1, stay.guestCount ?? stay.breakfastCount ?? 1);
  const plannedDeparture = stayCheckOutDate(stay);
  const renewalStartDate = plannedDeparture < today ? today : plannedDeparture;
  const [startDate, setStartDate] = useState(() => renewal?.startDate ?? renewalStartDate);
  const [nights, setNights] = useState(() => String(renewal?.nights ?? 1));
  const [dailyAmount, setDailyAmount] = useState(() => amountText(renewal?.dailyAmount ?? stay.dailyRate));
  const [dailyMethod, setDailyMethod] = useState<FinancePaymentMethod>(() => renewal?.dailyMethod ?? stay.dailyMethod);
  const [hasBreakfast, setHasBreakfast] = useState(() => renewal?.hasBreakfast ?? (stay.hasBreakfast && stayBreakfastDays(stay) >= stay.nights));
  const [breakfastDays, setBreakfastDays] = useState(() => String(renewal?.breakfastDays ?? 1));
  const [breakfastCount, setBreakfastCount] = useState(() => String(renewal?.breakfastCount ?? guestCount));
  const defaultBreakfastAmount = (stay.breakfastRate || 0) * guestCount;
  const [breakfastAmount, setBreakfastAmount] = useState(() => amountText(renewal?.breakfastAmount ?? defaultBreakfastAmount));
  const [breakfastMethod, setBreakfastMethod] = useState<FinancePaymentMethod>(() => renewal?.breakfastMethod ?? stay.breakfastMethod ?? stay.dailyMethod);
  const [receiveNow, setReceiveNow] = useState(!renewal);
  const [paymentMethod, setPaymentMethod] = useState<FinancePaymentMethod>(() => renewal?.dailyMethod ?? stay.dailyMethod);
  const [paymentDate, setPaymentDate] = useState(today);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const parsedNights = Number(nights);
  const dailyTotal = amountValue(dailyAmount);
  const coffeeTotal = amountValue(breakfastAmount);
  const parsedBreakfastDays = Number(breakfastDays);
  const parsedBreakfastCount = Number(breakfastCount);
  const isValid = Number.isInteger(parsedNights) && parsedNights >= 1 && parsedNights <= 60
    && Number.isFinite(dailyTotal) && dailyTotal > 0
    && (!hasBreakfast || (Number.isInteger(parsedBreakfastDays) && parsedBreakfastDays >= 1 && parsedBreakfastDays <= parsedNights
      && Number.isInteger(parsedBreakfastCount) && parsedBreakfastCount >= 1 && parsedBreakfastCount <= guestCount
      && Number.isFinite(coffeeTotal) && coffeeTotal >= 0));

  async function save() {
    if (!isValid || saving || !attendant) return;
    setSaving(true); setError('');
    const draft: StayRenewalDraft = {
      ...(renewal ? { id: renewal.id } : {}), startDate, nights: parsedNights, dailyAmount: dailyTotal,
      dailyMethod, hasBreakfast, breakfastDays: hasBreakfast ? parsedBreakfastDays : 0,
      breakfastCount: hasBreakfast ? parsedBreakfastCount : 0, breakfastAmount: hasBreakfast ? coffeeTotal : 0,
      breakfastMethod, attendant,
      ...(!renewal && receiveNow ? { payNow: { date: paymentDate, method: paymentMethod } } : {}),
    };
    try {
      await saveStayRenewal(stay.id, draft, stay);
      window.dispatchEvent(new Event('app:form-saved'));
      onSaved(renewal ? 'Renovação atualizada na hospedagem e no financeiro.' : 'Diárias renovadas. A conta da hospedagem e o financeiro foram atualizados.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível salvar a renovação.');
    } finally { setSaving(false); }
  }

  return <div className="stay-renewal-editor" role="group" aria-label={renewal ? 'Editar renovação da hospedagem' : 'Renovar diária da hospedagem'} onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }}>
    <div className="stay-renewal-editor-heading"><strong>{renewal ? 'Editar renovação' : 'Renovar diárias'}</strong><button type="button" onClick={onCancel} disabled={saving}>Cancelar</button></div>
    <label className="modal-field"><span>Início do novo período</span><DateInput name="renewalStartDate" value={startDate} min={renewal ? undefined : renewalStartDate} onValueChange={setStartDate} required /></label>
    <label className="modal-field"><span>Quantidade de diárias</span><input type="number" min="1" max="60" step="1" value={nights} onChange={(event) => { setNights(event.target.value); if (!renewal) setBreakfastDays(event.target.value); }} required /></label>
    <label className="modal-field"><span>Valor total das diárias (R$)</span><input inputMode="decimal" value={dailyAmount} onChange={(event) => setDailyAmount(event.target.value)} placeholder="0,00" required /></label>
    <label className="modal-field"><span>Forma da diária</span><select value={dailyMethod} onChange={(event) => setDailyMethod(event.target.value as FinancePaymentMethod)}>{FOLIO_PAYMENT_METHODS.map((method) => <option key={method} value={method}>{PAYMENT_METHOD_LABELS[method]}</option>)}</select></label>
    <label className="reception-check"><input type="checkbox" checked={hasBreakfast} onChange={(event) => setHasBreakfast(event.target.checked)} /> Incluir café da manhã</label>
    {hasBreakfast && <>
      <label className="modal-field"><span>Dias com café</span><input type="number" min="1" max={parsedNights || 1} step="1" value={breakfastDays} onChange={(event) => setBreakfastDays(event.target.value)} /></label>
      <label className="modal-field"><span>Quantidade de hóspedes</span><input type="number" min="1" max={guestCount} step="1" value={breakfastCount} onChange={(event) => setBreakfastCount(event.target.value)} /></label>
      <label className="modal-field"><span>Valor total do café (R$)</span><input inputMode="decimal" value={breakfastAmount} onChange={(event) => setBreakfastAmount(event.target.value)} placeholder="0,00" /></label>
      <label className="modal-field"><span>Forma do café</span><select value={breakfastMethod} onChange={(event) => setBreakfastMethod(event.target.value as FinancePaymentMethod)}>{FOLIO_PAYMENT_METHODS.map((method) => <option key={method} value={method}>{PAYMENT_METHOD_LABELS[method]}</option>)}</select></label>
    </>}
    {canManage && renewal && <p className="stay-renewal-manager-note">Gerência: período e valores podem ser ajustados. As entradas relacionadas serão atualizadas e auditadas.</p>}
    {!renewal && <label className="reception-check"><input type="checkbox" checked={receiveNow} onChange={(event) => setReceiveNow(event.target.checked)} /> Receber o valor da renovação agora</label>}
    {!renewal && receiveNow && <>
      <label className="modal-field"><span>Forma do recebimento</span><select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value as FinancePaymentMethod)}>{FOLIO_PAYMENT_METHODS.map((method) => <option key={method} value={method}>{PAYMENT_METHOD_LABELS[method]}</option>)}</select></label>
      <label className="modal-field"><span>Data do recebimento</span><DateInput name="renewalPaymentDate" value={paymentDate} max={today} onValueChange={setPaymentDate} required /></label>
    </>}
    {error && <p className="stay-renewal-error" role="alert">{error}</p>}
    <button type="button" className="stay-account-submit-btn" disabled={saving || !isValid || (receiveNow && !renewal && paymentDate > today)} onClick={() => void save()}>{saving ? 'Salvando…' : renewal ? 'Salvar renovação' : 'Confirmar renovação'}</button>
  </div>;
}
