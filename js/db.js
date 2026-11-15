// Small IndexedDB wrapper: everything stays on this tablet.
const DB_NAME = 'campfire', VER = 1;
let dbp = null;
function open() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('songs')) db.createObjectStore('songs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
function tx(store, mode, fn) {
  return open().then(db => new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(v => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const db = {
  allSongs: () => open().then(d => req(d.transaction('songs').objectStore('songs').getAll())),
  putSongs: (songs) => tx('songs', 'readwrite', s => { songs.forEach(x => s.put(x)); }),
  putSong: (song) => tx('songs', 'readwrite', s => { s.put(song); }),
  deleteSong: (id) => tx('songs', 'readwrite', s => { s.delete(id); }),
  clearAll: () => open().then(d => new Promise((res, rej) => {
    const t = d.transaction(['songs', 'images', 'meta'], 'readwrite');
    ['songs', 'images', 'meta'].forEach(n => t.objectStore(n).clear());
    t.oncomplete = res; t.onerror = () => rej(t.error);
  })),
  getImage: (id) => open().then(d => req(d.transaction('images').objectStore('images').get(id))),
  putImages: (map) => tx('images', 'readwrite', s => { for (const [k, v] of Object.entries(map)) s.put(v, k); }),
  allImages: () => open().then(d => new Promise((res, rej) => {
    const out = {}; const r = d.transaction('images').objectStore('images').openCursor();
    r.onsuccess = () => { const c = r.result; if (c) { out[c.key] = c.value; c.continue(); } else res(out); };
    r.onerror = () => rej(r.error);
  })),
  getMeta: (k, d0) => open().then(d => req(d.transaction('meta').objectStore('meta').get(k))).then(v => (v === undefined ? d0 : v)),
  setMeta: (k, v) => tx('meta', 'readwrite', s => { s.put(v, k); }),
};
