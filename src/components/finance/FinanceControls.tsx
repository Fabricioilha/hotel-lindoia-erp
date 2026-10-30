import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { type FinanceData, type FinanceExpense } from '../../types/finance';
import { outstandingAccounts } from '../../services/outstandingAccounts';

const money = (value: number) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export function CardFeeSettings({ data, saving, onSave }: { data: FinanceData; saving: boolean; onSave: (credit: number, debit: number) => void }) {
  const current = Object.values(data.cardFeeSchedule ?? {}).sort((a, b) => b.effectiveAt.localeCompare(a.effectiveAt))[0];
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    onSave(Number(form.get('credit')), Number(form.get('debit')));
  }
  return <section className="finance-panel"><div className="finance-panel-heading"><div><h2>Taxas da máquina de cartão</h2><p>O banco recebe o efeito líquido. A taxa aparece separadamente como despesa.</p></div></div>
    <form key={current?.effectiveAt ?? 'initial'} className="finance-settings-form" onSubmit={submit}>
      <label className="finance-field"><span>Crédito (%)</span><input name="credit" type="number" min="0" max="99.99" step="0.01" required defaultValue={current?.credit ?? 0} /></label>
      <label className="finance-field"><span>Débito (%)</span><input name="debit" type="number" min="0" max="99.99" step="0.01" required defaultValue={current?.debit ?? 0} /></label>
      <button className="finance-button finance-button-dark" disabled={saving}>Salvar taxas para novos recebimentos</button>
    </form><p className="finance-form-hint">Cada configuração vale a partir do momento em que é salva. Recebimentos anteriores conservam a taxa vigente quando foram registrados; registros anteriores à primeira configuração permanecem sem taxa automática.</p>
    {current && <small>Vigência atual: {new Date(current.effectiveAt).toLocaleString('pt-BR')}</small>}
  </section>;
}

export function OutstandingAccounts({ data, asOf, onEdit }: { data: FinanceData; asOf: string; onEdit: (entry: FinanceExpense) => void }) {
  const [scope, setScope] = useState('all');
  const [search, setSearch] = useState('');
  const rows = outstandingAccounts(data, asOf);
  const visible = rows.filter((entry) => (scope === 'all' || (scope === 'overdue' ? entry.dueDate < asOf : entry.dueDate >= asOf)) && `${entry.title} ${entry.detail}`.toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR')));
  return <section className="finance-panel"><div className="finance-panel-heading"><div><h2>Contas a pagar</h2><p>Saldo dos pagamentos registrados até {asOf.split('-').reverse().join('/')} · inclui dívidas de meses anteriores e vencimentos futuros.</p></div></div>
    <div className="finance-settings-form"><label className="finance-field"><span>Situação</span><select value={scope} onChange={(event) => setScope(event.target.value)}><option value="all">Todas em aberto</option><option value="overdue">Vencidas</option><option value="upcoming">Hoje e a vencer</option></select></label><label className="finance-field"><span>Buscar conta</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Categoria, funcionário ou observação" /></label></div>
    <div className="finance-table-wrap"><table className="finance-table"><thead><tr><th>Vencimento</th><th>Conta</th><th>Situação</th><th className="numeric">Em aberto</th><th>Ação</th></tr></thead><tbody>{visible.map((entry) => <tr key={`${entry.expense ? 'expense' : 'payroll'}-${entry.id}`}><td>{entry.dueDate.split('-').reverse().join('/')}</td><td>{entry.title}<small>{entry.detail}</small></td><td>{entry.dueDate < asOf ? 'Vencida' : entry.dueDate === asOf ? 'Vence nesta data' : 'A vencer'}</td><td className="numeric">{money(entry.pending)}</td><td>{entry.expense ? <button type="button" className="finance-button finance-button-soft" onClick={() => onEdit(entry.expense!)}>Registrar pagamento</button> : <Link to="/financeiro/folha">Abrir folha</Link>}</td></tr>)}</tbody></table></div>
    {!visible.length && <p className="finance-empty">Nenhuma conta em aberto para este filtro.</p>}
  </section>;
}
