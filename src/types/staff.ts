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
  previousNames?: string[];
}

export interface StaffData {
  configured: boolean;
  categories: Record<string, StaffCategory>;
  members: Record<string, StaffMember>;
}

export const staffNameKey = (name: string) => name.trim().toLocaleLowerCase('pt-BR');

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
