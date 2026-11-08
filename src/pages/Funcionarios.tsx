import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { BackToPanel } from '../components/ui/BackToPanel';
import { MoneyInput } from '../components/ui/MoneyInput';
import { subscribeFinance } from '../services/financeStore';
import { formatBRL } from '../services/money';
import { pendingAdvancesByEmployee } from '../services/payrollAdvances';
import { saveStaffMember, updateStaff, useStaff } from '../services/staffStore';
import type { FinanceData } from '../types/finance';
import { staffBaseSalary, type StaffCategory, type StaffChild, type StaffMember } from '../types/staff';
import './financeiro/financeiro.css';
import './funcionarios.css';

type StatusFilter = 'active' | 'inactive' | 'all';

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'active', label: 'Ativos' },
  { value: 'inactive', label: 'Inativos' },
  { value: 'all', label: 'Todos' },
];
const WEEKDAYS = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
const DUTY_LABELS: Record<StaffCategory['duty'], string> = { reception: 'Recepção', housekeeping: 'Limpeza', other: 'Outras funções' };

const searchKey = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toLocaleUpperCase('pt-BR') ?? '').join('');
const currentMonth = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

function defaultDayOff(employeeName: string) {
  const normalized = employeeName.trim().toLocaleLowerCase('pt-BR');
  return normalized === 'juliana' ? '1' : normalized === 'thifani' ? '2' : normalized === 'amanda' ? '3' : '0';
}

function defaultHousekeepingHours(employeeName: string) {
  const normalized = employeeName.trim().toLocaleLowerCase('pt-BR');
  if (normalized === 'thifani') return { start: '06:30', end: '14:30' };
  if (normalized === 'juliana') return { start: '08:00', end: '16:20' };
  if (normalized === 'amanda') return { start: '09:00', end: '17:20' };
  return { start: '08:00', end: '16:00' };
}

function tenure(start: string | undefined) {
  if (!start) return 'Não informado';
  const from = new Date(`${start}T00:00:00`);
  if (!Number.isFinite(from.getTime())) return 'Não informado';
  const now = new Date();
  let years = now.getFullYear() - from.getFullYear();
  let months = now.getMonth() - from.getMonth();
  if (now.getDate() < from.getDate()) months -= 1;
  if (months < 0) { years -= 1; months += 12; }
  return `${years} ano${years === 1 ? '' : 's'} e ${months} mês${months === 1 ? '' : 'es'}`;
}

