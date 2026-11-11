// Livello dati: provider "demo" (dati simulati) o "aerodatabox" (dati reali via RapidAPI),
// più il tracking live della posizione dell'aereo (AeroDataBox / adsb.lol / OpenSky).
import { getSettings } from './store.js';
import { airportByIata, AIRPORTS, iataByCityName } from './airports.js';
import * as demo from './demo.js';
import { simulateRotation, arrTime } from './rotation.js';

const ADB_HOST = 'aerodatabox.p.rapidapi.com';
const cache = new Map();

const inflight = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  // una sola richiesta alla volta per la stessa chiave
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => { try { const v = await fn(); cache.set(key, { t: Date.now(), v }); return v; } finally { inflight.delete(key); } })();
  inflight.set(key, p);
  return p;
}

// ---------- risparmio unità AeroDataBox ----------
// Le risposte di AeroDataBox restano salvate nel browser (anche dopo un ricaricamento) per qualche minuto,
// così aprire più volte lo stesso tabellone o volo non consuma unità del piano.
const PKEY = 'aerei.adbcache.';
const BKEY = 'aerei.adbBlocked';
function pget(k, ttl) {
  try { const x = JSON.parse(localStorage.getItem(PKEY + k)); return x && Date.now() - x.t < ttl ? x.v : undefined; } catch { return undefined; }
}
function pput(k, v) {
  const val = JSON.stringify({ t: Date.now(), v });
  for (let i = 0; i < 20; i++) {
    try { localStorage.setItem(PKEY + k, val); return; } catch {
      // spazio finito: elimino la voce più vecchia e riprovo
      const keys = Object.keys(localStorage).filter(x => x.startsWith(PKEY));
      if (!keys.length) return;
      let oldest = keys[0], ot = Infinity;
      for (const x of keys) { try { const t = JSON.parse(localStorage.getItem(x)).t; if (t < ot) { ot = t; oldest = x; } } catch { oldest = x; break; } }
      localStorage.removeItem(oldest);
    }
  }
}
/** Se la quota è finita non chiamo più AeroDataBox per qualche ora (ogni chiamata fallita è inutile). */
export function adbBlocked() {
  try { const b = JSON.parse(localStorage.getItem(BKEY)); return b && Date.now() < b.until ? b : null; } catch { return null; }
}
export const clearAdbBlock = () => localStorage.removeItem(BKEY);
const QUOTA_MSG = 'Hai esaurito le unità mensili del tuo piano AeroDataBox su RapidAPI: si azzerano alla data di rinnovo mensile dell’abbonamento. Per Fiumicino, Ciampino, Pisa, Firenze, Bari, Brindisi, Foggia, Taranto, Milano, Bologna, Catania, Palermo, Ginevra, Zurigo, Francoforte, Monaco, Torino, Cagliari, Madrid, Barcellona, Lisbona, Londra (Gatwick, Stansted, Luton, City), Lione, Parigi Beauvais, Amsterdam, Genova, Venezia e Hong Kong il tabellone arriva comunque dai siti ufficiali.';

/** Chiamata AeroDataBox con cache persistente (ttlMs). */
async function adbCached(path, ttlMs) {
  const hit = pget(path, ttlMs);
  if (hit !== undefined) return hit;
  const v = await adb(path);
  pput(path, v);
  return v;
}

async function adb(path, key = getSettings().apiKey, force = false) {
  const apiKey = (key || '').trim();
  if (!apiKey) throw new Error('Manca la chiave API AeroDataBox: aggiungila in Impostazioni.');
  const blk = !force && adbBlocked();
  if (blk) throw new Error(blk.msg);
  let res;
  try {
    res = await fetch(`https://${ADB_HOST}${path}`, { headers: { 'X-RapidAPI-Key': apiKey, 'X-RapidAPI-Host': ADB_HOST } });
  } catch { throw new Error('Impossibile contattare AeroDataBox: controlla la connessione.'); }
  if (res.status === 204) return null;
  if (res.ok) return res.json();
  let msg = '';
  try { const b = await res.json(); msg = b.message || b.error || ''; } catch { /* corpo non JSON */ }
  const m = msg.toLowerCase();
  let hint;
  if (m.includes('not subscribed')) hint = 'La chiave è giusta ma non sei iscritto ad AeroDataBox: su RapidAPI apri AeroDataBox → Pricing e premi Subscribe sul piano Basic.';
  else if (m.includes('invalid api key') || res.status === 401) hint = 'Chiave non riconosciuta: ricopiala dalla riga X-RapidAPI-Key, senza spazi o caratteri in più.';
  else if (m.includes('monthly') || (m.includes('quota') && !m.includes('second'))) {
    localStorage.setItem(BKEY, JSON.stringify({ until: Date.now() + 6 * 3600e3, msg: QUOTA_MSG }));
    throw new Error(QUOTA_MSG);
  }
  else if (res.status === 429 || m.includes('rate limit')) hint = 'Troppe richieste in poco tempo: riprova tra qualche secondo.';
  else if (m.includes('tier') || m.includes('plan')) hint = 'Questa funzione non è inclusa nel tuo piano AeroDataBox.';
  else hint = `Errore API (${res.status}).`;
  throw new Error(`${hint}${msg ? ` [RapidAPI: "${msg}"]` : ''}`);
}

/** Verifica una chiave con una chiamata leggera. */
export async function testKey(key) {
  await adb('/airports/iata/FCO', key, true);
  clearAdbBlock();
  const fids = await adb('/flights/airports/iata/FCO?offsetMinutes=0&durationMinutes=60&withLeg=false&direction=Departure', key, true);
  return (fids?.departures || []).length;
}

const isDemo = () => getSettings().provider !== 'aerodatabox';

// ---------- normalizzazione AeroDataBox ----------
const fixTime = t => t && { utc: t.utc?.replace(' ', 'T'), local: t.local };

function normMovement(m, fallbackAirport) {
  if (!m) return {};
  const ap = m.airport || fallbackAirport || {};
  return {
    iata: ap.iata, icao: ap.icao, name: ap.shortName || ap.municipalityName || ap.name,
    lat: ap.location?.lat, lon: ap.location?.lon,
    sched: fixTime(m.scheduledTime), revised: fixTime(m.revisedTime || m.predictedTime),
    actual: fixTime(m.runwayTime),
    terminal: m.terminal, gate: m.gate, checkIn: m.checkInDesk, belt: m.baggageBelt,
  };
}

function normLocation(l) {
  if (!l || l.lat == null) return null;
  return {
    lat: l.lat, lon: l.lon, alt: l.altitude?.feet ?? l.pressureAltitude?.feet,
    gs: l.groundSpeed?.kt, track: l.trueTrack?.deg, at: l.reportedAtUtc?.replace(' ', 'T'), source: 'AeroDataBox',
  };
}

function normFlight(f, dir, own) {
  let dep, arr;
  if (f.departure || f.arrival) {
    dep = normMovement(f.departure, dir === 'dep' ? own : undefined);
    arr = normMovement(f.arrival, dir === 'arr' ? own : undefined);
  } else if (f.movement) {
    const ownSide = { ...normMovement(f.movement, own), ...ownInfo(own) };
    const other = { iata: f.movement.airport?.iata, icao: f.movement.airport?.icao, name: f.movement.airport?.name };
    if (dir === 'dep') { dep = ownSide; arr = other; } else { arr = ownSide; dep = other; }
  }
  return {
    number: (f.number || '').replace(/\s+/g, ''),
    callSign: f.callSign,
    airline: { name: f.airline?.name, iata: f.airline?.iata },
    status: f.status || 'Unknown',
    isCargo: f.isCargo,
    codeshareStatus: f.codeshareStatus,
    aircraft: { reg: f.aircraft?.reg, hex: f.aircraft?.modeS?.toLowerCase(), model: f.aircraft?.model },
    dep, arr,
    location: normLocation(f.location),
    _adb: true,
  };
}
const ownInfo = own => own ? { iata: own.iata, icao: own.icao, name: own.name } : {};


