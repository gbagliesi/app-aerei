// Livello dati: provider "demo" (dati simulati) o "aerodatabox" (dati reali via RapidAPI),
// più il tracking live della posizione dell'aereo (AeroDataBox / adsb.lol / OpenSky).
import { getSettings } from './store.js';
import { airportByIata } from './airports.js';
import * as demo from './demo.js';

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
const QUOTA_MSG = 'Hai esaurito le unità mensili del tuo piano AeroDataBox su RapidAPI: si azzerano alla data di rinnovo mensile dell’abbonamento. Per Fiumicino, Ciampino, Pisa, Firenze, Bari, Brindisi, Foggia, Taranto e Ginevra il tabellone arriva comunque dai siti ufficiali.';

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
  };
}
const ownInfo = own => own ? { iata: own.iata, icao: own.icao, name: own.name } : {};


// ---------- tabelloni ufficiali via Cloudflare Worker (Fiumicino, Ciampino, Pisa, Firenze, Puglia, Ginevra) ----------
export const OFFICIAL_AIRPORTS = { PSA: 'Europe/Rome', FLR: 'Europe/Rome', FCO: 'Europe/Rome', CIA: 'Europe/Rome', BRI: 'Europe/Rome', BDS: 'Europe/Rome', FOG: 'Europe/Rome', TAR: 'Europe/Rome', GVA: 'Europe/Zurich' };

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
function mergeOfficial(flights, official, sideKey, iata) {
  if (!official?.length) return flights;
  const tz = OFFICIAL_AIRPORTS[iata];
  const byNum = new Map(official.flatMap(o => [...(o.codeshare || []).map(c => [c, o]), [o.number, o]]));
  for (const f of flights) {
    const side = f[sideKey];
    if (!side || side.iata !== iata) continue;
    const o = byNum.get(f.number);
    if (!o) continue;
    if (o.gate) side.gate = o.gate;
    if (o.checkin) side.checkIn = o.checkin;
    if (o.belt) side.belt = o.belt;
    const est = clockToTime(o.est, side.sched, tz);
    if (est) side.revised = est;
    const act = clockToTime(o.actual, side.sched, tz);
    if (act) side.actual = act;
    const st = mapStatus(o.status);
    if (st && !(st === 'Delayed' && ['Departed', 'EnRoute', 'Approaching', 'Arrived'].includes(f.status))) f.status = st;
    if (sideKey === 'arr' && o.actual && f.status !== 'Canceled') f.status = 'Arrived';
    if (o.reg && !f.aircraft?.reg) f.aircraft = { ...f.aircraft, reg: o.reg, model: f.aircraft?.model || o.type };
    side.officialStatus = o.status || null;
    f._official = true;
  }
  return flights;
}

// Esito dell'ultima lettura del tabellone ufficiale, per mostrarlo sotto il tabellone
export const officialInfo = {};
async function withOfficial(flights, iata, nature) {
  const k = `${iata}:${nature}`;
  try {
    if (!(getSettings().workerUrl || '').trim()) { officialInfo[k] = { error: 'indirizzo del Worker non impostato in Impostazioni' }; return flights; }
    const off = await getOfficial(iata, nature);
    mergeOfficial(flights, off, nature === 'D' ? 'dep' : 'arr', iata);
    officialInfo[k] = { count: off?.length || 0, matched: flights.filter(f => f._official).length };
    return flights;
  } catch (e) {
    officialInfo[k] = { error: String(e.message || e) };
    return flights;
  }
}

