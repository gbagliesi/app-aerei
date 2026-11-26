// Notifiche sui voli seguiti (Web Push tramite il Cloudflare Worker).
// Il Worker controlla i voli ogni 2 minuti anche ad app chiusa e manda la notifica al dispositivo.
import { getSettings } from './store.js';
import { OFFICIAL_AIRPORTS } from './api.js';

const WKEY = 'aerei.watches.v1';
// endpoint dell'iscrizione push con cui QUESTO dispositivo ha registrato i voli sul Worker (mai sincronizzato:
// ogni dispositivo ha la sua iscrizione, gli altri dispositivi ricevono solo il volo e gli eventi)
const EPKEY = 'aerei.pushep.v1';
// iscrizione morta secondo il servizio push (anche con un Worker non ancora aggiornato, che dà solo lo stato 404/410)
const isGone = r => !!r && (r.gone || r.push?.status === 404 || r.push?.status === 410);
const setEp = ep => { try { localStorage.setItem(EPKEY, ep); } catch { /* spazio pieno */ } };
export const EVENT_LABELS = {
  inbound: 'Atterraggio dell’aereo in arrivo (volo precedente)',
  inboundDep: 'Decollo dell’aereo in arrivo',
  gate: 'Gate assegnato e cambi gate',
  boarding: 'Inizio imbarco / gate chiuso',
  delay: 'Ritardi (variazioni di 10 min o più)',
  departed: 'Decollo',
  landed: 'Atterraggio',
  belt: 'Nastro bagagli',
  cancel: 'Cancellazione o dirottamento',
};
export const DEFAULT_EVENTS = ['inbound', 'gate', 'boarding', 'delay', 'departed', 'landed', 'cancel'];

const base = () => (getSettings().workerUrl || '').trim().replace(/\/+$/, '');
const watchKey = (number, date, dep) => `${number}|${date}|${dep}`;
export const localWatches = () => { try { return JSON.parse(localStorage.getItem(WKEY)) || {}; } catch { return {}; } };
const saveLocal = w => { localStorage.setItem(WKEY, JSON.stringify(w)); window.dispatchEvent(new Event('aerei-local-change')); };
export const getWatch = (number, date, dep) => localWatches()[watchKey(number, date, dep)] || null;

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/** Perché le notifiche non si possono attivare qui (null = si può). */
export function pushProblem() {
  if (getSettings().provider !== 'aerodatabox') return 'Le notifiche funzionano solo con i dati reali (non in modalità demo).';
  if (!base()) return 'Serve l’indirizzo del Worker in Impostazioni: è il Worker che controlla i voli e manda le notifiche.';
  if (isIOS() && !standalone()) return 'Su iPhone e iPad le notifiche arrivano solo dall’app installata: in Safari tocca Condividi → “Aggiungi alla schermata Home”, apri l’app da lì e attiva le notifiche (serve iOS 16.4 o successivo).';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'Questo browser non supporta le notifiche push.';
  if (Notification.permission === 'denied') return 'Le notifiche per questo sito sono bloccate: riattivale nelle impostazioni del browser (o del telefono) e riprova.';
  return null;
}

const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
async function post(path, body) {
  const r = await fetch(`${base()}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Worker: errore ${r.status}`);
  return j;
}

/** Iscrizione push di questo dispositivo (la crea se manca, chiedendo il permesso). */
export async function subscription(create = true) {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub || !create) return sub;
  if (Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted') throw new Error('Permesso per le notifiche non concesso.');
  const r = await fetch(`${base()}/push/key`);
  const { key, error } = await r.json().catch(() => ({}));
  if (!key) throw new Error(error || `Il Worker non ha risposto (${r.status}): forse non è ancora aggiornato con le notifiche.`);
  sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(key) });
  return sub;
}