// ---------- tabelloni ufficiali via Cloudflare Worker ----------
// (Fiumicino, Ciampino, Pisa, Firenze, Puglia, Milano, Bologna, Catania, Palermo, Ginevra, Zurigo, Francoforte, Monaco)
export const OFFICIAL_AIRPORTS = {
  PSA: 'Europe/Rome', FLR: 'Europe/Rome', FCO: 'Europe/Rome', CIA: 'Europe/Rome', BRI: 'Europe/Rome', BDS: 'Europe/Rome', FOG: 'Europe/Rome', TAR: 'Europe/Rome',
  MXP: 'Europe/Rome', LIN: 'Europe/Rome', BLQ: 'Europe/Rome', CTA: 'Europe/Rome', PMO: 'Europe/Rome',
  GVA: 'Europe/Zurich', ZRH: 'Europe/Zurich', FRA: 'Europe/Berlin', MUC: 'Europe/Berlin',
  MAD: 'Europe/Madrid', BCN: 'Europe/Madrid', LIS: 'Europe/Lisbon', TRN: 'Europe/Rome', CAG: 'Europe/Rome',
  STN: 'Europe/London', LGW: 'Europe/London', LTN: 'Europe/London', LCY: 'Europe/London', LYS: 'Europe/Paris', BVA: 'Europe/Paris', AMS: 'Europe/Amsterdam', GOA: 'Europe/Rome', VCE: 'Europe/Rome', HKG: 'Asia/Hong_Kong',
  TFS: 'Atlantic/Canary', TFN: 'Atlantic/Canary', LPA: 'Atlantic/Canary', ACE: 'Atlantic/Canary', FUE: 'Atlantic/Canary', VLC: 'Europe/Madrid',
  MAN: 'Europe/London', EDI: 'Europe/London', DUB: 'Europe/Dublin', HAM: 'Europe/Berlin', BER: 'Europe/Berlin', CGN: 'Europe/Berlin',
  ARN: 'Europe/Stockholm', VIE: 'Europe/Vienna', PRG: 'Europe/Prague', BUD: 'Europe/Budapest', WAW: 'Europe/Warsaw', KRK: 'Europe/Warsaw',
  SKG: 'Europe/Athens', CHQ: 'Europe/Athens', LCA: 'Asia/Nicosia', PFO: 'Asia/Nicosia', MLA: 'Europe/Malta', ZAG: 'Europe/Zagreb', DBV: 'Europe/Zagreb', SXB: 'Europe/Paris', BSL: 'Europe/Paris', STR: 'Europe/Berlin',
  CIY: 'Europe/Rome', TPS: 'Europe/Rome', AOI: 'Europe/Rome', TRS: 'Europe/Rome', VRN: 'Europe/Rome', TSF: 'Europe/Rome', SUF: 'Europe/Rome', REG: 'Europe/Rome', CRV: 'Europe/Rome',
};
// Da dove arriva il tabellone ufficiale di ogni aeroporto (mostrato nella pagina come fonte)
export const OFFICIAL_SOURCES = {
  PSA: 'pisa-airport.com (Toscana Aeroporti)', FLR: 'firenze-airport.it (Toscana Aeroporti)',
  FCO: 'adr.it (Aeroporti di Roma)', CIA: 'adr.it (Aeroporti di Roma)',
  BRI: 'app Aeroporti di Puglia', BDS: 'app Aeroporti di Puglia', FOG: 'app Aeroporti di Puglia', TAR: 'app Aeroporti di Puglia',
  MXP: 'milanomalpensa-airport.com (SEA)', LIN: 'milanolinate-airport.com (SEA)', BLQ: 'bologna-airport.it',
  CTA: 'aeroporto.catania.it', PMO: 'aeroportodipalermo.it', GVA: 'app Genève Aéroport', ZRH: 'flughafen-zuerich.ch',
  FRA: 'frankfurt-airport.com', MUC: 'munich-airport.de',
  MAD: 'aena.es', BCN: 'aena.es', LIS: 'aeroportolisboa.pt (ANA)', TRN: 'aeroportoditorino.it', CAG: 'sogaer.it',
  STN: 'stanstedairport.com', LGW: 'gatwickairport.com', LTN: 'london-luton.co.uk', LCY: 'londoncityairport.com',
  LYS: 'lyonaeroports.com', BVA: 'aeroportparisbeauvais.com', AMS: 'Schiphol Public Flight API', GOA: 'airport.genova.it', VCE: 'veneziaairport.it', HKG: 'hongkongairport.com (open data)',
  TFS: 'aena.es', TFN: 'aena.es', LPA: 'aena.es', ACE: 'aena.es', FUE: 'aena.es', VLC: 'aena.es', MAN: 'manchesterairport.co.uk',
  HAM: 'hamburg-airport.de', BER: 'ber.berlin-airport.de', ARN: 'swedavia.com', VIE: 'viennaairport.com', PRG: 'prg.aero', DUB: 'dublinairport.com',
  EDI: 'edinburghairport.com', CGN: 'koeln-bonn-airport.de', BUD: 'bud.hu', SKG: 'skg-airport.gr (Fraport Greece)', CHQ: 'chq-airport.gr (Fraport Greece)',
  WAW: 'lotnisko-chopina.pl', KRK: 'krakowairport.pl', LCA: 'hermesairports.com', PFO: 'hermesairports.com', MLA: 'maltairport.com',
  ZAG: 'zagreb-airport.hr', DBV: 'dbv.hr', SXB: 'strasbourg.aeroport.fr', BSL: 'euroairport.com', STR: 'stuttgart-airport.com',
  CIY: 'aeroportodicomiso.eu (SAC, come Catania)', TPS: 'airgest.it', AOI: 'ancona-airport.com', TRS: 'triesteairport.it',
  VRN: 'aeroportoverona.it (SAVE)', TSF: 'trevisoairport.it (SAVE)',
  SUF: 'sacal.it', REG: 'sacal.it', CRV: 'sacal.it',
};

export async function getOfficial(iata, nature, workerUrl = getSettings().workerUrl) {
  const base = (workerUrl || '').trim().replace(/\/+$/, '');
  if (!base || !OFFICIAL_AIRPORTS[iata]) return null;
  return cached(`off:${base}:${iata}:${nature}`, 90e3, async () => {
    const r = await fetch(`${base}/board?airport=${iata}&nature=${nature}`);
    if (!r.ok) throw new Error(`Worker: errore ${r.status}`);
    const j = await r.json();
    return j.flights || [];
  });
}

const tzOffset = (tz, dateStr) => {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(new Date(`${dateStr}T12:00:00Z`));
    const v = p.find(x => x.type === 'timeZoneName')?.value || 'GMT+01:00';
    return v === 'GMT' ? '+00:00' : v.replace('GMT', '');
  } catch { return '+01:00'; }
};

/** Data e ora locali complete "YYYY-MM-DDTHH:MM" → oggetto tempo. */
function localToTime(v, tz) {
  if (!v || !/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(v)) return null;
  const d = v.slice(0, 10), hm = v.slice(11, 16), o = tzOffset(tz, d);
  return { local: `${d} ${hm}${o}`, utc: new Date(`${d}T${hm}:00${o}`).toISOString() };
}