async function enrichLegs(legs) {
  for (const iata of new Set(legs.flatMap(l => [l.dep?.iata, l.arr?.iata]).filter(c => OFFICIAL_AIRPORTS[c]))) {
    await withOfficial(legs, iata, 'D');
    await withOfficial(legs, iata, 'A');
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

/** Tabellone costruito solo dai dati ufficiali dell'aeroporto (senza AeroDataBox). */
async function officialOnly(iata, nature, window = true) {
  const k = `${iata}:${nature}`;
  let off;
  try { off = await getOfficial(iata, nature); } catch (e) { officialInfo[k] = { error: String(e.message || e) }; return []; }
  const tz = OFFICIAL_AIRPORTS[iata], own = { iata, ...(airportByIata(iata) || {}) };
  const now = Date.now();
  const flights = (off || []).filter(o => o.schedDate).map(o => {
    const d = o.schedDate.slice(0, 10), hm = o.schedDate.slice(11, 16), z = tzOffset(tz, d);
    const sched = { local: `${d} ${hm}${z}`, utc: new Date(`${d}T${hm}:00${z}`).toISOString() };
    const mine = { iata, icao: own.icao, name: own.name, sched };
    const other = { iata: o.cityCode || null, name: o.city ? o.city.toLowerCase().replace(/(^|[\s-])\S/g, c => c.toUpperCase()) : null };
    return {
      number: o.number, airline: { name: o.airline || null, iata: o.number.slice(0, 2) }, status: 'Expected', aircraft: { reg: o.reg || null, model: o.type || null },
      dep: nature === 'D' ? mine : other, arr: nature === 'D' ? other : mine, _officialOnly: true,
      // Aeroporti di Roma: una riga per sigla, "Operato da" indica il vettore; Toscana Aeroporti: la riga del vettore elenca le altre sigle
      ...(['FCO', 'CIA'].includes(iata) ? { _opBy: o.codeshare?.[0] } : { _mkt: o.codeshare || [] }),
    };
  }).filter(f => { if (!window) return true; const t = Date.parse((f.dep.sched || f.arr.sched).utc); return t > now - 2 * 3600e3 && t < now + 10 * 3600e3; });
  mergeOfficial(flights, off, nature === 'D' ? 'dep' : 'arr', iata);
  if (window) officialInfo[k] = { count: off.length, matched: flights.length };
  return flights.sort((a, b) => Date.parse((a.dep.sched || a.arr.sched).utc) - Date.parse((b.dep.sched || b.arr.sched).utc));
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
    // AeroDataBox non disponibile: cerco il volo nei tabelloni ufficiali
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
    const data = await adbCached(`/flights/reg/${encodeURIComponent(reg)}/${date}?withAircraftImage=false&withLocation=true`, 15 * 60e3);
    return (data || []).map(f => normFlight(f));
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

  // 2) stima dal tabellone arrivi
  if (await loadBoard()) {
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
    const back = cands.filter(a => a.dep?.iata && a.dep.iata === flight.arr?.iata)
      .sort((a, b) => new Date(b.arr.sched.utc) - new Date(a.arr.sched.utc))[0];
    if (back) {
      // se il volo precedente è in aria, ricavo marche e ICAO24 reali dalla rete ADS-B
      if (!back.aircraft?.reg && AIRBORNE.includes(back.status) && back.callSign) {
        const a = await adsbByCallsign(back.callSign);
        if (a?.reg) back.aircraft = { ...back.aircraft, reg: a.reg, hex: a.hex, model: back.aircraft?.model || a.model };
      }
      return { inbound: back, method: 'guess', basis: 'return' };
    }

    // 2c) deduzione dalle rotazioni: abbino in ordine di tempo gli aerei della compagnia arrivati
    //     in questo aeroporto ai suoi voli in partenza senza aereo assegnato (come fanno i tracker)
    const al = x => x.airline?.iata || x.number.replace(/\d.*$/, '');
    const tOf = t => (t?.utc ? new Date(t.utc).getTime() : NaN);
    const arrT = a => tOf(a.arr?.actual || a.arr?.revised || a.arr?.sched);
    const depT = d => tOf(d.dep?.revised || d.dep?.sched);
    const turn = (LOWCOST_CODES.includes(airline) ? 25 : 40) * 60e3;
    const arrivals = board.arrivals.filter(a => al(a) === airline && a.status !== 'Canceled' && arrT(a) <= +depUtc + 30 * 60e3 && arrT(a) >= depUtc - 8 * 3600e3);
    let enrich = 0;
    for (const a of arrivals) {
      if (!a.aircraft?.reg && a.callSign && AIRBORNE.includes(a.status) && enrich++ < 4) {
        const x = await adsbByCallsign(a.callSign);
        if (x?.reg) a.aircraft = { ...a.aircraft, reg: x.reg, hex: x.hex, model: a.aircraft?.model || x.model };
      }
    }
    // aerei già assegnati a una partenza successiva al loro arrivo: non sono liberi
    const assigned = board.departures.filter(d => al(d) === airline && d.aircraft?.reg);
    const free = arrivals.filter(a => !assigned.some(d => d.aircraft.reg === a.aircraft?.reg && depT(d) > arrT(a)))
      .sort((a, b) => arrT(a) - arrT(b));
    const deps = board.departures.filter(d => al(d) === airline && !d.aircraft?.reg && d.status !== 'Canceled' && !isNaN(depT(d)));
    if (!deps.some(d => d.number === flight.number)) deps.push(flight);
    deps.sort((a, b) => depT(a) - depT(b));
    const used = new Set();
    for (const d of deps) {
      const avail = free.filter(a => !used.has(a));
      const pick = avail.find(a => arrT(a) + turn <= depT(d)) || avail.find(a => arrT(a) + turn <= depT(d) + 60 * 60e3);
      if (!pick) continue;
      used.add(pick);
      if (d.number === flight.number) return { inbound: pick, method: 'guess', basis: 'rotation' };
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
const LOWCOST_CODES = ['FR', 'U2', 'W6', 'VY', 'EW', 'HV', 'DY', 'V7'];


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
