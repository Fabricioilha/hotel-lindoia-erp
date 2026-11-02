import { pb } from '../config/pocketbase';

type DatabaseValue = Record<string, unknown> | unknown[] | string | number | boolean | null;
type Listener = (snapshot: DataSnapshot) => void;
type Comparator = { type: 'key' } | { type: 'child'; child: string };
type Constraint = { type: 'equal' | 'start' | 'end' | 'limit'; value: unknown };

export interface DatabaseReference {
  path: string;
  comparator?: Comparator;
  constraints?: Constraint[];
}

export interface DataSnapshot {
  val<T = unknown>(): T | null;
  exists(): boolean;
  child(path: string): DataSnapshot;
}

export const db = {};
const incrementKey = '__pocketbaseIncrement';

function cleanPath(path: string): string {
  return path.split('/').filter(Boolean).join('/');
}

function makeSnapshot(value: DatabaseValue | undefined): DataSnapshot {
  const copy = value === undefined ? undefined : structuredClone(value);
  return {
    val: <T = unknown>() => (copy === undefined ? null : structuredClone(copy)) as T | null,
    exists: () => copy !== undefined && copy !== null,
    child: (path: string) => {
      let nested: unknown = copy;
      for (const part of cleanPath(path).split('/').filter(Boolean)) {
        if (!nested || typeof nested !== 'object') return makeSnapshot(undefined);
        nested = (nested as Record<string, unknown>)[part];
      }
      return makeSnapshot(nested as DatabaseValue | undefined);
    },
  };
}

function matchesConstraints(value: unknown, key: string, reference: DatabaseReference): boolean {
  const orderedValue = reference.comparator?.type === 'key'
    ? key
    : reference.comparator?.child
      ? (value as Record<string, unknown> | null)?.[reference.comparator.child]
      : key;
  return (reference.constraints ?? []).every((constraint) => {
    switch (constraint.type) {
      case 'equal': return orderedValue === constraint.value;
      case 'start': return orderedValue !== undefined && String(orderedValue) >= String(constraint.value);
      case 'end': return orderedValue !== undefined && String(orderedValue) <= String(constraint.value);
      default: return true;
    }
  });
}

function applyQuery(value: DatabaseValue | undefined, reference: DatabaseReference): DatabaseValue | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  let entries = Object.entries(value).filter(([key, child]) => matchesConstraints(child, key, reference));
  const limit = reference.constraints?.find((constraint) => constraint.type === 'limit')?.value;
  if (typeof limit === 'number') entries = entries.slice(-limit);
  return Object.fromEntries(entries);
}

async function fetchState(path: string, versionOnly = false): Promise<{ value: DatabaseValue | undefined; versions: Record<string, number | null> }> {
  const result = await pb.send<{ value: DatabaseValue | undefined; versions: Record<string, number | null> }>('/api/hotel/state', {
    query: versionOnly ? { path: cleanPath(path), versionOnly: 1 } : { path: cleanPath(path) },
  });
  return result;
}

function storagePath(path: string): string {
  const parts = cleanPath(path).split('/');
  if (parts.length < 2) throw new Error('O PocketBase só aceita dados dentro de uma área do ERP.');
  return parts.slice(0, 2).join('/');
}

function isIncrement(value: unknown): value is { [incrementKey]: number } {
  return Boolean(value && typeof value === 'object' && incrementKey in value);
}

async function commit(updates: Record<string, unknown>): Promise<void> {
  const absolute = Object.fromEntries(Object.entries(updates).map(([path, value]) => [cleanPath(path), value]));
  const roots = [...new Set(Object.keys(absolute).map(storagePath))];

  for (let attempt = 0; attempt < 8; attempt++) {
    const versions: Record<string, number | null> = {};
    await Promise.all(roots.map(async (root) => {
      const current = await fetchState(root, true);
      versions[root] = current.versions[root] ?? null;
    }));

    const encoded = Object.fromEntries(Object.entries(absolute).map(([path, value]) => [
      path,
      isIncrement(value) ? { __pocketbaseIncrement: value[incrementKey] } : value,
    ]));
    try {
      await pb.send('/api/hotel/state/commit', {
        method: 'POST',
        body: { expected: versions, updates: encoded },
      });
      return;
    } catch (error) {
      if (!(error && typeof error === 'object' && 'status' in error && error.status === 409) || attempt === 7) throw error;
    }
  }
}

export function ref(_database: typeof db, path = ''): DatabaseReference {
  return { path: cleanPath(path), constraints: [] };
}