/** Orario ufficiale "HH:MM" → oggetto tempo, nello stesso giorno dell'orario programmato (o il giorno dopo). */
function clockToTime(hhmm, ref, tz) {
  if (!hhmm || !ref?.local) return null;
  const date = ref.local.slice(0, 10), refHM = ref.local.slice(11, 16);
  let d = date;
  const mins = s => +s.slice(0, 2) * 60 + +s.slice(3, 5);
  if (mins(hhmm) - mins(refHM) < -12 * 60) d = isoDate(new Date(new Date(`${date}T12:00:00`).getTime() + 86400e3));
  else if (mins(hhmm) - mins(refHM) > 12 * 60) d = isoDate(new Date(new Date(`${date}T12:00:00`).getTime() - 86400e3));
  const o = tzOffset(tz, d);
  return { local: `${d} ${hhmm}${o}`, utc: new Date(`${d}T${hhmm}:00${o}`).toISOString() };
}

function mapStatus(t) {
  t = (t || '').toLowerCase();
  if (!t) return null;
  if (/cancel|annul|soppress/.test(t)) return 'Canceled';
  if (/dirott|divert|dérout/.test(t)) return 'Diverted';
  if (/atterr|landed|arrived|arrivato|atterri/.test(t)) return 'Arrived';
  if (/in arrivo|avvicin|approach/.test(t)) return 'Approaching';
  if (/in volo|en ?route|airborne|flying|en vol/.test(t)) return 'EnRoute';
  if (/decoll|partito|departed|parti|airborne|take ?off/.test(t)) return 'Departed';
  if (/chius|closed|fermé|ferme/.test(t)) return 'GateClosed';
  if (/imbarco|boarding|embarq|ultima chiamata|gate aperto|last call/.test(t)) return 'Boarding';
  if (/ritard|delay|retard/.test(t)) return 'Delayed';
  if (/check/.test(t)) return 'CheckIn';
  return null;
}

/** Arricchisce i voli AeroDataBox con i dati ufficiali dell'aeroporto (gate, orari stimati, stato, marche). */
function mergeOfficial(flights, official, sideKey, iata, used = null) {
  if (!official?.length) return flights;
  const tz = OFFICIAL_AIRPORTS[iata];
  // stessa sigla in giorni diversi (alcuni tabelloni coprono più giorni): scelgo la riga con l'orario
  // programmato più vicino, entro 12 ore, altrimenti non abbino
  const byNum = new Map();
  for (const o of official) for (const n of [o.number, ...(o.codeshare || [])]) { if (!byNum.has(n)) byNum.set(n, []); byNum.get(n).push(o); }
  const offMs = o => o.schedDate ? Date.parse(`${o.schedDate.slice(0, 10)}T${o.schedDate.slice(11, 16)}:00${tzOffset(tz, o.schedDate.slice(0, 10))}`) : NaN;
  const pick = (rows, ref) => {
    if (!rows?.length) return null;
    const t = Date.parse(ref?.utc || '');
    if (isNaN(t)) return rows.length === 1 ? rows[0] : null;
    let best = null, bd = 12 * 3600e3;
    for (const o of rows) { const d = Math.abs(offMs(o) - t); if (isNaN(d) ? rows.length === 1 && !best : d <= bd) { best = o; if (!isNaN(d)) bd = d; } }
    return best;
  };
  for (const f of flights) {
    const side = f[sideKey];
    if (!side || side.iata !== iata) continue;
    const o = pick(byNum.get(f.number), side.sched) || (f.codeshares || []).map(n => pick(byNum.get(n), side.sched)).find(Boolean);
    if (!o) continue;
    used?.add(o);
    if (o.gate) side.gate = o.gate;
    if (o.checkin) side.checkIn = o.checkin;
    if (o.belt) side.belt = o.belt;
    if (o.terminal && !side.terminal) side.terminal = o.terminal;
    const est = localToTime(o.estAt, tz) || clockToTime(o.est, side.sched, tz);
    if (est) side.revised = est;
    const act = localToTime(o.actualAt, tz) || clockToTime(o.actual, side.sched, tz);
    if (act) side.actual = act;
    const st = mapStatus(o.status);
    if (st && !(st === 'Delayed' && ['Departed', 'EnRoute', 'Approaching', 'Arrived'].includes(f.status))) f.status = st;
    if (sideKey === 'arr' && o.actual && f.status !== 'Canceled') f.status = 'Arrived';
    if (o.reg && o.reg.replace(/-/g, '') !== (f.aircraft?.reg || '').replace(/-/g, '')) f.aircraft = { ...f.aircraft, reg: o.reg, hex: f.aircraft?.reg ? undefined : f.aircraft?.hex, model: f.aircraft?.model || o.type };
    else if (o.type && !f.aircraft?.model) f.aircraft = { ...f.aircraft, model: o.type };
    side.officialStatus = o.status || null;
    side._off = iata;
    f._official = true;
  }
  return flights;
}

// Esito dell'ultima lettura del tabellone ufficiale, per mostrarlo sotto il tabellone
export const officialInfo = {};
async function withOfficial(flights, iata, nature, window = true) {
  const k = `${iata}:${nature}`;
  try {
    if (!(getSettings().workerUrl || '').trim()) { officialInfo[k] = { error: 'indirizzo del Worker non impostato in Impostazioni' }; return flights; }
    const off = await getOfficial(iata, nature);
    const used = new Set(), sideKey = nature === 'D' ? 'dep' : 'arr';
    mergeOfficial(flights, off, sideKey, iata, used);
    const matched = flights.filter(f => f._official).length;
    // voli del tabellone ufficiale che AeroDataBox non ha: li aggiungo (salvo doppioni con un'altra sigla)
    let added = 0;
    if (window && off?.length) {
      const otherKey = sideKey === 'dep' ? 'arr' : 'dep';
      const extra = officialFlights(off.filter(o => !used.has(o)), iata, nature).filter(inWindow).filter(x => !flights.some(f => {
        if (f[sideKey]?.sched?.utc !== x[sideKey].sched.utc) return false;
        const a = f[otherKey] || {}, b = x[otherKey] || {};
        if (a.iata && b.iata) return a.iata === b.iata;
        const n = v => (v || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 4);
        return !b.name || !a.name || n(a.name) === n(b.name);
      }));
      mergeOfficial(extra, off, sideKey, iata);
      flights.push(...extra);
      added = extra.length;
      flights.sort((a, b) => Date.parse(a[sideKey]?.sched?.utc || 0) - Date.parse(b[sideKey]?.sched?.utc || 0));
    }
    officialInfo[k] = { count: off?.length || 0, matched, added };
    return flights;
  } catch (e) {
    officialInfo[k] = { error: String(e.message || e) };
    return flights;
  }
}

async function enrichLegs(legs) {
  for (const iata of new Set(legs.flatMap(l => [l.dep?.iata, l.arr?.iata]).filter(c => OFFICIAL_AIRPORTS[c]))) {
    await withOfficial(legs, iata, 'D', false);
    await withOfficial(legs, iata, 'A', false);
  }
  return legs;
}

/** Verifica il Worker con il tabellone partenze di Pisa. */
export async function testWorker(url) {
  const r = await getOfficial('PSA', 'D', url);
  return r?.length || 0;
}

// ---------- API pubblica ----------

/** Tabellone: { departures: [...], arrivals: [...] } da 2h fa a 10h avanti.
 *  AeroDataBox si aggiorna al massimo ogni 15 minuti; gate, orari e stato ufficiali ogni 90 secondi.
 *  Se AeroDataBox non risponde (es. quota finita) e l'aeroporto ha il tabellone ufficiale, uso solo quello. */
