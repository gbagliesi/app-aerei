// Test della cache persistente (js/pcache.js): IndexedDB al posto del localStorage, limiti di età e spazio,
// pulizia delle vecchie voci "aerei.adbcache.*", nessun errore se lo spazio è finito o IndexedDB manca.
// Uso: npm i --no-save fake-indexeddb && node tools/test-pcache.mjs
import assert from 'node:assert/strict';

// localStorage finto, con le stesse chiavi enumerabili di quello vero (Object.keys)
class LS {
  getItem(k) { return Object.hasOwn(this, k) ? this[k] : null; }
  setItem(k, v) { Object.defineProperty(this, k, { value: String(v), enumerable: true, configurable: true, writable: true }); }
  removeItem(k) { delete this[k]; }
}
Object.defineProperties(LS.prototype, { getItem: { enumerable: false }, setItem: { enumerable: false }, removeItem: { enumerable: false } });
globalThis.localStorage = new LS();

const fake = await import('fake-indexeddb').catch(() => null);
if (!fake) { console.error('Serve fake-indexeddb: npm i --no-save fake-indexeddb'); process.exit(2); }
globalThis.indexedDB = fake.indexedDB;
globalThis.IDBKeyRange = fake.IDBKeyRange;

const P = await import(new URL('../js/pcache.js', import.meta.url).href);
const DAY = 86400e3, now = Date.now();
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const big = kb => ({ f: 'x'.repeat(kb * 1024) });

await test('all\'avvio toglie dal localStorage le voci aerei.adbcache.* e lascia le altre', async () => {
  localStorage.setItem('aerei.adbcache.snap2:AMS:D:2026-11-15', JSON.stringify({ t: now - 10 * DAY, v: big(175) }));
  localStorage.setItem('aerei.adbcache.day:FCO:D:2026-11-25', JSON.stringify({ t: now - DAY, v: [{ number: 'AZ1' }] }));
  localStorage.setItem('aerei.adbcache.knownRegs', JSON.stringify({ t: now - 3600e3, v: { 'PSA|D|FR1|x': { reg: 'EI-ABC' } } }));
  localStorage.setItem('aerei.adbcache.rotta', '{non è json');
  const altre = { 'aerei.tabs.v1': '[]', 'aerei.favorites.v1': '{"airports":["PSA"]}', 'aerei.sync.v1': '{"token":"x"}', 'aerei.settings.v1': '{}', 'aerei.adbBlocked': '{"until":0}', 'salotto.preferiti': '["a"]' };
  for (const [k, v] of Object.entries(altre)) localStorage.setItem(k, v);
  const r = await P.initPCache();
  assert.equal(r.persistent, true);
  assert.deepEqual(Object.keys(localStorage).filter(k => k.startsWith('aerei.adbcache.')), []);
  for (const [k, v] of Object.entries(altre)) assert.equal(localStorage.getItem(k), v, k);
  // le voci recenti passano in IndexedDB, quelle di più di 7 giorni no
  assert.equal(P.pget('knownRegs', DAY)['PSA|D|FR1|x'].reg, 'EI-ABC');
  assert.equal((await P.pgetA('day:FCO:D:2026-11-25', 3 * DAY)).v[0].number, 'AZ1');
  assert.equal(await P.pgetA('snap2:AMS:D:2026-11-15', 30 * DAY), undefined);
});

await test('salva e rilegge, anche dopo un riavvio; rispetta il ttl', async () => {
  await P.pput('fa:ident=AZ1', { flights: [1, 2] });
  assert.deepEqual(P.pget('fa:ident=AZ1', 60e3), { flights: [1, 2] });
  assert.equal(P.pget('fa:ident=AZ1', 0), undefined);
  await P.initPCache();
  assert.deepEqual(P.pget('fa:ident=AZ1', 60e3), { flights: [1, 2] });
});

await test('voci grandi: in memoria solo i metadati, lette da IndexedDB con pgetA', async () => {
  await P.pput('snap2:PSA:D:2026-11-26', big(175));
  assert.equal(P.pget('snap2:PSA:D:2026-11-26', DAY), undefined);
  assert.equal((await P.pgetA('snap2:PSA:D:2026-11-26', DAY)).v.f.length, 175 * 1024);
  await P.initPCache();
  assert.equal((await P.pgetA('snap2:PSA:D:2026-11-26', DAY)).v.f.length, 175 * 1024);
});

await test('cancella le voci più vecchie di 7 giorni', async () => {
  await P.pput('vecchia', { a: 1 }, now - 8 * DAY);
  await P.pput('nuova', { a: 2 }, now - 6 * DAY);
  await P.initPCache();
  assert.equal(await P.pgetA('vecchia', 30 * DAY), undefined);
  assert.equal((await P.pgetA('nuova', 30 * DAY)).v.a, 2);
});

await test('limite di spazio: oltre maxBytes se ne vanno prima le voci più vecchie', async () => {
  await P.initPCache({ maxBytes: 500 * 1024 });
  for (let i = 0; i < 5; i++) await P.pput(`day:X${i}`, big(150), now - (10 - i) * 3600e3);
  await P.prune();
  assert.ok(P.pcacheStats().bytes <= 500 * 1024, `bytes ${P.pcacheStats().bytes}`);
  assert.equal(await P.pgetA('day:X0', DAY), undefined);
  assert.equal(await P.pgetA('day:X1', DAY), undefined);
  assert.ok(await P.pgetA('day:X4', DAY));
  await P.initPCache({ maxBytes: 500 * 1024 }); // anche su disco
  assert.equal(await P.pgetA('day:X0', DAY), undefined);
  assert.ok(await P.pgetA('day:X4', DAY));
});

await test('spazio esaurito: nessun errore, l\'app continua (voce tenuta solo in memoria)', async () => {
  await P.initPCache();
  const put = fake.IDBObjectStore.prototype.put;
  fake.IDBObjectStore.prototype.put = function () { throw new DOMException('pieno', 'QuotaExceededError'); };
  try {
    const ok = await P.pput('board:BRI', big(100));
    assert.equal(ok, false);
    assert.equal((await P.pgetA('board:BRI', DAY)).v.f.length, 100 * 1024);
    assert.equal(await P.pput('piccola', { a: 1 }), false);
    assert.deepEqual(P.pget('piccola', DAY), { a: 1 });
  } finally { fake.IDBObjectStore.prototype.put = put; }
});

await test('senza IndexedDB: cache solo in memoria, nessun errore', async () => {
  const idb = globalThis.indexedDB;
  delete globalThis.indexedDB;
  try {
    localStorage.setItem('aerei.adbcache.late:PSA:dep', JSON.stringify({ t: now, v: [1] }));
    const r = await P.initPCache();
    assert.equal(r.persistent, false);
    assert.equal(localStorage.getItem('aerei.adbcache.late:PSA:dep'), null);
    assert.deepEqual(P.pget('late:PSA:dep', DAY), [1]);
    assert.equal(await P.pput('x', big(80)), false);
    assert.ok(await P.pgetA('x', DAY));
  } finally { globalThis.indexedDB = idb; }
});

await test('localStorage inaccessibile (es. bloccato dal browser): nessun errore', async () => {
  const ls = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { get() { throw new DOMException('negato', 'SecurityError'); }, configurable: true });
  try { assert.equal((await P.initPCache()).persistent, true); }
  finally { Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true, writable: true }); }
});

console.log(`\n${n} test superati`);