export function query(reference: DatabaseReference, ...constraints: (Comparator | Constraint)[]): DatabaseReference {
  return constraints.reduce<DatabaseReference>((result, constraint) => {
    if (constraint.type === 'key' || constraint.type === 'child') result.comparator = constraint;
    else result.constraints = [...(result.constraints ?? []), constraint];
    return result;
  }, { ...reference, constraints: [...(reference.constraints ?? [])] });
}

export function orderByChild(child: string): Comparator {
  return { type: 'child', child };
}

export function orderByKey(): Comparator {
  return { type: 'key' };
}

export function equalTo(value: unknown): Constraint {
  return { type: 'equal', value };
}

export function startAt(value: unknown): Constraint {
  return { type: 'start', value };
}

export function endAt(value: unknown): Constraint {
  return { type: 'end', value };
}

export function limitToLast(value: number): Constraint {
  return { type: 'limit', value };
}

export function increment(value: number): { [incrementKey]: number } {
  if (!Number.isFinite(value)) throw new Error('O incremento precisa ser um número finito.');
  return { [incrementKey]: value };
}

const inFlight = new Map<string, ReturnType<typeof fetchState>>();

/** Reuses an identical request already in flight so many listeners do not multiply server work. */
function sharedFetchState(path: string) {
  const key = cleanPath(path);
  let pending = inFlight.get(key);
  if (!pending) {
    pending = fetchState(key).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

export async function get(reference: DatabaseReference): Promise<DataSnapshot> {
  const result = await sharedFetchState(reference.path);
  return makeSnapshot(applyQuery(result.value, reference));
}

export function onValue(reference: DatabaseReference, onChange: Listener, onError?: (error: Error) => void): () => void {
  let active = true;
  let previous: string | undefined;
  let lastVersion: number | null | undefined;
  const root = cleanPath(reference.path).split('/').slice(0, 2).join('/');
  const canCheckVersion = cleanPath(reference.path).split('/').length >= 2;
  const refresh = async () => {
    if (typeof document !== 'undefined' && document.hidden && previous !== undefined) return;
    try {
      // The revision check is cheap; download the data only when the branch changed.
      if (canCheckVersion && previous !== undefined) {
        const check = await fetchState(reference.path, true);
        const version = check.versions[root] ?? null;
        if (!active || version === lastVersion) return;
      }
      const result = await sharedFetchState(reference.path);
      if (!active) return;
      lastVersion = result.versions[root] ?? null;
      const snapshot = makeSnapshot(applyQuery(result.value, reference));
      const serialized = JSON.stringify(snapshot.val());
      if (serialized === previous) return;
      previous = serialized;
      onChange(snapshot);
    } catch (cause) {
      if (active) onError?.(cause instanceof Error ? cause : new Error('Falha ao carregar os dados do PocketBase.'));
    }
  };
  void refresh();
  const timer = window.setInterval(() => void refresh(), 3000);
  return () => {
    active = false;
    window.clearInterval(timer);
  };
}

export async function set(reference: DatabaseReference, value: unknown): Promise<void> {
  await commit({ [reference.path]: value });
}

export async function remove(reference: DatabaseReference): Promise<void> {
  await set(reference, null);
}

export async function update(reference: DatabaseReference, values: Record<string, unknown>): Promise<void> {
  const updates = Object.fromEntries(Object.entries(values).map(([path, value]) => [
    cleanPath([reference.path, path].filter(Boolean).join('/')),
    value,
  ]));
  await commit(updates);
}

export async function runTransaction<T = unknown>(
  reference: DatabaseReference,
  updateValue: (current: T | null) => T | null | undefined,
  _options?: { applyLocally?: boolean },
): Promise<{ committed: boolean; snapshot: DataSnapshot }> {
  void _options;
  for (let attempt = 0; attempt < 25; attempt++) {
    const current = await fetchState(reference.path);
    const next = updateValue((current.value ?? null) as T | null);
    if (next === undefined) return { committed: false, snapshot: makeSnapshot(current.value) };

    const updates = reference.path === 'erp_geral' && next && typeof next === 'object'
      ? Object.fromEntries([...new Set([
        ...Object.keys((current.value ?? {}) as Record<string, unknown>),
        ...Object.keys(next as Record<string, unknown>),
      ])].map((key) => [`erp_geral/${key}`, (next as Record<string, unknown>)[key] ?? null]))
      : { [reference.path]: next };
    const expected = current.versions;
    try {
      await pb.send('/api/hotel/state/commit', { method: 'POST', body: { expected, updates } });
      return { committed: true, snapshot: makeSnapshot(next as DatabaseValue) };
    } catch (error) {
      if (!(error && typeof error === 'object' && 'status' in error && error.status === 409) || attempt === 24) throw error;
    }
  }
  return { committed: false, snapshot: makeSnapshot(undefined) };
}
