import { useEffect, useState } from 'react';
import { PAYMENT_METHOD_LABELS, type FinancePaymentMethod } from '../types/finance';
import { roomChargePayments, stayAmountDue, stayPayments, type GuestStay, type RoomCharge } from '../types/reception';
import { subscribeFrigobar } from '../services/frigobarStore';
import type { FrigobarSale } from '../types/frigobar';
import { existingStayReceipts } from '../services/stayReceipts';
import { saveStayReceipt } from '../services/receptionStore';
import { financeDateKeyFromTimestamp } from '../services/financePayments';
import { operationalDateKey } from '../services/cashShiftDate';
import { DateInput } from './ui/DateInput';

const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function StayAccount({ stay, attendant, charges = [], onSaved }: { stay: GuestStay; attendant: string; charges?: RoomCharge[]; onSaved: (message: string) => void }) {
  const [sales, setSales] = useState<FrigobarSale[] | null>(null);
  const [salesError, setSalesError] = useState('');
  useEffect(() => subscribeFrigobar((data) => setSales(Object.values(data.sales).filter((sale) => sale.sourceId ? sale.sourceId === stay.id && sale.sourceType === 'stay' : sale.roomNumber.trim() === stay.roomNumber.trim() && sale.settlement === 'cobrar_no_checkout')), (cause) => setSalesError(cause.message)), [stay.id, stay.roomNumber]);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<FinancePaymentMethod>('pix');
  const [date, setDate] = useState(() => operationalDateKey());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [operationId, setOperationId] = useState(() => `recepcao-${stay.id}-${crypto.randomUUID()}`);
  const due = stayAmountDue(stay);
  const paid = stayPayments(stay).reduce((sum, receipt) => sum + Math.round(receipt.amount * 100), 0) / 100;
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
          {Object.entries(PAYMENT_METHOD_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
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