const loc = t => t?.local ? t.local.replace(' ', 'T').slice(0, 16) : null;
function flightBody(f, inbound, inboundGuess) {
  return {
    number: f.number, date: (f.dep?.sched?.local || '').slice(0, 10), dep: f.dep?.iata, arr: f.arr?.iata || null,
    depSched: f.dep?.sched?.utc || null, arrSched: f.arr?.sched?.utc || null,
    // orari locali per riconoscere la riga nei tabelloni ufficiali
    depLocal: loc(f.dep?.sched), arrLocal: loc(f.arr?.sched),
    offDep: !!OFFICIAL_AIRPORTS[f.dep?.iata], offArr: !!OFFICIAL_AIRPORTS[f.arr?.iata],
    known: knownState(f, inbound),
    inbound: inbound ? { number: inbound.number, dep: inbound.dep?.iata, date: (inbound.dep?.sched?.local || '').slice(0, 10) || null,
      depSched: inbound.dep?.sched?.utc || null, arrSched: inbound.arr?.sched?.utc || null, depLocal: loc(inbound.dep?.sched), arrLocal: loc(inbound.arr?.sched),
      offDep: !!OFFICIAL_AIRPORTS[inbound.dep?.iata], guess: !!inboundGuess } : null,
  };
}

const AIR = ['Departed', 'EnRoute', 'Approaching', 'Arrived', 'Diverted'];
const mins = (a, b) => a?.utc && b?.utc ? Math.round((Date.parse(b.utc) - Date.parse(a.utc)) / 60e3) : undefined;
// Quello che l'app vede già: il Worker notificherà solo i cambiamenti rispetto a questo
function knownState(f, inb) {
  return {
    gate: f.dep?.gate || null, belt: f.arr?.belt || null, boarding: ['Boarding', 'GateClosed'].includes(f.status),
    departed: AIR.includes(f.status) || !!f.dep?.actual, landed: f.status === 'Arrived' || !!f.arr?.actual, canceled: f.status === 'Canceled',
    depDelay: mins(f.dep?.sched, f.dep?.revised),
    inboundDeparted: !!inb && (AIR.includes(inb.status) || !!inb.dep?.actual), inboundLanded: !!inb && (inb.status === 'Arrived' || !!inb.arr?.actual),
  };
}

/** Attiva (o aggiorna) le notifiche per un volo. */
export async function watchFlight(f, inbound, inboundGuess, events, useKey = true) {
  let sub = await subscription(true);
  const s = getSettings();
  const flight = flightBody(f, inbound, inboundGuess);
  if (!flight.date || !flight.dep) throw new Error('Mancano data o aeroporto di partenza del volo.');
  const body = () => ({ sub: sub.toJSON(), flight, events, adbKey: useKey ? s.apiKey : '' });
  let r = await post('/push/watch', body());
  if (isGone(r)) {
    // il servizio push (Apple/Google/Mozilla) dice che l'iscrizione di questo dispositivo non vale più:
    // ne creo una nuova, riregistro gli altri voli seguiti qui e riprovo questo (con la notifica di conferma)
    sub = await renewSubscription({ fresh: true, except: watchKey(flight.number, flight.date, flight.dep) });
    r = await post('/push/watch', body());
    if (isGone(r)) throw new Error('Il servizio di notifiche del browser rifiuta anche l’iscrizione nuova: controlla i permessi di notifica del sito.');
    r.renewed = true;
  }
  setEp(sub.endpoint);
  const all = localWatches();
  // flight: serve agli altri dispositivi dell'account per seguire lo stesso volo (sync.js)
  all[watchKey(flight.number, flight.date, flight.dep)] = { id: r.id, events, arr: flight.arr, inbound: inbound?.number || null, useKey, at: Date.now(), flight };
  saveLocal(all);
  return r;
}

/** Aggiorna in silenzio un volo già seguito (es. è cambiato il volo precedente o l'orario). */
export async function refreshWatch(f, inbound, inboundGuess) {
  const w = getWatch(f.number, (f.dep?.sched?.local || '').slice(0, 10), f.dep?.iata);
  if (!w || pushProblem()) return;
  const sub = await subscription(false);
  if (!sub) return;
  const flight = flightBody(f, inbound, inboundGuess);
  const r = await post('/push/watch', { sub: sub.toJSON(), flight, events: w.events, adbKey: w.useKey ? getSettings().apiKey : '' }).catch(() => null);
  if (isGone(r)) renewSubscription({ fresh: true }).catch(() => {});
  // tengo aggiornato il volo salvato (lo usano gli altri dispositivi), senza lo stato del momento che cambia di continuo
  const all = localWatches(), k = watchKey(flight.number, flight.date, flight.dep);
  if (all[k] && JSON.stringify({ ...all[k].flight, known: null }) !== JSON.stringify({ ...flight, known: null })) { all[k].flight = flight; saveLocal(all); }
}

