import { useState, type FormEvent } from 'react';
import { BackToPanel } from '../components/ui/BackToPanel';
import { saveStaffMember, updateStaff, useStaff } from '../services/staffStore';
import type { StaffCategory, StaffMember } from '../types/staff';
import './financeiro/financeiro.css';
import './funcionarios.css';

export function Funcionarios() {
  const { data, error: loadError } = useStaff();
  const [editing, setEditing] = useState<StaffMember | null>(null);
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('reception');
  const [active, setActive] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function run(action: () => Promise<void>) {
    setSaving(true); setError('');
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível salvar.'); }
    finally { setSaving(false); }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !data.categories[categoryId]) return setError('Informe o nome e uma categoria.');
    void run(async () => {
      await saveStaffMember({ id: editing?.id ?? crypto.randomUUID(), name: name.trim(), categoryId, active });
      setEditing(null); setName(''); setActive(true);
    });
  }
  function edit(member: StaffMember) { setEditing(member); setName(member.name); setCategoryId(member.categoryId); setActive(member.active); }
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
        <label>Categoria<select required value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="">Selecione...</option>{Object.values(data.categories).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /> Ativo</label>
        <button type="submit" disabled={saving}>Salvar</button>
        {editing && <button type="button" onClick={() => { setEditing(null); setName(''); }}>Cancelar</button>}
      </form>
      <div style={{ overflowX: 'auto' }}><table className="finance-table"><thead><tr><th>Nome</th><th>Categoria</th><th>Situação</th><th>Ações</th></tr></thead>
        <tbody>{Object.values(data.members).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')).map((member) => <tr key={member.id}><td>{member.name}</td><td>{data.categories[member.categoryId]?.name ?? 'Sem categoria'}</td><td>{member.active ? 'Ativo' : 'Inativo'}</td><td><button disabled={saving} onClick={() => edit(member)}>Editar</button> <button disabled={saving} onClick={() => remove(member)}>Excluir</button></td></tr>)}</tbody></table></div>
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
