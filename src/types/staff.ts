export interface StaffCategory {
  id: string;
  name: string;
  duty: 'reception' | 'housekeeping' | 'other';
}

export interface StaffMember {
  id: string;
  name: string;
  categoryId: string;
  active: boolean;
  address?: string;
  phone?: string;
  children?: StaffChild[];
  workStart?: string;
  workEnd?: string;
  weeklyDayOff?: number;
  startDate?: string;
  notes?: string;
  previousNames?: string[];
  /** Salário base mensal em R$. Ausente nos cadastros anteriores a este campo (equivale a 0). */
  baseSalary?: number;
}

export interface StaffChild {
  name: string;
  birthDate: string;
}

export interface StaffData {
  configured: boolean;
  categories: Record<string, StaffCategory>;
  members: Record<string, StaffMember>;
}

export const staffNameKey = (name: string) => name.trim().toLocaleLowerCase('pt-BR');

// Cadastros antigos não têm salário base; valores ausentes, inválidos ou negativos valem 0.
export function normalizeBaseSalary(value: unknown): number {
  const amount = typeof value === 'string' ? Number(value.trim().replace(',', '.')) : typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : 0;
}

export function staffBaseSalary(member?: Pick<StaffMember, 'baseSalary'> | null): number {
  return normalizeBaseSalary(member?.baseSalary);
}

export function defaultStaff(): StaffData {
  const names = { reception: ['Tatiana', 'Luana', 'Cevani', 'Paulo'], housekeeping: ['Juliana', 'Thifani', 'Amanda'] };
  return {
    configured: false,
    categories: {
      reception: { id: 'reception', name: 'Recepção plantonista', duty: 'reception' },
      housekeeping: { id: 'housekeeping', name: 'Camareiras', duty: 'housekeeping' },
    },
    members: Object.fromEntries(Object.entries(names).flatMap(([categoryId, list]) => list.map((name) => {
      const id = `staff-${staffNameKey(name)}`;
      return [id, { id, name, categoryId, active: true }];
    }))),
  };
}

export function staffMembers(data: StaffData, duty?: StaffCategory['duty']): StaffMember[] {
  return Object.values(data.members).filter((member) => member.active && (!duty || data.categories[member.categoryId]?.duty === duty))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

export function findStaff(data: StaffData, name: string, id?: string): StaffMember | undefined {
  if (id) return data.members[id];
  return Object.values(data.members).find((member) =>
    [member.name, ...(member.previousNames ?? [])].some((alias) => staffNameKey(alias) === staffNameKey(name)));
}
