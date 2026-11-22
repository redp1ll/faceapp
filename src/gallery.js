// Recent edits, stored only on this device (IndexedDB). Each entry keeps the
// original photo, the edit settings and a small preview, so an edit can be
// reopened and continued later.
const DB = 'facette';
const MAX_ENTRIES = 40;

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('edits', { keyPath: 'id' }); // metadata, state, preview
        d.createObjectStore('originals'); // id -> original photo blob
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    // Ask the browser not to evict our data under storage pressure.
    navigator.storage?.persist?.().catch(() => {});
  }
  return dbPromise;
}

function tx(stores, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    const out = fn(t);
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export async function listEdits() {
  try {
    const all = await tx(['edits'], 'readonly', (t) => t.objectStore('edits').getAll());
    return all.sort((a, b) => b.updated - a.updated);
  } catch {
    return [];
  }
}

export function saveOriginal(id, blob) {
  return tx(['originals'], 'readwrite', (t) => { t.objectStore('originals').put(blob, id); });
}

export function getOriginal(id) {
  return tx(['originals'], 'readonly', (t) => t.objectStore('originals').get(id));
}

export async function saveEdit(entry) {
  await tx(['edits'], 'readwrite', (t) => { t.objectStore('edits').put(entry); });
  const all = await listEdits();
  for (const old of all.slice(MAX_ENTRIES)) await deleteEdit(old.id);
}

export function deleteEdit(id) {
  return tx(['edits', 'originals'], 'readwrite', (t) => {
    t.objectStore('edits').delete(id);
    t.objectStore('originals').delete(id);
  });
}
