/** Browser-only matter storage. Saving is explicit; no client facts are sent to LawBuddy APIs. */
const DB_NAME = 'lawbuddy-practice';
const STORE = 'matters';
const VERSION = 1;

const open = () => new Promise((resolve, reject) => {
  if (!globalThis.indexedDB) return reject(new Error('IndexedDB is unavailable in this browser.'));
  const request = indexedDB.open(DB_NAME, VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error('Could not open matter storage.'));
});

const run = async (mode, action) => {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      let value;
      request.onsuccess = () => { value = request.result; };
      request.onerror = () => reject(request.error || new Error('Matter storage failed.'));
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(transaction.error || new Error('Matter storage failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('Matter storage was cancelled.'));
    });
  } finally {
    db.close();
  }
};

export const listMatters = async () => (await run('readonly', (store) => store.getAll()))
  .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

export const getMatter = (id) => run('readonly', (store) => store.get(id));

export const saveMatter = async (matter) => {
  const record = {
    id: matter.id || crypto.randomUUID(),
    updatedAt: new Date().toISOString(),
    kind: matter.kind,
    input: matter.input,
  };
  await run('readwrite', (store) => store.put(record));
  return record;
};

export const deleteMatter = (id) => run('readwrite', (store) => store.delete(id));