export async function getBoard(iata) {
  iata = iata.toUpperCase();
  if (isDemo()) { const b = await demo.board(iata); return { departures: mergeCodeshares(b.departures, 'dep'), arrivals: mergeCodeshares(b.arrivals, 'arr') }; }
  let base, degraded = null;
  try {
    base = await cached(`board:${iata}`, 60e3, async () => {
      const q = 'offsetMinutes=-120&durationMinutes=720&withLeg=true&direction=Both&withCancelled=true&withCodeshared=false&withCargo=false&withPrivate=false';
      const data = await adbCached(`/flights/airports/iata/${iata}?${q}`, 15 * 60e3);
      const own = { iata, ...(airportByIata(iata) || {}) };
      return { departures: (data?.departures || []).map(f => normFlight(f, 'dep', own)), arrivals: (data?.arrivals || []).map(f => normFlight(f, 'arr', own)) };
    });
  } catch (e) {
    if (!OFFICIAL_AIRPORTS[iata] || !(getSettings().workerUrl || '').trim()) throw e;
    degraded = e.message || String(e);
    base = { departures: [], arrivals: [] };
  }
  const departures = structuredClone(base.departures), arrivals = structuredClone(base.arrivals);
  if (OFFICIAL_AIRPORTS[iata]) {
    if (degraded) {
      const [d, a] = await Promise.all([officialOnly(iata, 'D'), officialOnly(iata, 'A')]);
      if (!d.length && !a.length) throw new Error(degraded);
      return { departures: mergeCodeshares(d, 'dep'), arrivals: mergeCodeshares(a, 'arr'), degraded };
    }
    await Promise.all([withOfficial(departures, iata, 'D'), withOfficial(arrivals, iata, 'A')]);
  }
  return { departures: mergeCodeshares(departures, 'dep'), arrivals: mergeCodeshares(arrivals, 'arr') };
}

/** Accorpa i voli in code sharing: stesso orario programmato e stessa destinazione/provenienza diventano
 *  una riga sola, col numero del vettore che opera il volo e le altre sigle in `codeshares`. */
const withMkt = f => (f._mkt?.length && !f.codeshares ? { ...f, codeshares: f._mkt.filter(n => n !== f.number) } : f);
export function mergeCodeshares(list, dir) {
  const groups = new Map(), out = [];
  for (const f of list) {
    const own = dir === 'dep' ? f.dep : f.arr, other = dir === 'dep' ? f.arr : f.dep;
    const where = other?.iata || (other?.name || '').toLowerCase();
    const t = own?.sched?.utc;
    if (!t || !where) { out.push(withMkt(f)); continue; }
    const k = `${t}|${where}`;
    let g = groups.get(k);
    if (!g) { g = []; groups.set(k, g); out.push(g); }
    g.push(f);
  }
  const clash = (a, b) => (a && b && a !== b);
  return out.flatMap(g => {
    if (!Array.isArray(g)) return [g];
    if (g.length === 1) return [withMkt(g[0])];
    // sottogruppi: due voli con gate o marche diverse sono voli distinti, non codeshare
    const subs = [];
    for (const f of g) {
      const side = dir === 'dep' ? f.dep : f.arr;
      const s = subs.find(s => s.every(x => { const xs = dir === 'dep' ? x.dep : x.arr; return !clash(xs?.gate, side?.gate) && !clash(x.aircraft?.reg, f.aircraft?.reg); }));
      if (s) s.push(f); else subs.push([f]);
    }
    return subs.map(s => {
      if (s.length === 1) return withMkt(s[0]);
      const score = f => (s.some(x => x._opBy === f.number) ? 4 : 0) + (f.codeshareStatus === 'IsOperator' ? 4 : 0)
        + ((f._mkt || []).some(n => s.some(x => x.number === n)) ? 4 : 0) + (f._opBy && f._opBy !== f.number ? -2 : 0)
        + (f.aircraft?.reg ? 1 : 0) + (f._official ? 1 : 0);
      const main = s.reduce((a, b) => (score(b) > score(a) ? b : a));
      const others = [...new Set([...s.filter(f => f !== main).map(f => f.number), ...(main._mkt || []), ...(main.codeshares || [])])].filter(n => n !== main.number);
      return { ...main, codeshares: others };
    });
  });
}

const CITY_ALIASES = { ROME: 'Roma', MILAN: 'Milano', NAPLES: 'Napoli', FLORENCE: 'Firenze', VENICE: 'Venezia', TURIN: 'Torino', GENOA: 'Genova', LISBON: 'Lisbona', LISBOA: 'Lisbona', COPENHAGEN: 'Copenaghen', MUNICH: 'Monaco di Baviera', ATHENS: 'Atene', BRUSSELS: 'Bruxelles', GENEVA: 'Ginevra', GENEVE: 'Ginevra', ZURICH: 'Zurigo', VIENNA: 'Vienna', WARSAW: 'Varsavia', PRAGUE: 'Praga', SEVILLE: 'Siviglia', CORK: 'Cork' };
function cityToIata(city) {
  if (!city) return null;
  const c = String(city).trim().toUpperCase();
  return iataByCityName(CITY_ALIASES[c] || city) || iataByCityName(city);
}

/** Voli (formato dell'app) costruiti dalle righe del tabellone ufficiale. */
function officialFlights(off, iata, nature) {
  const tz = OFFICIAL_AIRPORTS[iata], own = { iata, ...(airportByIata(iata) || {}) };
  return (off || []).filter(o => o.schedDate && o.number).map(o => {
    const d = o.schedDate.slice(0, 10), hm = o.schedDate.slice(11, 16), z = tzOffset(tz, d);
    const sched = { local: `${d} ${hm}${z}`, utc: new Date(`${d}T${hm}:00${z}`).toISOString() };
    const mine = { iata, icao: own.icao, name: own.name, sched };
    // alcuni tabelloni (es. Ginevra) danno solo il nome della città: provo a ricavare il codice dal database locale (solo se univoco)
    const cityCode = o.cityCode || cityToIata(o.city);
    const ap = cityCode ? airportByIata(cityCode) : null;
    const other = { iata: cityCode || null, name: ap?.name || (o.city ? o.city.toLowerCase().replace(/(^|[\s-])\S/g, c => c.toUpperCase()) : null) };
    return {
      number: o.number, airline: { name: o.airline || null, iata: o.number.slice(0, 2) }, status: 'Expected', aircraft: { reg: o.reg || null, model: o.type || null },
      dep: nature === 'D' ? mine : other, arr: nature === 'D' ? other : mine, _officialOnly: true,
      // Aeroporti di Roma: una riga per sigla, "Operato da" indica il vettore; gli altri: la riga del vettore elenca le altre sigle
      ...(['FCO', 'CIA'].includes(iata) ? { _opBy: o.codeshare?.[0] } : { _mkt: o.codeshare || [] }),
    };
  });
}
const inWindow = f => { const t = Date.parse((f.dep.sched || f.arr.sched).utc), now = Date.now(); return t > now - 2 * 3600e3 && t < now + 10 * 3600e3; };

/** Tabellone costruito solo dai dati ufficiali dell'aeroporto (senza AeroDataBox). */
async function officialOnly(iata, nature, window = true) {
  const k = `${iata}:${nature}`;
  let off;
  try { off = await getOfficial(iata, nature); } catch (e) { officialInfo[k] = { error: String(e.message || e) }; return []; }
  const flights = officialFlights(off, iata, nature).filter(f => !window || inWindow(f));
  mergeOfficial(flights, off, nature === 'D' ? 'dep' : 'arr', iata);
  if (window) officialInfo[k] = { count: off.length, matched: 0, added: flights.length, only: true };
  return flights.sort((a, b) => Date.parse((a.dep.sched || a.arr.sched).utc) - Date.parse((b.dep.sched || b.arr.sched).utc));
}

