import { inspectApiErrorStatus, pb } from '../config/pocketbase';
import {
  commitNormalizedFinance,
  isNormalizedFinanceActive,
  loadNormalizedFinancePath,
  loadNormalizedFinancePathWithVersion,
  subscribeNormalizedFinancePath,
  translatePathsToFinanceMutation,
} from './financeRepository';

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
  versions?: Record<string, number | null>;
  val<T = unknown>(): T | null;
  exists(): boolean;
  child(path: string): DataSnapshot;
}

export const db = {};
const incrementKey = '__pocketbaseIncrement';

function cleanPath(path: string): string {
  return path.split('/').filter(Boolean).join('/');
}

function isFinancePath(path: string): boolean {
  const clean = cleanPath(path);
  return clean === 'erp_geral/financeiro' || clean.startsWith('erp_geral/financeiro/');
}

function financeSubPath(path: string): string {
  const clean = cleanPath(path);
  return clean === 'erp_geral/financeiro' ? '' : clean.slice('erp_geral/financeiro/'.length);
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
  const clean = cleanPath(path);
  try {
    if (!versionOnly && isFinancePath(clean) && await isNormalizedFinanceActive()) {
      const value = await loadNormalizedFinancePath<DatabaseValue>(financeSubPath(clean));
      return { value: value ?? undefined, versions: { 'erp_geral/financeiro': 2 } };
    }
    const result = await pb.send<{ value: DatabaseValue | undefined; versions: Record<string, number | null> }>('/api/hotel/state', {
      query: versionOnly ? { path: clean, versionOnly: 1 } : { path: clean },
    });
    return result;
  } catch (error) {
    inspectApiErrorStatus(error);
    throw error;
  }
}

function storagePath(path: string): string {
  const parts = cleanPath(path).split('/');
  if (parts.length < 2) throw new Error('O PocketBase só aceita dados dentro de uma área do ERP.');
  return parts.slice(0, 2).join('/');
}

function isIncrement(value: unknown): value is { [incrementKey]: number } {
  return Boolean(value && typeof value === 'object' && incrementKey in value);
}

