// Notifiche sui voli seguiti (Web Push tramite il Cloudflare Worker).
// Il Worker controlla i voli ogni 2 minuti anche ad app chiusa e manda la notifica al dispositivo.
import { getSettings } from './store.js';
import { OFFICIAL_AIRPORTS } from './api.js';

const WKEY = 'aerei.watches.v1';
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
const saveLocal = w => localStorage.setItem(WKEY, JSON.stringify(w));
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
  const sub = await subscription(true);
  const s = getSettings();
  const flight = flightBody(f, inbound, inboundGuess);
  if (!flight.date || !flight.dep) throw new Error('Mancano data o aeroporto di partenza del volo.');
  const r = await post('/push/watch', { sub: sub.toJSON(), flight, events, adbKey: useKey ? s.apiKey : '' });
  const all = localWatches();
  all[watchKey(flight.number, flight.date, flight.dep)] = { id: r.id, events, arr: flight.arr, inbound: inbound?.number || null, useKey, at: Date.now() };
  saveLocal(all);
  return r;
}

/** Aggiorna in silenzio un volo già seguito (es. è cambiato il volo precedente o l'orario). */
export async function refreshWatch(f, inbound, inboundGuess) {
  const w = getWatch(f.number, (f.dep?.sched?.local || '').slice(0, 10), f.dep?.iata);
  if (!w || pushProblem()) return;
  const sub = await subscription(false);
  if (!sub) return;
  await post('/push/watch', { sub: sub.toJSON(), flight: flightBody(f, inbound, inboundGuess), events: w.events, adbKey: w.useKey ? getSettings().apiKey : '' }).catch(() => {});
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
  const sub = await subscription(false);
  if (!sub) return [];
  const { watches } = await post('/push/list', { endpoint: sub.endpoint });
  // allineo l'elenco locale: i voli conclusi il Worker li toglie da solo
  const all = localWatches(), ids = new Set(watches.map(w => w.id));
  for (const [k, v] of Object.entries(all)) if (!ids.has(v.id)) delete all[k];
  saveLocal(all);
  return watches;
}

export async function testPush() {
  const sub = await subscription(true);
  return post('/push/test', { sub: sub.toJSON() });
}
