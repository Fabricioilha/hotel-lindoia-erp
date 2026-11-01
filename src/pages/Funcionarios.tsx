import { useState, type FormEvent } from 'react';
import { BackToPanel } from '../components/ui/BackToPanel';
import { saveStaffMember, updateStaff, useStaff } from '../services/staffStore';
import type { StaffCategory, StaffChild, StaffMember } from '../types/staff';
import './financeiro/financeiro.css';
import './funcionarios.css';

export function Funcionarios() {
  const { data, error: loadError } = useStaff();
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
  const [children, setChildren] = useState<StaffChild[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const isPlantonista = data.categories[categoryId]?.duty === 'reception';
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
  async function run(action: () => Promise<void>) {
    setSaving(true); setError('');
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível salvar.'); }
    finally { setSaving(false); }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !data.categories[categoryId]) return setError('Informe o nome e uma categoria.');
    if ((isPlantonista || data.categories[categoryId]?.duty === 'housekeeping') && !startDate) return setError('Informe a data de início para calcular a escala automática.');
    void run(async () => {
      const validChildren = children.filter((child) => child.name.trim() && child.birthDate);
      await saveStaffMember({ id: editing?.id ?? crypto.randomUUID(), name: name.trim(), categoryId, active, address: address.trim(), phone: phone.trim(), workStart, workEnd, ...(isPlantonista ? {} : { weeklyDayOff: Number(weeklyDayOff) }), startDate, notes: notes.trim(), ...(validChildren.length ? { children: validChildren.map((child) => ({ ...child, name: child.name.trim() })) } : {}) });
      resetForm();
    });
  }
  function resetForm() { setEditing(null); setName(''); setCategoryId('reception'); setActive(true); setAddress(''); setPhone(''); setWorkStart('08:00'); setWorkEnd('16:00'); setWeeklyDayOff('0'); setStartDate(''); setNotes(''); setChildren([]); }
  function edit(member: StaffMember) { const hours = data.categories[member.categoryId]?.duty === 'housekeeping' ? defaultHousekeepingHours(member.name) : { start: member.workStart ?? '08:00', end: member.workEnd ?? '16:00' }; setEditing(member); setName(member.name); setCategoryId(member.categoryId); setActive(member.active); setAddress(member.address ?? ''); setPhone(member.phone ?? ''); setWorkStart(hours.start); setWorkEnd(hours.end); setWeeklyDayOff(String(member.weeklyDayOff ?? (data.categories[member.categoryId]?.duty === 'housekeeping' ? defaultDayOff(member.name) : 0))); setStartDate(member.startDate ?? ''); setNotes(member.notes ?? ''); setChildren(member.children ?? []); }
  function remove(member: StaffMember) {
    if (!window.confirm(`Excluir ${member.name} do cadastro? A escala e os lançamentos históricos serão preservados.`)) return;
    void run(() => updateStaff((current) => {
      const members = { ...current.members }; delete members[member.id];
      return { ...current, members };
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
  return <main className="finance-page staff-page"><div className="finance-content">
    <BackToPanel /><h1>Funcionários</h1>
    <p>Cadastro utilizado pela escala, recepção e limpeza. Funcionários inativos permanecem no histórico.</p>
    {(error || loadError) && <p role="alert">{error || loadError}</p>}
    <section className="finance-panel"><h2>{editing ? 'Editar funcionário' : 'Adicionar funcionário'}</h2>
      <form onSubmit={save} className="finance-form">
        <label>Nome<input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>Telefone<input maxLength={30} value={phone} onChange={(event) => setPhone(event.target.value)} /></label>
        <label>Endereço<input maxLength={160} value={address} onChange={(event) => setAddress(event.target.value)} /></label>
        <label>Categoria<select required value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="">Selecione...</option>{Object.values(data.categories).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Início na empresa{isPlantonista || data.categories[categoryId]?.duty === 'housekeeping' ? ' *' : ''}<input type="date" required={isPlantonista || data.categories[categoryId]?.duty === 'housekeeping'} value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
        <label>Entrada habitual<input type="time" value={workStart} onChange={(event) => setWorkStart(event.target.value)} /></label>
        <label>Saída habitual<input type="time" value={workEnd} onChange={(event) => setWorkEnd(event.target.value)} /></label>
        {isPlantonista ? <p className="staff-schedule-hint">Plantonista: escala automática em dias alternados, sem folga semanal.</p> : <label>Folga semanal<select value={weeklyDayOff} onChange={(event) => setWeeklyDayOff(event.target.value)}>{['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'].map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label>}
        {data.categories[categoryId]?.duty === 'housekeeping' && <p className="staff-schedule-hint">Camareiras: 06:30–14:30 nos dias úteis e 06:30–15:30 aos sábados e domingos. Escolha o domingo de folga na própria escala.</p>}
        <label className="staff-wide">Observações<input maxLength={240} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
        <fieldset className="staff-wide"><legend>Filhos</legend>{children.map((child, index) => <div key={index}><input aria-label={`Nome do filho ${index + 1}`} placeholder="Nome" value={child.name} onChange={(event) => setChildren((current) => current.map((item, position) => position === index ? { ...item, name: event.target.value } : item))} /><input aria-label={`Nascimento do filho ${index + 1}`} type="date" value={child.birthDate} onChange={(event) => setChildren((current) => current.map((item, position) => position === index ? { ...item, birthDate: event.target.value } : item))} /><button type="button" onClick={() => setChildren((current) => current.filter((_, position) => position !== index))}>Remover</button></div>)}<button type="button" onClick={() => setChildren((current) => [...current, { name: '', birthDate: '' }])}>Adicionar filho</button></fieldset>
        <label><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /> Ativo</label>
        <button type="submit" disabled={saving}>Salvar</button>
        {editing && <button type="button" onClick={resetForm}>Cancelar</button>}
      </form>
      <div style={{ overflowX: 'auto' }}><table className="finance-table"><thead><tr><th>Nome</th><th>Categoria</th><th>Início / tempo de casa</th><th>Situação</th><th>Ações</th></tr></thead>
        <tbody>{Object.values(data.members).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')).map((member) => <tr key={member.id}><td>{member.name}<small>{member.phone || 'Telefone não informado'} · {member.children?.length ?? 0} filho(s)</small></td><td>{data.categories[member.categoryId]?.name ?? 'Sem categoria'}</td><td>{member.startDate ? `${new Date(`${member.startDate}T12:00:00`).toLocaleDateString('pt-BR')} · ${tenure(member.startDate)}` : tenure(member.startDate)}</td><td>{member.active ? 'Ativo' : 'Inativo'}</td><td><button disabled={saving} onClick={() => edit(member)}>Editar</button> <button disabled={saving} onClick={() => remove(member)}>Excluir</button></td></tr>)}</tbody></table></div>
    </section>
    <section className="finance-panel"><h2>Categorias de funcionários</h2>
      <form onSubmit={addCategory} className="finance-form"><label>Nome<input name="name" required maxLength={80} /></label><label>Utilização<select name="duty"><option value="other">Outras funções</option><option value="reception">Plantonistas da recepção</option><option value="housekeeping">Limpeza de quartos</option></select></label><button disabled={saving}>Adicionar categoria</button></form>
      {Object.values(data.categories).map((category) => <p key={category.id}>{category.name} · {category.duty === 'reception' ? 'Recepção' : category.duty === 'housekeeping' ? 'Limpeza' : 'Outras funções'} <button disabled={saving} onClick={() => {
        const next = window.prompt('Nome da categoria', category.name)?.trim();
        if (next) void run(() => updateStaff((current) => ({ ...current, categories: { ...current.categories, [category.id]: { ...category, name: next } } })));
      }}>Renomear</button> <button disabled={saving} onClick={() => {
        if (!window.confirm(`Excluir a categoria ${category.name}? Seus funcionários serão movidos para “Sem categoria”.`)) return;
        void run(() => updateStaff((current) => {
          const categories = { ...current.categories }; delete categories[category.id];
          const fallback = category.id === 'uncategorized' ? 'unclassified' : 'uncategorized';
          if (Object.values(current.members).some((member) => member.categoryId === category.id)) categories[fallback] = { id: fallback, name: 'Sem categoria', duty: 'other' };
          const members = Object.fromEntries(Object.entries(current.members).map(([id, member]) => [id, member.categoryId === category.id ? { ...member, categoryId: fallback } : member]));
          return { ...current, categories, members };
        }));
      }}>Excluir</button></p>)}
    </section>
  </div></main>;
}
