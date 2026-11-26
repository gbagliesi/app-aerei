// Sincronizzazione fra dispositivi tramite il Worker (worker/sync.js): preferiti, tab aperti, voli seguiti con le
// notifiche e impostazioni (fonte dati, chiave AeroDataBox, aggiornamento). Senza collegamento l'app funziona come
// sempre, con i dati solo in questo browser.
//
// Funzionamento: ogni dato è un "record" (chiave → valore). L'app confronta i dati attuali con l'ultima copia
// sincronizzata (shadow), manda al Worker solo i cambiamenti e riceve quelli degli altri dispositivi; vince la
// modifica più recente. Il primo scambio di un dispositivo appena collegato prende i dati dell'account e aggiunge
// quelli che c'erano solo qui (i preferiti si uniscono, non si perdono).
import { getSettings, saveSettings, getFavorites, favKey, replaceFavorites } from './store.js';
import { localWatches, applyRemoteWatches } from './notify.js';

const AKEY = 'aerei.sync.v1', SHKEY = 'aerei.sync.shadow.v1', TKEY = 'aerei.tabs.v1';
const FTYPES = ['airports', 'routes', 'flights', 'aircraft'];
export const SYNC_CATS = {
  fav: 'Preferiti (aeroporti, tratte, voli, aerei)',
  tabs: 'Tab aperti in alto',
  watch: 'Voli seguiti con le notifiche (si attivano anche qui, se qui le notifiche sono permesse)',
  settings: 'Impostazioni: fonte dei dati, chiave AeroDataBox, aggiornamento automatico',
};
const PULL_MS = 90e3;

const base = () => (getSettings().workerUrl || '').trim().replace(/\/+$/, '');
const readJ = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
export const syncAccount = () => readJ(AKEY, null);
const saveAccount = a => { if (a) localStorage.setItem(AKEY, JSON.stringify(a)); else localStorage.removeItem(AKEY); window.dispatchEvent(new Event('sync-changed')); };
const patchAccount = p => { const a = syncAccount(); if (a) saveAccount({ ...a, ...p }); };
export const isLinked = () => !!syncAccount()?.token;

export function deviceName() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'iPad'
    : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'dispositivo';
  const br = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  const app = matchMedia('(display-mode: standalone)').matches || navigator.standalone ? 'app' : br;
  return [os, app].filter(Boolean).join(' · ');
}