export async function unwatch(number, date, dep, id) {
  const all = localWatches();
  const k = watchKey(number, date, dep);
  id = id || all[k]?.id;
  delete all[k];
  saveLocal(all);
  const sub = await subscription(false).catch(() => null);
  if (sub && id) await post('/push/unwatch', { endpoint: sub.endpoint, id });
}

/** Voli seguiti da questo dispositivo secondo il Worker (con le ultime notifiche mandate). */
export async function listWatches() {
  await checkPush();
  const sub = await subscription(false);
  if (!sub) return [];
  const { watches, gone } = await post('/push/list', { endpoint: sub.endpoint });
  if (gone) return [];   // rinnovo non riuscito (es. permesso tolto): non cancello i voli locali
  // allineo l'elenco locale: i voli conclusi il Worker li toglie da solo
  const all = localWatches(), ids = new Set(watches.map(w => w.id));
  for (const [k, v] of Object.entries(all)) if (v.id && !ids.has(v.id)) delete all[k];
  saveLocal(all);
  return watches;
}

export async function testPush() {
  let sub = await subscription(true);
  let r = await post('/push/test', { sub: sub.toJSON() });
  if (isGone(r)) { sub = await renewSubscription({ fresh: true }); r = await post('/push/test', { sub: sub.toJSON() }); r.renewed = true; }
  return r;
}

// ---------- iscrizione push scaduta o cambiata ----------
let renewing = null;
/**
 * Crea (se fresh, dopo aver tolto quella vecchia) l'iscrizione push di questo dispositivo e riregistra sul Worker,
 * in silenzio, tutti i voli seguiti qui (tranne "except"). Toglie dal Worker l'iscrizione precedente, se diversa.
 */
export function renewSubscription({ fresh = false, except = null } = {}) {
  if (!renewing) renewing = (async () => {
    const reg = await navigator.serviceWorker.ready;
    if (fresh) { const cur = await reg.pushManager.getSubscription(); if (cur) await cur.unsubscribe().catch(() => {}); }
    const sub = await subscription(true);
    const oldEp = localStorage.getItem(EPKEY);
    if (oldEp && oldEp !== sub.endpoint) await post('/push/drop', { endpoint: oldEp }).catch(() => {});
    const all = localWatches(), today = new Date(Date.now() - 36 * 3600e3).toISOString().slice(0, 10);
    let n = 0;
    for (const [k, w] of Object.entries(all)) {
      if (!w.id || k === except) continue;
      // senza il volo salvato (voli seguiti prima della 4.21) o già passati: non si possono riregistrare
      if (!w.flight || (w.flight.date || '') < today) { delete all[k]; continue; }
      try {
        const r = await post('/push/watch', { sub: sub.toJSON(), flight: w.flight, events: w.events, adbKey: w.useKey !== false ? getSettings().apiKey : '', quiet: true });
        w.id = r.id; delete w.pending; n++;
      } catch { delete w.id; w.pending = true; }
    }
    saveLocal(all);
    setEp(sub.endpoint);
    console.info(`[notifiche] iscrizione push rinnovata, ${n} voli riregistrati`);
    return sub;
  })().finally(() => { renewing = null; });
  return renewing;
}

/**
 * Controllo all'avvio (solo se qui ci sono voli seguiti e le notifiche sono già permesse): se il browser ha cambiato
 * o perso l'iscrizione, o il Worker sa che è morta, ne creo una nuova e riregistro i voli. Nessuna richiesta di permesso.
 */