async function commit(updates: Record<string, unknown>, expectedVersions: Record<string, number | null> = {}): Promise<void> {
  const absolute = Object.fromEntries(Object.entries(updates).map(([path, value]) => [cleanPath(path), value]));
  const touchesFinance = Object.keys(absolute).some((path) => isFinancePath(path));

  if (touchesFinance && await isNormalizedFinanceActive()) {
    const encoded = Object.fromEntries(Object.entries(absolute).map(([path, value]) => [
      path,
      isIncrement(value) ? { __pocketbaseIncrement: value[incrementKey] } : value,
    ]));
    const { financeMutation, stateUpdates } = translatePathsToFinanceMutation(encoded);
    const stateExpected = Object.fromEntries(
      Object.entries(expectedVersions).filter(([root]) => root !== 'erp_geral/financeiro'),
    );
    await commitNormalizedFinance(financeMutation, stateUpdates, stateExpected);
    return;
  }

  const roots = [...new Set(Object.keys(absolute).map(storagePath))];

  for (let attempt = 0; attempt < 8; attempt++) {
    const versions: Record<string, number | null> = {};
    await Promise.all(roots.map(async (root) => {
      if (Object.hasOwn(expectedVersions, root)) { versions[root] = expectedVersions[root]; return; }
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
      inspectApiErrorStatus(error);
      if (!(error && typeof error === 'object' && 'status' in error && error.status === 409)) throw error;
      if (Object.keys(expectedVersions).length) throw new Error('Os dados mudaram enquanto você editava. Reabra o lançamento e tente novamente.', { cause: error });
      if (attempt === 7) throw error;
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
  return { ...makeSnapshot(applyQuery(result.value, reference)), versions: result.versions };
}

export function onValue(reference: DatabaseReference, onChange: Listener, onError?: (error: Error) => void): () => void {
  let active = true;
  let stopInner: (() => void) | null = null;
  let timer: number | null = null;
  const clean = cleanPath(reference.path);

  const startLegacyPolling = () => {
    let previous: string | undefined;
    let lastVersion: number | null | undefined;
    const root = clean.split('/').slice(0, 2).join('/');
    const canCheckVersion = clean.split('/').length >= 2;
    const refresh = async () => {
      if (typeof document !== 'undefined' && document.hidden && previous !== undefined) return;
      try {
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
    timer = window.setInterval(() => void refresh(), 3000);
  };

  if (isFinancePath(clean)) {
    void isNormalizedFinanceActive().then((normalized) => {
      if (!active) return;
      if (normalized) {
        let previous: string | undefined;
        stopInner = subscribeNormalizedFinancePath(
          financeSubPath(clean),
          (val) => {
            if (!active) return;
            const snapshot = makeSnapshot(applyQuery((val ?? undefined) as DatabaseValue | undefined, reference));
            const serialized = JSON.stringify(snapshot.val());
            if (serialized === previous) return;
            previous = serialized;
            onChange(snapshot);
          },
          onError,
        );
      } else {
        startLegacyPolling();
      }
    });
  } else {
    startLegacyPolling();
  }

  return () => {
    active = false;
    if (timer !== null) window.clearInterval(timer);
    if (stopInner) stopInner();
  };
}

export async function set(reference: DatabaseReference, value: unknown): Promise<void> {
  await commit({ [reference.path]: value });
}

export async function remove(reference: DatabaseReference): Promise<void> {
  await set(reference, null);
}

export async function update(reference: DatabaseReference, values: Record<string, unknown>, expectedVersions?: Record<string, number | null>): Promise<void> {
  const updates = Object.fromEntries(Object.entries(values).map(([path, value]) => [
    cleanPath([reference.path, path].filter(Boolean).join('/')),
    value,
  ]));
  await commit(updates, expectedVersions);
}

export async function runTransaction<T = unknown>(
  reference: DatabaseReference,
  updateValue: (current: T | null) => T | null | undefined,
  _options?: { applyLocally?: boolean },
): Promise<{ committed: boolean; snapshot: DataSnapshot }> {
  void _options;
  const clean = cleanPath(reference.path);

  if (isFinancePath(clean) && await isNormalizedFinanceActive()) {
    const sub = financeSubPath(clean);
    const mapDiffSections = new Set(['deletions', 'suppressed', 'cashCollectionAcks', 'cleaningConcernAcks', 'cardFeeSchedule']);
    for (let attempt = 0; attempt < 25; attempt++) {
      const { value: current, versionKey, version } = await loadNormalizedFinancePathWithVersion<T>(sub);
      const next = updateValue((current ?? null) as T | null);
      if (next === undefined) {
        return { committed: false, snapshot: makeSnapshot((current ?? undefined) as DatabaseValue | undefined) };
      }
      const updates: Record<string, unknown> = {};
      if (mapDiffSections.has(sub) && next && typeof next === 'object' && !Array.isArray(next)) {
        const prevObj = (current && typeof current === 'object' ? current : {}) as Record<string, unknown>;
        const nextObj = next as Record<string, unknown>;
        for (const key of new Set([...Object.keys(prevObj), ...Object.keys(nextObj)])) {
          const prevVal = prevObj[key];
          const nextVal = nextObj[key];
          if (JSON.stringify(prevVal) !== JSON.stringify(nextVal)) {
            updates[`${clean}/${key}`] = nextVal === undefined ? null : nextVal;
          }
        }
      } else {
        updates[clean] = next;
      }
      const { financeMutation } = translatePathsToFinanceMutation(updates);
      if (versionKey) {
        financeMutation.expectedVersions = { ...(financeMutation.expectedVersions ?? {}), [versionKey]: version };
      }
      try {
        await commitNormalizedFinance(financeMutation);
        return { committed: true, snapshot: makeSnapshot(next as DatabaseValue) };
      } catch (error) {
        inspectApiErrorStatus(error);
        if (!(error && typeof error === 'object' && 'status' in error && error.status === 409) || attempt === 24) throw error;
      }
    }
    return { committed: false, snapshot: makeSnapshot(undefined) };
  }

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
      inspectApiErrorStatus(error);
      if (!(error && typeof error === 'object' && 'status' in error && error.status === 409) || attempt === 24) throw error;
    }
  }
  return { committed: false, snapshot: makeSnapshot(undefined) };
}