async function post(path, body, timeout = 15000) {
  if (!base()) throw new Error('Serve prima l’indirizzo del Worker in Impostazioni (è lì che restano i dati sincronizzati).');
  const r = await fetch(`${base()}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 404 && !j.error) throw new Error('Il Worker non ha ancora la sincronizzazione: va aggiornato.');
    throw Object.assign(new Error(j.error || `Worker: errore ${r.status}`), { auth: j.auth === false || r.status === 401 });
  }
  return j;
}

// ---------- record locali ----------
const cats = () => ({ fav: true, tabs: true, watch: true, settings: true, ...(syncAccount()?.cats || {}) });
// solo i campi stabili dei tab (titolo e pagina); sottotitolo, pallino e uso cambiano di continuo e restano locali
const TAB_FIELDS = ['key', 'hash', 'kind', 'title', 'city', 'date'];
const slimTab = t => Object.fromEntries(TAB_FIELDS.filter(k => t[k] != null).map(k => [k, t[k]]));

function localRecords() {
  const c = cats(), r = {};
  if (c.settings) { const s = getSettings(); r.settings = { provider: s.provider, apiKey: s.apiKey, refreshSec: s.refreshSec }; }
  if (c.fav) {
    const f = getFavorites();
    for (const type of FTYPES) {
      const items = f[type] || [];
      for (const it of items) r[`fav:${type}:${favKey(type, it)}`] = it;
      r[`favorder:${type}`] = items.map(it => favKey(type, it));
    }
  }
  if (c.tabs) { const t = readJ(TKEY, []); r.tabs = Array.isArray(t) ? t.map(slimTab) : []; }
  if (c.watch) for (const [k, w] of Object.entries(localWatches())) if (w.flight) r[`watch:${k}`] = { flight: w.flight, events: w.events || [], useKey: w.useKey !== false };
  return r;
}
const catOf = k => k === 'settings' ? 'settings' : k === 'tabs' ? 'tabs' : k.startsWith('watch:') ? 'watch' : 'fav';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Applica ai dati del browser i record arrivati dal Worker. */
async function applyRemote(changes, first) {
  const c = cats(), local = localRecords(), touched = new Set();
  const merged = { ...local };
  for (const [k, { v }] of Object.entries(changes)) {
    if (!c[catOf(k)]) continue;
    // al primo scambio le vecchie cancellazioni dell'account non tolgono quello che c'è solo qui
    if (first && v === null) continue;
    if (v === null) { if (k in merged) { delete merged[k]; touched.add(catOf(k)); } } else if (!same(merged[k], v)) { merged[k] = v; touched.add(catOf(k)); }
  }
  if (touched.has('settings') && merged.settings) {
    const s = getSettings(), v = merged.settings;
    saveSettings({ ...s, provider: v.provider || s.provider, apiKey: v.apiKey ?? s.apiKey, refreshSec: +v.refreshSec || s.refreshSec });
    window.dispatchEvent(new Event('settings-changed'));
  }
  if (touched.has('fav')) {
    const f = {};
    for (const type of FTYPES) {
      const order = merged[`favorder:${type}`] || [];
      const pos = new Map(order.map((k, i) => [k, i]));
      const items = Object.entries(merged).filter(([k]) => k.startsWith(`fav:${type}:`)).map(([k, v]) => [k.slice(`fav:${type}:`.length), v]);
      // voci non ancora nell'ordine (appena aggiunte altrove): in cima, come quando si aggiunge un preferito
      items.sort(([a, x], [b, y]) => (pos.get(a) ?? -1) - (pos.get(b) ?? -1) || String(y.addedAt || '').localeCompare(String(x.addedAt || '')));
      f[type] = items.map(([, v]) => v);
    }
    replaceFavorites(f);
  }
  if (touched.has('tabs') && Array.isArray(merged.tabs)) {
    const old = new Map(readJ(TKEY, []).map(t => [t.key, t]));
    const tabs = merged.tabs.filter(t => t?.key && t.hash).map(t => ({ ...(old.get(t.key) || {}), ...t }));
    try { localStorage.setItem(TKEY, JSON.stringify(tabs)); } catch { /* spazio pieno */ }
    window.dispatchEvent(new Event('tabs-remote'));
  }
  if (touched.has('watch')) {
    const want = {};
    for (const [k, v] of Object.entries(merged)) if (k.startsWith('watch:')) want[k.slice(6)] = v;
    await applyRemoteWatches(want).catch(() => {});
  }
}

// ---------- scambio con il Worker ----------
let running = null, again = false, timer = 0;

/** Sincronizza adesso (se il dispositivo è collegato). */
export function syncNow(force = true) {
  if (!isLinked() || !base()) return Promise.resolve(null);
  if (running) { again = true; return running; }
  running = (async () => {
    try { return await exchange(force); } finally {
      running = null;
      if (again) { again = false; setTimeout(() => syncNow().catch(() => {}), 500); }
    }
  })();
  return running;
}
export function syncSoon(ms = 2500) {
  if (!isLinked()) return;
  clearTimeout(timer);
  timer = setTimeout(() => syncNow(false).catch(() => {}), ms);
}

async function exchange(force) {
  const acc = syncAccount();
  const first = !acc.primed;
  const shadow = first ? {} : readJ(SHKEY, {});
  const local = localRecords(), now = Date.now(), changes = {};
  // al primo scambio prima si prendono i dati dell'account, poi si mandano solo quelli che mancano là
  if (!first) {
    for (const [k, v] of Object.entries(local)) if (!same(shadow[k], v)) changes[k] = { v, t: now };
    for (const k of Object.keys(shadow)) if (!(k in local) && cats()[catOf(k)]) changes[k] = { v: null, t: now };
  }
  // cambiamento locale che non tocca i dati sincronizzati (es. il sottotitolo di un tab): niente richiesta
  if (!force && !first && !Object.keys(changes).length) return { idle: true };
  try {
    const r = await post('/sync', { token: acc.token, since: acc.since || 0, changes, name: deviceName() });
    if (r.reset) { patchAccount({ since: 0, primed: false }); localStorage.removeItem(SHKEY); return exchange(true); }
    const remote = r.changes || {};
    await applyRemote(remote, first);
    // copia sincronizzata: quello che il Worker ha adesso (i nostri cambiamenti accettati + quelli ricevuti)
    const sh = first ? {} : { ...shadow };
    for (const [k, c] of Object.entries(changes)) { if (c.v === null) delete sh[k]; else sh[k] = c.v; }
    for (const [k, { v }] of Object.entries(remote)) { if (v === null) delete sh[k]; else if (cats()[catOf(k)]) sh[k] = v; }
    try { localStorage.setItem(SHKEY, JSON.stringify(sh)); } catch { /* spazio pieno */ }
    patchAccount({ since: r.seq || 0, primed: true, lastOk: Date.now(), lastError: null, devices: r.devices || [], me: r.me });
    // al primo scambio ora parte il secondo, con i dati che c'erano solo qui
    if (first) syncSoon(300);
    return r;
  } catch (e) {
    if (e.auth) saveAccount(null); // account cancellato o dispositivo scollegato da un altro dispositivo
    else patchAccount({ lastError: e.message, lastErrorAt: Date.now() });
    throw e;
  }
}

// ---------- collegamento ----------
function startLinked(token) {
  saveAccount({ token, since: 0, cats: cats(), linkedAt: Date.now() });
  localStorage.removeItem(SHKEY);
  return syncNow();
}
/** Primo dispositivo: crea l'account con i dati di questo browser. */
export async function createAccount() {
  const { token } = await post('/sync/new', { name: deviceName() });
  await startLinked(token);
}
/** Collega questo dispositivo con il codice mostrato da un altro (o con il codice di recupero completo). */
export async function joinAccount(code) {
  code = String(code || '').trim();
  if (/^[0-9a-f]{32}\.[0-9a-f]{48}$/.test(code)) {
    // codice di recupero: provo che sia valido prima di salvarlo
    await post('/sync/devices', { token: code });
    return startLinked(code);
  }
  const { token } = await post('/sync/join', { code, name: deviceName() });
  return startLinked(token);
}
/** Codice di 8 caratteri (valido 10 minuti) per collegare un altro dispositivo. */
export async function pairingCode() {
  const r = await post('/sync/pair', { token: syncAccount().token });
  return { ...r, link: `${location.origin}${location.pathname}#/collega?c=${r.code}&w=${encodeURIComponent(base())}` };
}
export async function listDevices() {
  const r = await post('/sync/devices', { token: syncAccount().token });
  patchAccount({ devices: r.devices, me: r.me, devAt: Date.now() });
  return r;
}
export async function removeDevice(id) {
  await post('/sync/remove', { token: syncAccount().token, id });
  if (id === syncAccount()?.me) saveAccount(null);
}
/** Scollega solo questo dispositivo (i dati restano qui e sull'account). */
export async function unlinkThis() {
  const a = syncAccount();
  if (a?.me) await post('/sync/remove', { token: a.token, id: a.me }).catch(() => {});
  saveAccount(null);
  localStorage.removeItem(SHKEY);
}
/** Cancella l'account dal Worker (tutti i dispositivi vengono scollegati; i dati restano nei browser). */
export async function wipeAccount() {
  await post('/sync/wipe', { token: syncAccount().token });
  saveAccount(null);
  localStorage.removeItem(SHKEY);
}
export function setCats(c) {
  // cambiano le categorie: si riparte con uno scambio completo, così arriva quello che era stato escluso
  patchAccount({ cats: c, since: 0, primed: false });
  localStorage.removeItem(SHKEY);
  return syncNow();
}

// ---------- anelli condivisi della catena dei voli (volo → volo precedente) ----------
// Lettura per tutti i dispositivi con il Worker; scrittura solo da quelli collegati a un account.
const linkMiss = new Map();
export async function sharedLink(key) {
  if (!base() || (linkMiss.get(key) || 0) > Date.now()) return null;
  try {
    const r = await fetch(`${base()}/links?k=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    const v = j.links?.[key] || null;
    if (!v) linkMiss.set(key, Date.now() + 2 * 60e3);
    return v;
  } catch { linkMiss.set(key, Date.now() + 60e3); return null; }
}
let linkQueue = {}, linkTimer = 0;
export function shareLink(key, entry) {
  if (!isLinked() || !base()) return;
  linkQueue[key] = entry;
  linkMiss.delete(key);
  clearTimeout(linkTimer);
  linkTimer = setTimeout(() => {
    const links = linkQueue; linkQueue = {};
    post('/links', { token: syncAccount()?.token, links }, 8000).catch(() => {});
  }, 2000);
}

// ---------- avvio ----------
export function initSync() {
  window.addEventListener('aerei-local-change', () => syncSoon());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow().catch(() => {}); });
  setInterval(() => { if (document.visibilityState === 'visible') syncNow().catch(() => {}); }, PULL_MS);
  setTimeout(() => syncNow().catch(() => {}), 800);
}
