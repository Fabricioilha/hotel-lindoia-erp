import { useState, type FormEvent } from 'react';
import { WALLET_LABELS, type CardStatement, type FinanceData } from '../../types/finance';
import { cardPurchasePending, cardStatementPending, expenseRegistrationDate, groupCardPurchases, payCardStatement, reopenCardStatement, unassignedCardPurchases, ungroupCardStatement } from '../../services/cardStatements';
import { financeCents } from '../../services/financePayments';
import { formatBRL } from '../../services/money';
import { DateInput } from '../ui/DateInput';

const dateLabel = (date: string) => date.split('-').reverse().join('/');

export function CardStatements({ data, month, today, saving, onCommit }: {
  data: FinanceData;
  month: string;
  today: string;
  saving: boolean;
  onCommit: (update: (current: FinanceData) => FinanceData, message: string) => Promise<boolean>;
}) {
  const [card, setCard] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [paying, setPaying] = useState('');
  const candidates = unassignedCardPurchases(data);
  const cards = [...new Set(candidates.map((expense) => expense.cardCategory!))].sort();
  const purchases = candidates.filter((expense) => expense.cardCategory === card).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const selectedPurchases = purchases.filter((expense) => selected.includes(expense.id));
  const selectedAmount = selectedPurchases.reduce((sum, expense) => sum + financeCents(cardPurchasePending(expense)), 0) / 100;
  const statements = Object.values(data.cardStatements ?? {}).filter((statement) => !statement.payment
    || statement.payment.date.startsWith(month) || statement.dueDate.startsWith(month)).sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  async function group(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || selectedAmount <= 0) return;
    const input = { id: crypto.randomUUID(), cardCategory: card, dueDate, expenseIds: selectedPurchases.map((expense) => expense.id), expectedAmount: selectedAmount };
    const saved = await onCommit((current) => groupCardPurchases(current, input, new Date().toISOString()), 'Fatura criada com o vencimento informado.');
    if (saved) { setSelected([]); setCard(''); setDueDate(''); }
  }

  async function pay(event: FormEvent<HTMLFormElement>, statement: CardStatement, amount: number) {
    event.preventDefault();
    if (saving) return;
    const form = new FormData(event.currentTarget);
    const payment = { amount, date: String(form.get('date')), wallet: form.get('wallet') === 'cash' ? 'cash' as const : 'bank' as const };
    const saved = await onCommit((current) => payCardStatement(current, statement.id, payment, new Date().toISOString()), 'Pagamento da fatura registrado e compras quitadas.');
    if (saved) setPaying('');
  }

  return <>
    <section className="finance-panel">
      <div className="finance-panel-heading"><div><h2>Compras sem fatura</h2><p>Selecione as compras que constam na fatura do cartão e informe o vencimento do extrato.</p></div></div>
      {cards.length === 0 ? <p className="finance-empty-inline">Nenhuma compra com cartão identificado aguardando agrupamento.</p> : <form data-guard-unsaved onSubmit={(event) => void group(event)}>
        <div className="finance-settings-form">
          <label className="finance-field"><span>Cartão</span><select required value={card} onChange={(event) => { setCard(event.target.value); setSelected([]); }}>
            <option value="">Selecione o cartão</option>{cards.map((name) => <option key={name}>{name}</option>)}
          </select></label>
          <label className="finance-field"><span>Vencimento da fatura</span><DateInput name="dueDate" required value={dueDate} onValueChange={setDueDate} /></label>
        </div>
        {purchases.length > 0 && <div className="finance-table-wrap"><table className="finance-table">
          <thead><tr><th><input type="checkbox" aria-label="Selecionar todas as compras" checked={selectedPurchases.length === purchases.length}
            onChange={(event) => setSelected(event.target.checked ? purchases.map((expense) => expense.id) : [])} /></th><th>Data registrada</th><th>Compra</th><th className="numeric">Em aberto</th></tr></thead>
          <tbody>{purchases.map((expense) => <tr key={expense.id}><td><input type="checkbox" aria-label={'Selecionar ' + (expense.note || expense.category)}
            checked={selected.includes(expense.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, expense.id] : current.filter((id) => id !== expense.id))} /></td>
            <td>{dateLabel(expenseRegistrationDate(data, expense))}</td><td>{expense.category}<small>{expense.note}</small></td><td className="numeric">{formatBRL(cardPurchasePending(expense))}</td></tr>)}</tbody>
        </table></div>}
        <div className="finance-heading-actions"><strong>{selectedPurchases.length} compra(s) · {formatBRL(selectedAmount)}</strong>
          <button className="finance-button finance-button-primary" disabled={saving || selectedAmount <= 0}>Criar fatura</button></div>
      </form>}
    </section>
    <section className="finance-panel">
      <div className="finance-panel-heading"><div><h2>Faturas</h2><p>Faturas em aberto e faturas quitadas com vencimento ou pagamento no mês selecionado.</p></div></div>
      {statements.length === 0 && <p className="finance-empty-inline">Nenhuma fatura para exibir.</p>}
      {statements.map((statement) => {
        const amount = statement.payment?.amount ?? cardStatementPending(data, statement);
        return <details key={statement.id} className="finance-panel">
          <summary><strong>{statement.cardCategory} · {formatBRL(amount)}</strong> · vence {dateLabel(statement.dueDate)} · {statement.payment ? 'Quitada' : statement.dueDate < today ? 'Vencida' : 'Em aberto'}</summary>
          <ul>{Object.keys(statement.originalDueDates).map((id) => {
            const expense = data.expenses[id];
            return <li key={id}>{expense ? [dateLabel(expenseRegistrationDate(data, expense)), expense.category, expense.note, formatBRL(expense.plannedAmount)].filter(Boolean).join(' · ') : 'Compra indisponível'}</li>;
          })}</ul>
          {statement.payment ? <div className="finance-heading-actions">
            <span>Pagamento de {formatBRL(amount)} em {dateLabel(statement.payment.date)} · {WALLET_LABELS[statement.payment.wallet]}</span>
            <button type="button" className="finance-button finance-button-soft" disabled={saving} onClick={() => {
              if (window.confirm('Remover este registro de pagamento e reabrir a fatura? As compras vinculadas voltarão a ficar em aberto.')) {
                void onCommit((current) => reopenCardStatement(current, statement, new Date().toISOString()), 'Pagamento corrigido. Fatura reaberta.');
              }
            }}>Reabrir fatura</button>
          </div> : paying === statement.id ? <form data-guard-unsaved className="finance-settings-form" onSubmit={(event) => void pay(event, statement, amount)}>
            <label className="finance-field"><span>Data efetiva do pagamento</span><DateInput name="date" required max={today} defaultValue={statement.dueDate <= today ? statement.dueDate : today} /></label>
            <label className="finance-field"><span>Carteira utilizada</span><select name="wallet"><option value="bank">Banco</option><option value="cash">Caixa físico</option></select></label>
            <button className="finance-button finance-button-primary" disabled={saving || amount <= 0}>Registrar pagamento de {formatBRL(amount)}</button>
            <button type="button" className="finance-button finance-button-soft" disabled={saving} onClick={() => setPaying('')}>Cancelar</button>
          </form> : <div className="finance-heading-actions">
            <button type="button" className="finance-button finance-button-primary" disabled={saving} onClick={() => setPaying(statement.id)}>Registrar pagamento</button>
            <button type="button" className="finance-button finance-button-soft" disabled={saving} onClick={() => {
              if (window.confirm('Desagrupar esta fatura e devolver suas compras à lista sem fatura?')) {
                void onCommit((current) => ungroupCardStatement(current, statement.id, new Date().toISOString()), 'Compras devolvidas à lista sem fatura.');
              }
            }}>Desagrupar</button>
          </div>}
        </details>;
      })}
    </section>
  </>;
}