// ---------- FlightAware AeroAPI via Worker (riserva quando AeroDataBox non risponde) ----------
// La chiave FlightAware è un segreto del Worker. Il Worker tiene le risposte in cache 10 minuti e ha un limite
// mensile di richieste; qui tengo le risposte per 10 minuti anche nel browser.
async function faGet(params) {
  const base = (getSettings().workerUrl || '').trim().replace(/\/+$/, '');
  if (!base) return null;
  const q = new URLSearchParams(params).toString();
  const hit = pget(`fa:${q}`, 10 * 60e3);
  if (hit !== undefined) return hit;
  const r = await fetch(`${base}/fa?${q}`).catch(() => null);
  if (!r?.ok) return null; // 501 = FlightAware non configurato, 429 = limite mensile
  const j = await r.json().catch(() => null);
  if (j) pput(`fa:${q}`, j);
  return j;
}
const withCoords = legs => {
  for (const l of legs) for (const s of [l.dep, l.arr]) {
    const ap = s?.iata && airportByIata(s.iata);
    if (ap) Object.assign(s, { name: s.name || ap.name, lat: ap.lat, lon: ap.lon });
  }
  return legs;
};
export async function faFlight(number, date, inbound = false) {
  const j = await faGet({ ident: number, date, ...(inbound ? { inbound: 1 } : {}) });
  return j && { flights: withCoords(j.flights || []), inbound: j.inbound ? withCoords([j.inbound])[0] : null };
}
async function faByReg(reg, date) {
  const j = await faGet({ reg, date });
  return j ? withCoords(j.flights || []) : null;
}

/** Tutte le tratte di un volo in una data (YYYY-MM-DD). */
export async function getFlight(number, date, depHint) {
  number = number.toUpperCase().replace(/\s+/g, '');
  if (isDemo()) return demo.flight(number, date);
  try {
    return await cached(`flight:${number}:${date}`, 60e3, async () => {
      const data = await adbCached(`/flights/number/${encodeURIComponent(number)}/${date}?withAircraftImage=false&withLocation=true`, 5 * 60e3);
      return enrichLegs((data || []).map(f => normFlight(f)));
    });
  } catch (e) {
    // AeroDataBox non disponibile: provo FlightAware, poi i tabelloni ufficiali
    const fa = await faFlight(number, date).catch(() => null);
    if (fa?.flights.length) {
      const legs = await enrichLegs(fa.flights).catch(() => fa.flights);
      legs.forEach(l => { l._degraded = e.message || String(e); });
      return legs;
    }
    const legs = await officialFlight(number, date, depHint).catch(() => []);
    if (!legs.length) throw e;
    legs.forEach(l => { l._degraded = e.message || String(e); });
    return legs;
  }
}

/** Ricostruisce un volo dai tabelloni ufficiali (partenza e, se c'è, arrivo). */
async function officialFlight(number, date, depHint) {
  if (!(getSettings().workerUrl || '').trim()) return [];
  const codes = Object.keys(OFFICIAL_AIRPORTS);
  const depCodes = depHint && OFFICIAL_AIRPORTS[depHint] ? [depHint] : codes;
  const sameDay = f => (f.dep.sched || f.arr.sched)?.local?.slice(0, 10) === date;
  let leg = null;
  for (const c of depCodes) {
    leg = (await officialOnly(c, 'D', false)).find(f => f.number === number && sameDay(f));
    if (leg) break;
  }
  // arrivo: completo con il tabellone arrivi ufficiale della destinazione, se disponibile
  const arrCodes = leg ? (OFFICIAL_AIRPORTS[leg.arr.iata] ? [leg.arr.iata] : []) : codes;
  for (const c of arrCodes) {
    const a = (await officialOnly(c, 'A', false)).find(f => f.number === number && (!leg || f.dep.iata === leg.dep.iata));
    if (!a) continue;
    if (leg) leg.arr = { ...leg.arr, ...a.arr };
    else if (sameDay(a)) leg = a;
    break;
  }
  if (!leg) return [];
  for (const side of [leg.dep, leg.arr]) {
    const ap = airportByIata(side.iata);
    if (ap) Object.assign(side, { name: side.name || ap.name, lat: ap.lat, lon: ap.lon });
  }
  return [leg];
}


/** Voli effettuati da un aeromobile (marche) in una data. */
export async function getFlightsByReg(reg, date) {
  if (isDemo()) return demo.byReg(reg, date);
  return cached(`reg:${reg}:${date}`, 60e3, async () => {
    try {
      const data = await adbCached(`/flights/reg/${encodeURIComponent(reg)}/${date}?withAircraftImage=false&withLocation=true`, 15 * 60e3);
      return (data || []).map(f => normFlight(f));
    } catch (e) {
      // AeroDataBox non disponibile: voli dell'aereo da FlightAware
      const legs = await faByReg(reg, date).catch(() => null);
      if (legs?.length) return legs;
      throw e;
    }
  });
}

/**
 * Tratte di un aereo lette dai tabelloni ufficiali che riportano le marche.
 * Parte dagli aeroporti già noti (seed) e segue l'aereo di scalo in scalo: dal tabellone partenze
 * scopre la destinazione, dal tabellone arrivi la provenienza, e così via (al massimo `maxBoards` aeroporti).
 * Restituisce { legs, boards } con le tratte (formato dell'app, _officialOnly) e gli aeroporti consultati.
 */
