import { db, endAt, equalTo, onValue, orderByChild, query, ref, startAt } from './pocketbaseRealtime';
import { emptyReception } from './receptionStore';
import type { ReceptionData } from '../types/reception';
import type { FrigobarSale } from '../types/frigobar';

// Both day and night shifts belong to their starting operational day.
export function cashDayBounds(date: string): [string, string] {
  const start = new Date(`${date}T07:00:00-03:00`);
  return [start.toISOString(), new Date(start.getTime() + 86_400_000 - 1).toISOString()];
}

export function subscribeCashDay(date: string, onChange: (data: ReceptionData) => void, onError: (error: Error) => void): () => void {
  const [start, end] = cashDayBounds(date);
  const current = emptyReception();
  const keys = ['stays', 'roomCharges', 'cashOuts', 'floatChecks'] as const;
  const loaded = new Set<string>();
  const stayRecords: Record<string, ReceptionData['stays']> = {};
  const cashOutRecords: { created: ReceptionData['cashOuts']; dated: ReceptionData['cashOuts'] } = { created: {}, dated: {} };
  const publish = () => {
    if (loaded.size === keys.length + 2) {
      onChange({ ...current, cashOuts: { ...cashOutRecords.created, ...cashOutRecords.dated }, stays: { ...stayRecords.created, ...stayRecords.receipts } });
    }
  };
  const stops = keys.map((key) => onValue(query(ref(db, `erp_geral/recepcao/${key}`), orderByChild('createdAt'), startAt(start), endAt(end)), (snapshot) => {
    if (key === 'cashOuts') cashOutRecords.created = snapshot.val<ReceptionData['cashOuts']>() ?? {};
    else if (key === 'stays') {
      const records = snapshot.val<ReceptionData['stays']>() ?? {};
      current.stays = records;
      stayRecords.created = records;
    } else if (key === 'roomCharges') current.roomCharges = snapshot.val<ReceptionData['roomCharges']>() ?? {};
    else current.floatChecks = snapshot.val<ReceptionData['floatChecks']>() ?? {};
    loaded.add(key);
    publish();
  }, onError));
  stops.push(onValue(query(ref(db, 'erp_geral/recepcao/cashOuts'), orderByChild('date'), equalTo(date)), (snapshot) => {
    cashOutRecords.dated = snapshot.val<ReceptionData['cashOuts']>() ?? {};
    loaded.add('cashOutDate');
    publish();
  }, onError));
  stops.push(onValue(query(ref(db, 'erp_geral/recepcao/stays'), orderByChild('lastReceiptAt'), startAt(start)), (snapshot) => { stayRecords.receipts = snapshot.val<ReceptionData['stays']>() ?? {}; loaded.add('receipts'); publish(); }, onError));
  return () => stops.forEach((stop) => stop());
}

export function subscribeCashSales(date: string, onChange: (sales: Record<string, FrigobarSale>) => void, onError: (error: Error) => void): () => void {
  const [start, end] = cashDayBounds(date);
  const records: Record<string, Record<string, FrigobarSale>> = {};
  const stops = ['createdAt', 'settledAt'].map((field) => onValue(query(ref(db, 'erp_geral/frigobar/operations/sales'), orderByChild(field), startAt(start), endAt(end)), (snapshot) => {
    records[field] = snapshot.val() ?? {};
    if (Object.keys(records).length === 2) onChange({ ...records.createdAt, ...records.settledAt });
  }, onError));
  return () => stops.forEach((stop) => stop());
}
