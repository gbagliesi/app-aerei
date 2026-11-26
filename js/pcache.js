// Cache persistente delle risposte AeroDataBox / tabelloni / FlightAware, in IndexedDB.
// Prima stava nel localStorage (chiavi "aerei.adbcache.*"): ~175 KB per aeroporto e giorno, mai cancellate,
// e il localStorage (~5 MB) è condiviso da tutte le app su gbagliesi.github.io. Ora:
//  - le voci stanno in IndexedDB (spazio proprio, molto più grande);
//  - si tengono solo gli ultimi MAX_AGE_MS e al massimo MAX_BYTES, cancellando prima le più vecchie;
//  - all'avvio le vecchie voci "aerei.adbcache.*" vengono tolte dal localStorage (quelle recenti passano in IndexedDB);
//  - se IndexedDB manca o è pieno l'app continua senza cache persistente, senza errori.
// Le letture restano sincrone (pget) grazie a una copia in memoria; le voci grandi (> BIG) in memoria hanno solo
// i metadati e si leggono da IndexedDB con pgetA (asincrona).

export const LS_PREFIX = 'aerei.adbcache.';
export const MAX_AGE_MS = 7 * 86400e3;
export const MAX_BYTES = 25 * 1024 * 1024;
const BIG = 64 * 1024;
const DB = 'aerei-cache', STORE = 'kv';

const mem = new Map(); // k → { t, size, v? }  (v assente per le voci grandi, che restano solo in IndexedDB)
let total = 0;
let db = null;
let limits = { maxAge: MAX_AGE_MS, maxBytes: MAX_BYTES };

const sizeOf = v => { try { return JSON.stringify(v)?.length || 0; } catch { return 0; } };
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = tx => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = tx.onabort = () => rej(tx.error); });

function memSet(k, e) {
  const old = mem.get(k);
  if (old) total -= old.size;
  mem.set(k, e);
  total += e.size;
}
function memDel(k) {
  const old = mem.get(k);
  if (old) { total -= old.size; mem.delete(k); }
}

/** Toglie dal localStorage tutte le vecchie voci della cache. Restituisce quelle ancora utili da riportare in IndexedDB. */
export function purgeLocalStorage(now = Date.now()) {
  const keep = [];
  let keys = [];
  try { keys = Object.keys(localStorage).filter(k => k.startsWith(LS_PREFIX)); } catch { return keep; }
  for (const key of keys) {
    try {
      const raw = localStorage.getItem(key);
      const x = JSON.parse(raw);
      if (x && typeof x.t === 'number' && now - x.t < limits.maxAge) keep.push({ k: key.slice(LS_PREFIX.length), t: x.t, v: x.v, size: raw.length });
    } catch { /* voce rovinata: la cancello e basta */ }
    try { localStorage.removeItem(key); } catch { /* niente */ }
  }
  return keep;
}

function openDb() {
  return new Promise((res, rej) => {
    if (typeof indexedDB === 'undefined') return rej(new Error('IndexedDB non disponibile'));
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { const s = r.result.createObjectStore(STORE, { keyPath: 'k' }); s.createIndex('t', 't'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('IndexedDB bloccato'));
  });
}

/** Cancella le voci scadute e, se si supera MAX_BYTES, le più vecchie (in memoria e in IndexedDB). */
export async function prune(now = Date.now(), maxBytes = limits.maxBytes) {
  const drop = [];
  const byAge = [...mem.entries()].sort((a, b) => a[1].t - b[1].t);
  let size = total;
  for (const [k, e] of byAge) {
    if (now - e.t >= limits.maxAge || size > maxBytes) { drop.push(k); size -= e.size; }
  }
  for (const k of drop) memDel(k);
  if (db && drop.length) {
    try { const tx = db.transaction(STORE, 'readwrite'); const s = tx.objectStore(STORE); for (const k of drop) s.delete(k); await done(tx); } catch { /* pazienza */ }
  }
  return drop.length;
}

let pruneTimer = null;
const schedulePrune = () => { if (!pruneTimer) pruneTimer = setTimeout(() => { pruneTimer = null; prune().catch(() => {}); }, 2000); };

async function idbPut(rec) {
  if (!db) return false;
  for (let i = 0; i < 2; i++) {
    try { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(rec); await done(tx); return true; }
    catch (e) {
      if (i || !/quota/i.test(`${e?.name} ${e?.message}`)) break;
      // spazio esaurito: libero metà dello spazio usato (le voci più vecchie) e riprovo una volta
      await prune(Date.now(), Math.floor(total / 2)).catch(() => {});
    }
  }
  return false;
}

/** Avvio: pulizia del localStorage, apertura di IndexedDB, copia in memoria delle voci recenti. Non lancia mai errori. */
export async function initPCache(opts = {}) {
  limits = { maxAge: opts.maxAge ?? MAX_AGE_MS, maxBytes: opts.maxBytes ?? MAX_BYTES };
  mem.clear(); total = 0; db = null;
  const now = Date.now();
  const moved = purgeLocalStorage(now);
  try {
    db = await openDb();
    const all = await req(db.transaction(STORE).objectStore(STORE).getAll());
    for (const r of all) if (!(mem.get(r.k)?.t >= r.t)) memSet(r.k, r.size > BIG ? { t: r.t, size: r.size } : { t: r.t, size: r.size, v: r.v });
  } catch { db = null; }
  for (const r of moved) if (!(mem.get(r.k)?.t >= r.t)) { memSet(r.k, r.size > BIG ? { t: r.t, size: r.size } : { t: r.t, size: r.size, v: r.v }); await idbPut(r); }
  await prune(now).catch(() => {});
  return { persistent: !!db, entries: mem.size, bytes: total, moved: moved.length };
}

/** Lettura sincrona: { t, v } se la voce è più giovane di ttl ed è in memoria, altrimenti undefined. */
export function pgetT(k, ttl) {
  const e = mem.get(k);
  return e && 'v' in e && Date.now() - e.t < ttl ? { t: e.t, v: e.v } : undefined;
}
export const pget = (k, ttl) => pgetT(k, ttl)?.v;

/** Lettura asincrona: come pgetT, ma legge da IndexedDB anche le voci grandi. */
export async function pgetA(k, ttl) {
  const e = mem.get(k);
  if (!e || Date.now() - e.t >= ttl) return undefined;
  if ('v' in e) return { t: e.t, v: e.v };
  if (!db) return undefined;
  try {
    const r = await req(db.transaction(STORE).objectStore(STORE).get(k));
    return r && Date.now() - r.t < ttl ? { t: r.t, v: r.v } : undefined;
  } catch { return undefined; }
}

/** Salvataggio: subito in memoria, poi in IndexedDB. Se lo spazio è finito la voce resta solo in memoria. */
export function pput(k, v, t = Date.now()) {
  const size = sizeOf(v);
  if (size > limits.maxBytes) return Promise.resolve(false);
  memSet(k, size > BIG ? { t, size } : { t, size, v });
  if (size > BIG && !db) memSet(k, { t, size, v }); // senza IndexedDB la tengo almeno in memoria per questa sessione
  if (total > limits.maxBytes) schedulePrune();
  return idbPut({ k, t, v, size }).then(ok => {
    if (!ok && size > BIG && mem.get(k)?.t === t) memSet(k, { t, size, v }); // non salvata: resta in memoria
    return ok;
  }).catch(() => false);
}

export const pcacheStats = () => ({ persistent: !!db, entries: mem.size, bytes: total });