export async function officialByReg(reg, date, seed = [], maxBoards = 8) {
  const out = { legs: [], boards: [] };
  if (isDemo() || !(getSettings().workerUrl || '').trim()) return out;
  const norm = r => String(r || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const want = norm(reg);
  const day0 = Date.parse(`${date}T00:00:00`) - 3 * 3600e3, day1 = day0 + 30 * 3600e3;
  const inDay = f => { const t = Date.parse((f.dep.sched || f.arr.sched)?.utc || ''); return t >= day0 && t < day1; };
  const seen = new Set();
  let queue = [...new Set(seed)].filter(c => OFFICIAL_AIRPORTS[c]);
  while (queue.length && out.boards.length < maxBoards) {
    const batch = queue.slice(0, maxBoards - out.boards.length);
    batch.forEach(c => seen.add(c));
    const found = await Promise.all(batch.map(async c => {
      const [d, a] = await Promise.all([officialOnly(c, 'D', false).catch(() => []), officialOnly(c, 'A', false).catch(() => [])]);
      return [...d, ...a].filter(f => norm(f.aircraft?.reg) === want && inDay(f));
    }));
    out.boards.push(...batch);
    const next = new Set();
    for (const f of found.flat()) {
      // la stessa tratta letta sia alla partenza sia all'arrivo: unisco i due lati
      const g = out.legs.find(x => x.number === f.number && x.dep.iata === f.dep.iata && x.arr.iata === f.arr.iata);
      if (g) { for (const k of ['dep', 'arr']) if (f[k]._off) g[k] = { ...g[k], ...f[k] }; if ((f.status === 'Arrived') || g.status === 'Expected') g.status = f.status; }
      else out.legs.push(f);
      for (const c of [f.dep.iata, f.arr.iata]) if (c && OFFICIAL_AIRPORTS[c] && !seen.has(c)) next.add(c);
    }
    queue = [...queue.slice(batch.length), ...next].filter(c => !seen.has(c));
  }
  for (const l of out.legs) for (const side of [l.dep, l.arr]) {
    const ap = airportByIata(side.iata);
    if (ap && side.lat == null) Object.assign(side, { name: side.name || ap.name, lat: ap.lat, lon: ap.lon });
  }
  return out;
}

/** Codice ICAO24 (hex) di un aereo dalle marche: rete ADS-B se è in volo, altrimenti il database pubblico hexdb.io. */
export async function hexOfReg(reg) {
  if (isDemo() || !reg) return null;
  return cached(`hex:${reg}`, 7 * 86400e3, async () => {
    const live = await liveByReg(reg);
    if (live?.hex) return live.hex;
    try {
      const r = await fetch(`https://hexdb.io/reg-hex?reg=${encodeURIComponent(reg)}`);
      const t = r.ok ? (await r.text()).trim().toLowerCase() : '';
      return /^[0-9a-f]{6}$/.test(t) ? t : null;
    } catch { return null; }
  });
}

let traceVia = null; // 'direct' o 'worker': la strada che ha funzionato, per non riprovare quella che fallisce
/**
 * Percorso realmente volato da un aereo (ICAO24) secondo la rete ADS-B adsb.lol (ultime ~24 ore).
 * Prova il file pubblico direttamente dal browser, altrimenti passa dal Worker (/trace).
 * Restituisce { points: [{ t, lat, lon, alt, gs, track, ground, newLeg }], source } o null.
 */
export async function getTrace(hex) {
  if (isDemo() || !hex) return null;
  hex = hex.toLowerCase();
  return cached(`trace:${hex}`, 60e3, async () => {
    const worker = (getSettings().workerUrl || '').trim().replace(/\/+$/, '');
    if (traceVia !== 'worker') {
      try {
        const r = await fetch(`https://globe.adsb.lol/data/traces/${hex.slice(-2)}/trace_full_${hex}.json`);
        if (r.ok) {
          const t = await r.json();
          traceVia = 'direct';
          return { source: 'adsb.lol', points: (t.trace || []).filter(p => p[1] != null).map(p => ({ t: (t.timestamp + p[0]) * 1000, lat: p[1], lon: p[2], alt: p[3] === 'ground' ? 0 : p[3], ground: p[3] === 'ground', gs: p[4], track: p[5], newLeg: !!(p[6] & 2) })) };
        }
        if (r.status === 404) return { source: 'adsb.lol', points: [] };
      } catch { /* probabilmente CORS: provo dal Worker */ }
      if (worker) traceVia = 'worker';
    }
    if (!worker) return null;
    try {
      const r = await fetch(`${worker}/trace?hex=${hex}`);
      if (!r.ok) return null;
      const t = await r.json();
      return { source: 'adsb.lol (via Worker)', points: (t.points || []).map(p => ({ t: p[0] * 1000, lat: p[1], lon: p[2], alt: p[3] ?? 0, ground: p[3] == null, gs: p[4], track: p[5], newLeg: !!p[6] })) };
    } catch { return null; }
  });
}

/** Coordinate di un aeroporto (db locale, altrimenti API). */
export async function getAirportInfo(iata) {
  const local = airportByIata(iata);
  if (local || isDemo()) return local || null;
  return cached(`ap:${iata}`, 24 * 3600e3, async () => {
    const a = await adbCached(`/airports/iata/${iata}`, 30 * 86400e3);
    return a && { iata, icao: a.icao, name: a.shortName || a.fullName, city: a.municipalityName, lat: a.location?.lat, lon: a.location?.lon };
  }).catch(() => null);
}

/**
 * Trova la tratta precedente dello stesso aeromobile (l'aereo "in arrivo" che farà il volo).
 * Restituisce { inbound, method, reason }:
 *  - method 'reg'   = certo, stesso aeromobile (marche)
 *  - method 'guess' = stima: la compagnia non ha indicato l'aereo, si usa il volo della stessa
 *                     compagnia che arriva dalla destinazione poco prima (tipico delle low cost,
 *                     che fanno andata e ritorno con lo stesso aereo)
 */
export async function getInbound(flight) {
  const depSide = flight.dep || {};
  const depUtc = (depSide.revised || depSide.sched)?.utc && new Date((depSide.revised || depSide.sched).utc);
  if (!depUtc) return { inbound: null, reason: 'Orario di partenza non disponibile.' };

  // 1) marche dell'aereo: dal volo, oppure dal tabellone dell'aeroporto (a volte è più aggiornato)
  let reg = flight.aircraft?.reg;
  let board = null;
  const loadBoard = async () => {
    if (board || !depSide.iata) return board;
    const near = Math.abs(depUtc - Date.now()) < 10 * 3600e3; // il tabellone copre da -2h a +10h
    if (near) board = await getBoard(depSide.iata).catch(() => null);
    return board;
  };
  if (!reg && await loadBoard()) {
    const same = board.departures.find(d => d.number === flight.number);
    if (same?.aircraft?.reg) { reg = same.aircraft.reg; flight.aircraft = { ...flight.aircraft, ...same.aircraft }; }
  }

  if (reg) {
    const d0 = isoDate(depUtc), d1 = isoDate(new Date(depUtc - 86400e3));
    const lists = await Promise.all([getFlightsByReg(reg, d0).catch(() => []), d1 !== d0 ? getFlightsByReg(reg, d1).catch(() => []) : []]);
    const byReg = lists.flat()
      .filter(f => !(f.number === flight.number && f.dep?.iata === depSide.iata))
      .filter(f => f.arr?.sched?.utc && new Date(f.arr.sched.utc) <= depUtc)
      .filter(f => !depSide.iata || !f.arr?.iata || f.arr.iata === depSide.iata)
      .sort((a, b) => new Date(b.arr.sched.utc) - new Date(a.arr.sched.utc));
    if (byReg[0]) return { inbound: byReg[0], method: 'reg' };
    // anche il tabellone arrivi può riportare le marche
    if (await loadBoard()) {
      const arr = board.arrivals.filter(a => a.aircraft?.reg === reg && a.arr?.sched?.utc && new Date(a.arr.sched.utc) <= depUtc)
        .sort((a, b) => new Date(b.arr.sched.utc) - new Date(a.arr.sched.utc))[0];
      if (arr) return { inbound: arr, method: 'reg' };
    }
  }

  // 1b) FlightAware indica l'aereo assegnato e la tratta precedente (anche per le low cost): due richieste,
  //     solo se le marche non hanno già dato la risposta
  const fa = await faFlight(flight.number, (depSide.sched?.local || '').slice(0, 10) || isoDate(depUtc), true).catch(() => null);
  if (fa?.inbound?.number && fa.flights.some(l => !depSide.iata || l.dep?.iata === depSide.iata)) {
    const me = fa.flights.find(l => l.dep?.iata === depSide.iata);
    if (me?.aircraft?.reg && !flight.aircraft?.reg) flight.aircraft = { ...flight.aircraft, reg: me.aircraft.reg, model: flight.aircraft?.model || me.aircraft.model };
    return { inbound: fa.inbound, method: 'reg', source: 'FlightAware' };
  }

  // 2) stima dal tabellone arrivi (anche solo dai dati ufficiali, se il volo è lontano nel tempo)
  if ((await loadBoard()) || (OFFICIAL_AIRPORTS[depSide.iata] && (getSettings().workerUrl || '').trim())) {
    board = board || { arrivals: [], departures: [] };
    const airline = flight.airline?.iata || flight.number.replace(/\d.*$/, '');
    const cands = board.arrivals.filter(a => {
      const t = (a.arr?.revised || a.arr?.sched)?.utc;
      if (!t) return false;
      const gap = (depUtc - new Date(t)) / 60e3;
      const al = a.airline?.iata || a.number.replace(/\d.*$/, '');
      return al === airline && gap >= 15 && gap <= 240 && a.status !== 'Canceled';
    });
    // 2a) verifica incrociata: per gli aerei della stessa compagnia arrivati poco prima, guardo la loro
    //     giornata (marche note dal tabellone o dalla rete ADS-B): se contiene questo volo, è l'aereo giusto
    if (!reg) {
      const d0 = isoDate(depUtc);
      const near = [...cands].sort((a, b) => new Date(b.arr.sched.utc) - new Date(a.arr.sched.utc));
      let lookups = 0;
      for (const a of near) {
        if (lookups >= 6) break;
        let r = a.aircraft?.reg;
        if (!r && AIRBORNE.includes(a.status) && a.callSign) {
          const x = await adsbByCallsign(a.callSign);
          if (x?.reg) { r = x.reg; a.aircraft = { ...a.aircraft, reg: x.reg, hex: x.hex, model: a.aircraft?.model || x.model }; }
        }
        if (!r) continue;
        lookups++;
        const day = await getFlightsByReg(r, d0).catch(() => []);
        const mine = day.find(f => f.number === flight.number && (!f.dep?.iata || f.dep.iata === depSide.iata));
        if (mine) {
          flight.aircraft = { ...flight.aircraft, reg: r, hex: mine.aircraft?.hex || a.aircraft?.hex, model: flight.aircraft?.model || mine.aircraft?.model };
          return { inbound: a, method: 'reg' };
        }
      }
    }
    // 2b) ricostruzione della giornata della compagnia in questo aeroporto (stile Flightradar24): giri
    //     veloci, aerei fermi da ore o rimasti a terra la notte; la rete ADS-B scarta gli aerei già ripartiti
    const day = await dayMovements(depSide.iata, depUtc, board, flight);
    for (const a of day.arrivals) {
      if (!a.aircraft?.reg && a.callSign && AIRBORNE.includes(a.status) && al(a) === airline && Math.abs(depUtc - arrTime(a)) < 3 * 3600e3) {
        const x = await adsbByCallsign(a.callSign);
        if (x?.reg) a.aircraft = { ...a.aircraft, reg: x.reg, hex: x.hex, model: a.aircraft?.model || x.model };
      }
    }
    // aerei della compagnia fermi da ore con marche note: la rete ADS-B dice se sono ripartiti (esclusi)
    // o se sono ancora qui (allora non possono aver fatto le partenze già decollate)
    const exclude = new Set(), stayed = new Set();
    const parked = day.arrivals.filter(a => al(a) === airline && a.aircraft?.reg && arrTime(a) < depUtc - 90 * 60e3 && arrTime(a) > depUtc - 30 * 3600e3)
      .sort((a, b) => arrTime(b) - arrTime(a)).slice(0, 6);
    await Promise.all(parked.map(async a => {
      const left = await leftSince(a.aircraft.reg, arrTime(a), depSide.iata).catch(() => null);
      if (left === true) exclude.add(a.aircraft.reg); else if (left === false) stayed.add(a.aircraft.reg);
    }));
    const sim = simulateRotation({ flight, arrivals: day.arrivals, departures: day.departures, exclude, stayed, now: Date.now(), coverageFrom: day.from });
    if (sim?.pick) {
      const p = sim.pick;
      if (!p.aircraft?.reg && AIRBORNE.includes(p.status) && p.callSign) {
        const a = await adsbByCallsign(p.callSign);
        if (a?.reg) p.aircraft = { ...p.aircraft, reg: a.reg, hex: a.hex, model: p.aircraft?.model || a.model };
      }
      return { inbound: p, method: 'guess', basis: sim.basis, waitMin: sim.waitMin };
    }
    if (sim?.basis === 'ground') {
      const name = flight.airline?.name ? ` ${flight.airline.name}` : '', ap = airportByIata(depSide.iata)?.city || depSide.iata;
      const late = day.arrivals.filter(a => al(a) === airline && a.status !== 'Canceled' && arrTime(a) > depUtc - 40 * 60e3 && arrTime(a) < +depUtc + 90 * 60e3)
        .sort((a, b) => arrTime(a) - arrTime(b))[0];
      return {
        inbound: null, method: 'guess', basis: 'ground',
        reason: `Probabilmente parte con un aereo${name} già fermo a ${ap}${sim.partialData ? '' : ', rimasto lì dalla notte o di riserva nella base'}: ricostruendo la giornata della compagnia, gli aerei arrivati prima della partenza sono già ripartiti con altri voli.`
          + (late ? ` L'aereo in arrivo con ${late.number} da ${late.dep?.iata || '?'} (alle ${hhmm(late.arr?.actual || late.arr?.revised || late.arr?.sched)}) arriva troppo tardi per fare questo volo.` : '')
          + ' La compagnia di solito indica l\'aereo poche ore prima della partenza.',
      };
    }
  }

  return {
    inbound: null,
    reason: reg ? 'Nessuna tratta precedente trovata per questo aeromobile.'
      : "La compagnia non ha ancora indicato quale aereo farà il volo e non c'è un volo di ritorno compatibile in arrivo. L'aereo di solito viene assegnato poche ore prima della partenza.",
  };
}


/** Cerca un aereo in volo sulla rete ADS-B per nominativo radio (es. RYR5HT): restituisce marche, ICAO24 e posizione. */
async function adsbByCallsign(cs) {
  cs = (cs || '').replace(/\s+/g, '').toUpperCase();
  if (!cs) return null;
  return cached(`cs:${cs}`, 10e3, async () => {
    try {
      const r = await fetch(`https://api.adsb.lol/v2/callsign/${cs}`);
      if (!r.ok) return null;
      const a = (await r.json()).ac?.[0];
      if (!a) return null;
      return {
        reg: a.r, hex: a.hex?.toLowerCase(), model: a.t,
        pos: a.lat != null ? { lat: a.lat, lon: a.lon, alt: a.alt_baro === 'ground' ? 0 : a.alt_baro, onGround: a.alt_baro === 'ground', gs: a.gs, track: a.track, at: new Date(Date.now() - (a.seen_pos || 0) * 1000).toISOString(), source: 'adsb.lol' } : null,
      };
    } catch { return null; }
  });
}
const AIRBORNE = ['Departed', 'EnRoute', 'Approaching'];
const al = x => x.airline?.iata || (x.number || '').replace(/\d.*$/, '');
const hhmm = t => (t?.local || '').slice(11, 16) || (t?.utc ? new Date(t.utc).toTimeString().slice(0, 5) : '?');
const kmBetween = (a, b) => {
  const r = Math.PI / 180, x = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
};

/** Data locale "YYYY-MM-DD" di un istante nel fuso dell'aeroporto. */
const localDay = (ms, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

/**
 * Movimenti di un aeroporto per ricostruire la giornata delle compagnie: tabellone (finestra attorno a
 * adesso) + tabellone ufficiale completo + la copia del tabellone ufficiale di ieri salvata in questo
 * dispositivo + (se servono e ci sono unità) gli arrivi/partenze della sera prima da AeroDataBox.
 * Restituisce { arrivals, departures, from } (from = inizio dei dati, in ms).
 */
async function dayMovements(iata, depUtc, board, flight) {
  const arrivals = [...(board?.arrivals || [])], departures = [...(board?.departures || [])];
  const add = (list, extra, side) => {
    for (const x of extra) {
      const t = Date.parse(x[side]?.sched?.utc || '');
      if (!list.some(f => f.number === x.number && Math.abs(Date.parse(f[side]?.sched?.utc || '') - t) < 12 * 3600e3)) list.push(x);
    }
  };
  const tz = OFFICIAL_AIRPORTS[iata];
  let dayFrom = Infinity; // i tabelloni ufficiali coprono la giornata intera
  if (tz && (getSettings().workerUrl || '').trim()) {
    const today = localDay(Date.now(), tz), yesterday = localDay(Date.now() - 86400e3, tz);
    for (const [nature, list, side] of [['A', arrivals, 'arr'], ['D', departures, 'dep']]) {
      const off = await getOfficial(iata, nature).catch(() => null);
      if (off?.length) {
        pput(`day:${iata}:${nature}:${today}`, off); // copia per domani (molti tabelloni non mostrano il giorno prima)
        add(list, mergeOfficial(officialFlights(off, iata, nature), off, side, iata), side);
      }
      const prev = pget(`day:${iata}:${nature}:${yesterday}`, 3 * 86400e3);
      if (prev?.length) { add(list, mergeOfficial(officialFlights(prev, iata, nature), prev, side, iata), side); dayFrom = Math.min(dayFrom, Date.parse(`${yesterday}T00:00:00${tzOffset(tz, yesterday)}`)); }
      else if (off?.length) dayFrom = Math.min(dayFrom, Date.parse(`${today}T00:00:00${tzOffset(tz, today)}`));
    }
  }
  const times = [...arrivals.map(a => Date.parse(a.arr?.sched?.utc || '')), ...departures.map(d => Date.parse(d.dep?.sched?.utc || ''))].filter(t => !isNaN(t));
  let from = Math.min(dayFrom, times.length ? Math.min(...times) : Infinity);
  if (from === Infinity) from = NaN;
  // dati che non coprono la sera prima: provo AeroDataBox (una richiesta, tenuta in cache un giorno)
  const offset = ((flight?.dep?.sched?.local || '').match(/([+-]\d\d:\d\d)$/) || [])[1];
  if (!(from <= depUtc - 14 * 3600e3) && offset && (getSettings().apiKey || '').trim() && !adbBlocked() && !isDemo()) {
    const loc = ms => new Date(ms + (offset[0] === '-' ? -1 : 1) * (parseInt(offset.slice(1, 3)) * 60 + parseInt(offset.slice(4))) * 60e3).toISOString().slice(0, 16);
    const a = depUtc - 18 * 3600e3, b = Math.min(a + 12 * 3600e3, isNaN(from) ? Infinity : from + 3600e3);
    if (b > a + 3600e3) {
      try {
        const q = 'withLeg=true&direction=Both&withCancelled=true&withCodeshared=false&withCargo=false&withPrivate=false';
        const data = await adbCached(`/flights/airports/iata/${iata}/${loc(a)}/${loc(b)}?${q}`, 24 * 3600e3);
        const own = { iata, ...(airportByIata(iata) || {}) };
        add(arrivals, (data?.arrivals || []).map(f => normFlight(f, 'arr', own)), 'arr');
        add(departures, (data?.departures || []).map(f => normFlight(f, 'dep', own)), 'dep');
        from = Math.min(isNaN(from) ? Infinity : from, a);
      } catch { /* unità finite o errore: si va avanti coi dati che ci sono */ }
    }
  }
  return { arrivals, departures, from };
}

/** Rete ADS-B: true se l'aereo (marche) ha volato lontano dall'aeroporto dopo l'istante indicato, false se risulta
 *  ancora fermo lì, null se non si sa. */
async function leftSince(reg, sinceMs, iata) {
  const ap = airportByIata(iata);
  if (!ap?.lat) return null;
  const live = await liveByReg(reg).catch(() => null);
  if (live?.pos?.lat != null && kmBetween(live.pos, ap) > 30) return true;
  const hex = live?.hex || await hexOfReg(reg).catch(() => null);
  const tr = hex && await getTrace(hex).catch(() => null);
  if (!tr?.points) return null; // traccia non disponibile: non si sa
  if (tr.points.some(p => p.t > sinceMs + 20 * 60e3 && !p.ground && p.lat != null && kmBetween(p, ap) > 30)) return true;
  // l'ultima posizione nota è vicino all'aeroporto (atterrato e fermo): è ancora qui
  const last = tr.points[tr.points.length - 1];
  return last && last.t > sinceMs - 3600e3 && kmBetween(last, ap) < 15 ? false : null;
}


/** Aereo cercato per marche sulla rete ADS-B (indipendente dai dati della compagnia). */
export async function liveByReg(reg) {
  if (isDemo() || !reg) return null;
  return cached(`livereg:${reg}`, 10e3, async () => {
    try {
      const r = await fetch(`https://api.adsb.lol/v2/reg/${encodeURIComponent(reg)}`);
      if (!r.ok) return null;
      const a = (await r.json()).ac?.[0];
      if (!a) return null;
      const out = {
        reg: a.r || reg, hex: a.hex?.toLowerCase(), callsign: (a.flight || '').trim(), model: a.t,
        onGround: a.alt_baro === 'ground',
        pos: a.lat != null ? { lat: a.lat, lon: a.lon, alt: a.alt_baro === 'ground' ? 0 : a.alt_baro, onGround: a.alt_baro === 'ground', gs: a.gs, track: a.track, at: new Date(Date.now() - (a.seen_pos || 0) * 1000).toISOString(), source: 'adsb.lol' } : null,
      };
      if (out.callsign && out.pos && !out.onGround) out.route = await routeOf(out.callsign, out.pos);
      return out;
    } catch { return null; }
  });
}

/** Rotta di un nominativo radio (database rotte di adsb.lol): { from, to } in codici IATA. */
async function routeOf(callsign, pos) {
  return cached(`route:${callsign}`, 30 * 60e3, async () => {
    try {
      const r = await fetch('https://api.adsb.lol/api/0/routeset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planes: [{ callsign, lat: pos.lat, lng: pos.lon }] }),
      });
      if (!r.ok) return null;
      const x = (await r.json())?.[0];
      const codes = (x?._airport_codes_iata || '').split('-').filter(c => /^[A-Z]{3}$/.test(c));
      return codes.length >= 2 && x.plausible !== 0 ? { from: codes[0], to: codes[codes.length - 1] } : null;
    } catch { return null; }
  });
}

/** Posizione live dell'aereo: prima AeroDataBox (se già nel volo), poi adsb.lol, poi OpenSky. */
export async function getLivePosition(flight) {
  if (isDemo()) return demo.livePosition(flight);
  if (flight.location) return flight.location;
  const hex = flight.aircraft?.hex;
  if (!hex) {
    if (flight.aircraft?.reg) {
      const a = await liveByReg(flight.aircraft.reg);
      if (a?.hex) flight.aircraft = { ...flight.aircraft, hex: a.hex };
      if (a?.pos) return { ...a.pos, onGround: a.onGround };
    }
    if (!AIRBORNE.includes(flight.status) || !flight.callSign) return null;
    const a = await adsbByCallsign(flight.callSign);
    if (a?.reg && !flight.aircraft?.reg) flight.aircraft = { ...flight.aircraft, reg: a.reg, hex: a.hex };
    return a?.pos || null;
  }
  return cached(`live:${hex}`, 10e3, async () => {
    try {
      const r = await fetch(`https://api.adsb.lol/v2/hex/${hex}`);
      if (r.ok) {
        const a = (await r.json()).ac?.[0];
        if (a?.lat != null) return { lat: a.lat, lon: a.lon, alt: a.alt_baro === 'ground' ? 0 : a.alt_baro, onGround: a.alt_baro === 'ground', gs: a.gs, track: a.track, at: new Date(Date.now() - (a.seen_pos || 0) * 1000).toISOString(), source: 'adsb.lol' };
      }
    } catch { /* passa al prossimo */ }
    try {
      const r = await fetch(`https://opensky-network.org/api/states/all?icao24=${hex}`);
      if (r.ok) {
        const s = (await r.json()).states?.[0];
        if (s && s[6] != null) return { lat: s[6], lon: s[5], alt: s[7] != null ? Math.round(s[7] * 3.281) : null, gs: s[9] != null ? Math.round(s[9] * 1.944) : null, track: s[10], onGround: !!s[8], at: new Date(s[4] * 1000).toISOString(), source: 'OpenSky' };
      }
    } catch { /* nessuna fonte disponibile */ }
    return null;
  });
}

export const isoDate = d => {
  const z = new Date(d);
  return `${z.getFullYear()}-${String(z.getMonth() + 1).padStart(2, '0')}-${String(z.getDate()).padStart(2, '0')}`;
};
