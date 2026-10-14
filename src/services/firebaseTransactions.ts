import { onValue, ref, type DatabaseReference } from 'firebase/database';
import { db } from '../config/firebase';

/** Keep a complete server snapshot cached until a dependent transaction ends. */
export async function withTransactionData<T>(path: string, action: (reference: DatabaseReference) => Promise<T>): Promise<T> {
  const reference = ref(db, path);
  let ready!: () => void;
  let fail!: (cause: Error) => void;
  const loaded = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
  const stop = onValue(reference, ready, fail);
  try {
    await loaded;
    return await action(reference);
  } finally {
    stop();
  }
}