export async function checkPush() {
  if (pushProblem() || !('Notification' in window) || Notification.permission !== 'granted') return;
  if (!Object.values(localWatches()).some(w => w.id)) return;
  const cur = await subscription(false).catch(() => null);
  const ep = localStorage.getItem(EPKEY);
  if (!cur || (ep && cur.endpoint !== ep)) { await renewSubscription(); return; }
  const r = await post('/push/list', { endpoint: cur.endpoint }).catch(() => null);
  if (r?.gone) await renewSubscription({ fresh: true });
  else if (r && !ep) setEp(cur.endpoint);
}

// ---------- voli seguiti da altri dispositivi dello stesso account (sync.js) ----------
/** Notifiche già permesse qui (nessuna richiesta di permesso: si attivano senza chiedere). */
async function silentSub() {
  if (pushProblem() || Notification.permission !== 'granted') return null;
  return subscription(false).catch(() => null);
}

/**
 * Allinea i voli seguiti con quelli dell'account. want = { "numero|data|partenza": { flight, events, useKey } }.
 * I voli nuovi si attivano su questo dispositivo se qui le notifiche sono già permesse, altrimenti restano
 * "in attesa" (pending) finché non si attivano le notifiche; quelli tolti altrove si tolgono anche qui.
 */
export async function applyRemoteWatches(want) {
  const all = localWatches(), sub = await silentSub();
  let dirty = false, gone = false;
  for (const [k, w] of Object.entries(all)) {
    if (want[k] || !w.flight) continue;   // senza "flight" sono voli seguiti prima della sincronizzazione: restano
    if (w.id && sub) await post('/push/unwatch', { endpoint: sub.endpoint, id: w.id }).catch(() => {});
    delete all[k]; dirty = true;
  }
  for (const [k, v] of Object.entries(want)) {
    const cur = all[k];
    if (cur && cur.id && JSON.stringify(cur.events) === JSON.stringify(v.events)) continue;
    const entry = { ...(cur || {}), events: v.events, arr: v.flight?.arr || null, inbound: v.flight?.inbound?.number || null, useKey: v.useKey !== false, flight: v.flight, at: cur?.at || Date.now() };
    if (sub && v.flight) {
      try {
        const r = await post('/push/watch', { sub: sub.toJSON(), flight: v.flight, events: v.events, adbKey: entry.useKey ? getSettings().apiKey : '', quiet: true });
        if (isGone(r)) { entry.pending = true; gone = true; } else { entry.id = r.id; delete entry.pending; setEp(sub.endpoint); }
      } catch { entry.pending = true; }
    } else if (!cur?.id) entry.pending = true;
    all[k] = entry; dirty = true;
  }
  if (dirty) saveLocal(all);
  // iscrizione morta: ne creo una nuova e attivo i voli rimasti in attesa
  if (gone) await renewSubscription({ fresh: true }).then(() => activatePending()).catch(() => {});
}

/** Voli seguiti su altri dispositivi ma non ancora attivi qui. */
export const pendingWatches = () => Object.entries(localWatches()).filter(([, w]) => w.pending || !w.id).map(([k, w]) => ({ k, ...w }));

/** Attiva qui le notifiche dei voli seguiti dagli altri dispositivi (chiede il permesso se serve). */
export async function activatePending(retry = true) {
  const sub = await subscription(true);
  const all = localWatches();
  let n = 0;
  for (const [k, w] of Object.entries(all)) {
    if (w.id || !w.flight) continue;
    const r = await post('/push/watch', { sub: sub.toJSON(), flight: w.flight, events: w.events, adbKey: w.useKey !== false ? getSettings().apiKey : '', quiet: true });
    if (isGone(r)) {
      saveLocal(all);
      if (!retry) throw new Error('Il servizio di notifiche del browser rifiuta l’iscrizione: controlla i permessi di notifica del sito.');
      await renewSubscription({ fresh: true });
      return n + await activatePending(false);
    }
    all[k] = { ...w, id: r.id }; delete all[k].pending; n++;
    setEp(sub.endpoint);
  }
  saveLocal(all);
  return n;
}