export function Funcionarios() {
  const { data, error: loadError } = useStaff();
  const [finance, setFinance] = useState<FinanceData | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<StaffMember | null>(null);
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('reception');
  const [active, setActive] = useState(true);
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [workStart, setWorkStart] = useState('08:00');
  const [workEnd, setWorkEnd] = useState('16:00');
  const [weeklyDayOff, setWeeklyDayOff] = useState('0');
  const [startDate, setStartDate] = useState('');
  const [notes, setNotes] = useState('');
  const [baseSalary, setBaseSalary] = useState(0);
  const [children, setChildren] = useState<StaffChild[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const month = currentMonth();
  const isPlantonista = data.categories[categoryId]?.duty === 'reception';
  const needsStartDate = isPlantonista || data.categories[categoryId]?.duty === 'housekeeping';

  // Os vales pendentes são um complemento: se o financeiro não carregar, o cadastro continua funcionando.
  useEffect(() => subscribeFinance(setFinance, () => setFinance(null), { includeOperations: false }), []);

  const members = useMemo(() => Object.values(data.members).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')), [data.members]);
  const pendingAdvances = useMemo(() => finance ? pendingAdvancesByEmployee(finance, members, month) : {}, [finance, members, month]);
  const counts = { active: members.filter((member) => member.active).length, inactive: members.filter((member) => !member.active).length, all: members.length };
  const payrollBase = members.filter((member) => member.active).reduce((sum, member) => sum + Math.round(staffBaseSalary(member) * 100), 0) / 100;
  const term = searchKey(query.trim());
  const visible = members.filter((member) => (statusFilter === 'all' || member.active === (statusFilter === 'active'))
    && (!term || searchKey(member.name).includes(term) || searchKey(data.categories[member.categoryId]?.name ?? '').includes(term)));

  async function run(action: () => Promise<void>) {
    setSaving(true); setError('');
    try { await action(); return true; } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível salvar.'); return false; }
    finally { setSaving(false); }
  }
  function resetForm() { setEditing(null); setName(''); setCategoryId('reception'); setActive(true); setAddress(''); setPhone(''); setWorkStart('08:00'); setWorkEnd('16:00'); setWeeklyDayOff('0'); setStartDate(''); setNotes(''); setBaseSalary(0); setChildren([]); }
  function openNew() { resetForm(); setError(''); setFormOpen(true); }
  function openEdit(member: StaffMember) {
    const housekeeping = data.categories[member.categoryId]?.duty === 'housekeeping';
    const hours = housekeeping ? defaultHousekeepingHours(member.name) : { start: member.workStart ?? '08:00', end: member.workEnd ?? '16:00' };
    setEditing(member); setName(member.name); setCategoryId(member.categoryId); setActive(member.active); setAddress(member.address ?? ''); setPhone(member.phone ?? '');
    setWorkStart(hours.start); setWorkEnd(hours.end); setWeeklyDayOff(String(member.weeklyDayOff ?? (housekeeping ? defaultDayOff(member.name) : 0)));
    setStartDate(member.startDate ?? ''); setNotes(member.notes ?? ''); setBaseSalary(staffBaseSalary(member)); setChildren(member.children ?? []);
    setError(''); setFormOpen(true);
  }
  function closeForm() { if (saving) return; setFormOpen(false); resetForm(); setError(''); }
  function save(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !data.categories[categoryId]) return setError('Informe o nome e uma categoria.');
    if (needsStartDate && !startDate) return setError('Informe a data de início para calcular a escala automática.');
    void run(async () => {
      const validChildren = children.filter((child) => child.name.trim() && child.birthDate);
      await saveStaffMember({ id: editing?.id ?? crypto.randomUUID(), name: name.trim(), categoryId, active, address: address.trim(), phone: phone.trim(), workStart, workEnd, ...(isPlantonista ? {} : { weeklyDayOff: Number(weeklyDayOff) }), startDate, notes: notes.trim(), baseSalary, ...(validChildren.length ? { children: validChildren.map((child) => ({ ...child, name: child.name.trim() })) } : {}) });
    }).then((saved) => { if (saved) { setFormOpen(false); resetForm(); } });
  }
  function toggleActive(member: StaffMember) {
    if (member.active && !window.confirm(`Inativar ${member.name}? Ele deixa de aparecer na escala e nas listas de lançamento; o histórico é preservado.`)) return;
    void run(() => saveStaffMember({ ...member, active: !member.active }));
  }
  function remove(member: StaffMember) {
    if (!window.confirm(`Excluir ${member.name} do cadastro? A escala e os lançamentos históricos serão preservados.`)) return;
    void run(() => updateStaff((current) => {
      const next = { ...current.members }; delete next[member.id];
      return { ...current, members: next };
    }));
  }
  function addCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const label = String(form.get('name') ?? '').trim();
    if (!label) return;
    if (Object.values(data.categories).some((item) => item.name.toLocaleLowerCase('pt-BR') === label.toLocaleLowerCase('pt-BR'))) return setError('Essa categoria já existe.');
    const category: StaffCategory = { id: crypto.randomUUID(), name: label, duty: String(form.get('duty')) as StaffCategory['duty'] };
    void run(() => updateStaff((current) => ({ ...current, categories: { ...current.categories, [category.id]: category } })));
    event.currentTarget.reset();
  }
  const updateChild = (index: number, patch: Partial<StaffChild>) => setChildren((current) => current.map((item, position) => position === index ? { ...item, ...patch } : item));

  return <main className="finance-page staff-page"><div className="finance-content">
    <BackToPanel />
    <div className="staff-heading">
      <div><h1>Funcionários</h1><p>Cadastro utilizado pela escala, recepção, limpeza e folha de pagamento. Funcionários inativos permanecem no histórico.</p></div>
      <button type="button" className="finance-button finance-button-primary" onClick={openNew} disabled={saving}>+ Novo funcionário</button>
    </div>
    {(error || loadError) && !formOpen && <p className="finance-alert" role="alert">{error || loadError}</p>}

    <section className="staff-stats" aria-label="Resumo do quadro">
      <article><span>Ativos</span><strong>{counts.active}</strong></article>
      <article><span>Inativos</span><strong>{counts.inactive}</strong></article>
      <article><span>Salário base mensal dos ativos</span><strong>{formatBRL(payrollBase)}</strong></article>
    </section>

    <section className="finance-panel staff-directory">
      <div className="staff-toolbar">
        <label className="staff-search"><span className="sr-only">Buscar funcionário</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por nome ou função" autoComplete="off" /></label>
        <div className="staff-filter" role="group" aria-label="Filtrar por situação">{STATUS_FILTERS.map((filter) => <button key={filter.value} type="button" className={statusFilter === filter.value ? 'is-selected' : ''} aria-pressed={statusFilter === filter.value} onClick={() => setStatusFilter(filter.value)}>{filter.label} <span>{counts[filter.value]}</span></button>)}</div>
      </div>
      {visible.length === 0 ? <div className="finance-empty"><strong>{members.length === 0 ? 'Nenhum funcionário cadastrado' : 'Nenhum funcionário encontrado'}</strong><p>{members.length === 0 ? 'Cadastre o primeiro funcionário para montar a escala.' : 'Ajuste a busca ou o filtro de situação.'}</p></div> : <ul className="staff-card-grid">{visible.map((member) => {
        const salary = staffBaseSalary(member);
        const pending = pendingAdvances[member.id];
        return <li key={member.id} className={`staff-card${member.active ? '' : ' is-inactive'}`}>
          <div className="staff-card-head">
            <span className="staff-avatar" aria-hidden="true">{initials(member.name)}</span>
            <div className="staff-card-title"><strong>{member.name}</strong><span>{data.categories[member.categoryId]?.name ?? 'Sem categoria'}</span></div>
            <span className={`staff-status ${member.active ? 'is-active' : 'is-inactive'}`}>{member.active ? 'Ativo' : 'Inativo'}</span>
          </div>
          <dl className="staff-card-facts">
            <div><dt>Salário base</dt><dd>{salary > 0 ? formatBRL(salary) : <span className="staff-muted">Não informado</span>}</dd></div>
            <div><dt>Vales pendentes · {month.slice(5)}/{month.slice(0, 4)}</dt><dd>{pending ? <>{formatBRL(pending.total)}<small>{pending.count} vale{pending.count === 1 ? '' : 's'} a compensar na folha</small></> : <span className="staff-muted">Nenhum</span>}</dd></div>
            <div><dt>Início · tempo de casa</dt><dd>{member.startDate ? `${new Date(`${member.startDate}T12:00:00`).toLocaleDateString('pt-BR')} · ${tenure(member.startDate)}` : tenure(member.startDate)}</dd></div>
            <div><dt>Contato</dt><dd>{member.phone || <span className="staff-muted">Telefone não informado</span>}{(member.children?.length ?? 0) > 0 && <small>{member.children!.length} filho(s)</small>}</dd></div>
          </dl>
          <div className="staff-card-actions">
            <button type="button" className="finance-button finance-button-dark" disabled={saving} onClick={() => openEdit(member)}>Editar</button>
            <button type="button" className="finance-button finance-button-soft" disabled={saving} onClick={() => toggleActive(member)}>{member.active ? 'Inativar' : 'Ativar'}</button>
            <button type="button" className="finance-button staff-danger" disabled={saving} onClick={() => remove(member)}>Excluir</button>
          </div>
        </li>;
      })}</ul>}
    </section>

    <section className="finance-panel staff-categories"><div className="finance-panel-heading"><div><h2>Categorias de funcionários</h2><p>Definem a função exibida e como cada pessoa é usada na escala e na limpeza.</p></div></div>
      <form onSubmit={addCategory} className="staff-category-form"><label className="finance-field"><span>Nome da categoria</span><input name="name" required maxLength={80} /></label><label className="finance-field"><span>Utilização</span><select name="duty"><option value="other">Outras funções</option><option value="reception">Plantonistas da recepção</option><option value="housekeeping">Limpeza de quartos</option></select></label><button className="finance-button finance-button-dark" disabled={saving}>Adicionar categoria</button></form>
      <ul className="staff-category-list">{Object.values(data.categories).map((category) => <li key={category.id}>
        <div><strong>{category.name}</strong><small>{DUTY_LABELS[category.duty]} · {members.filter((member) => member.categoryId === category.id).length} funcionário(s)</small></div>
        <div className="staff-category-actions"><button type="button" className="finance-button finance-button-soft" disabled={saving} onClick={() => {
          const next = window.prompt('Nome da categoria', category.name)?.trim();
          if (next) void run(() => updateStaff((current) => ({ ...current, categories: { ...current.categories, [category.id]: { ...category, name: next } } })));
        }}>Renomear</button><button type="button" className="finance-button staff-danger" disabled={saving} onClick={() => {
          if (!window.confirm(`Excluir a categoria ${category.name}? Seus funcionários serão movidos para “Sem categoria”.`)) return;
          void run(() => updateStaff((current) => {
            const categories = { ...current.categories }; delete categories[category.id];
            const fallback = category.id === 'uncategorized' ? 'unclassified' : 'uncategorized';
            if (Object.values(current.members).some((member) => member.categoryId === category.id)) categories[fallback] = { id: fallback, name: 'Sem categoria', duty: 'other' };
            const next = Object.fromEntries(Object.entries(current.members).map(([id, member]) => [id, member.categoryId === category.id ? { ...member, categoryId: fallback } : member]));
            return { ...current, categories, members: next };
          }));
        }}>Excluir</button></div>
      </li>)}</ul>
    </section>

    {formOpen && <div className="finance-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeForm(); }}><section className="finance-modal staff-modal" role="dialog" aria-modal="true" aria-labelledby="staff-modal-title"><form data-guard-unsaved onSubmit={save}>
      <div className="finance-modal-header"><div><p className="finance-eyebrow">FUNCIONÁRIOS</p><h2 id="staff-modal-title">{editing ? 'Editar funcionário' : 'Novo funcionário'}</h2></div><button type="button" className="finance-close" onClick={closeForm} aria-label="Fechar" disabled={saving}>×</button></div>
      {(error || loadError) && <p className="finance-alert" role="alert">{error || loadError}</p>}
      <fieldset className="finance-modal-body" disabled={saving}>
        <label className="finance-field"><span>Nome *</span><input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label className="finance-field"><span>Categoria *</span><select required value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="">Selecione...</option>{Object.values(data.categories).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="finance-field"><span>Salário Base (R$)</span><MoneyInput value={baseSalary} onValueChange={setBaseSalary} /><small className="modal-form-hint">Salário mensal de referência, exibido ao lançar a folha de pagamento.</small></label>
        <label className="finance-field"><span>Telefone</span><input maxLength={30} value={phone} onChange={(event) => setPhone(event.target.value)} /></label>
        <label className="finance-field finance-field-wide"><span>Endereço</span><input maxLength={160} value={address} onChange={(event) => setAddress(event.target.value)} /></label>
        <label className="finance-field"><span>Início na empresa{needsStartDate ? ' *' : ''}</span><input type="date" required={needsStartDate} value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
        {isPlantonista ? <p className="modal-form-hint staff-schedule-hint">Plantonista: escala automática em dias alternados, sem folga semanal.</p> : <label className="finance-field"><span>Folga semanal</span><select value={weeklyDayOff} onChange={(event) => setWeeklyDayOff(event.target.value)}>{WEEKDAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label>}
        <label className="finance-field"><span>Entrada habitual</span><input type="time" value={workStart} onChange={(event) => setWorkStart(event.target.value)} /></label>
        <label className="finance-field"><span>Saída habitual</span><input type="time" value={workEnd} onChange={(event) => setWorkEnd(event.target.value)} /></label>
        {data.categories[categoryId]?.duty === 'housekeeping' && <p className="modal-form-hint finance-field-wide">Camareiras: 06:30–14:30 nos dias úteis e 06:30–15:30 aos sábados e domingos. Escolha o domingo de folga na própria escala.</p>}
        <label className="finance-field finance-field-wide"><span>Observações</span><input maxLength={240} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
        <fieldset className="finance-field-wide staff-children"><legend>Filhos</legend>{children.map((child, index) => <div key={index} className="staff-child-row"><input aria-label={`Nome do filho ${index + 1}`} placeholder="Nome" value={child.name} onChange={(event) => updateChild(index, { name: event.target.value })} /><input aria-label={`Nascimento do filho ${index + 1}`} type="date" value={child.birthDate} onChange={(event) => updateChild(index, { birthDate: event.target.value })} /><button type="button" className="finance-button finance-button-soft" onClick={() => setChildren((current) => current.filter((_, position) => position !== index))}>Remover</button></div>)}<button type="button" className="finance-button finance-button-soft staff-add-child" onClick={() => setChildren((current) => [...current, { name: '', birthDate: '' }])}>+ Adicionar filho</button></fieldset>
        <label className="modal-check-row finance-field-wide"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /><span><strong>Funcionário ativo</strong><small>Inativos saem da escala e das listas de lançamento, mas permanecem no histórico.</small></span></label>
      </fieldset>
      <div className="finance-modal-footer"><button type="button" className="finance-button finance-button-soft" onClick={closeForm} disabled={saving}>Cancelar</button><button type="submit" className="finance-button finance-button-primary" disabled={saving}>{saving ? 'Salvando...' : editing ? 'Salvar alterações' : 'Cadastrar funcionário'}</button></div>
    </form></section></div>}
  </div></main>;
}
