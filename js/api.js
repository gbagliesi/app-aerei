// Livello dati: provider "demo" (dati simulati) o "aerodatabox" (dati reali via RapidAPI),
// più il tracking live della posizione dell'aereo (AeroDataBox / adsb.lol / OpenSky).
import { getSettings } from './store.js';
import { airportByIata } from './airports.js';
import * as demo from './demo.js';

const ADB_HOST = 'aerodatabox.p.rapidapi.com';
const cache = new Map();

async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

async function adb(path, key = getSettings().apiKey) {
  const apiKey = (key || '').trim();
  if (!apiKey) throw new Error('Manca la chiave API AeroDataBox: aggiungila in Impostazioni.');
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
  else if (res.status === 429 || m.includes('quota') || m.includes('rate limit')) hint = 'Limite di richieste del piano raggiunto: riprova più tardi o alza l’intervallo di aggiornamento.';
  else if (m.includes('tier') || m.includes('plan')) hint = 'Questa funzione non è inclusa nel tuo piano AeroDataBox.';
  else hint = `Errore API (${res.status}).`;
  throw new Error(`${hint}${msg ? ` [RapidAPI: "${msg}"]` : ''}`);
}

/** Verifica una chiave con una chiamata leggera. */
export async function testKey(key) {
  await adb('/airports/iata/FCO', key);
  const fids = await adb('/flights/airports/iata/FCO?offsetMinutes=0&durationMinutes=60&withLeg=false&direction=Departure', key);
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
    aircraft: { reg: f.aircraft?.reg, hex: f.aircraft?.modeS?.toLowerCase(), model: f.aircraft?.model },
    dep, arr,
    location: normLocation(f.location),
  };
}
const ownInfo = own => own ? { iata: own.iata, icao: own.icao, name: own.name } : {};

// ---------- API pubblica ----------

/** Tabellone: { departures: [...], arrivals: [...] } da 2h fa a 10h avanti. */
export async function getBoard(iata) {
  iata = iata.toUpperCase();
  if (isDemo()) return demo.board(iata);
  return cached(`board:${iata}`, 3 * 60e3, async () => {
    const q = 'offsetMinutes=-120&durationMinutes=720&withLeg=true&direction=Both&withCancelled=true&withCodeshared=false&withCargo=false&withPrivate=false';
    const data = await adb(`/flights/airports/iata/${iata}?${q}`);
    const own = { iata, ...(airportByIata(iata) || {}) };
    return {
      departures: (data?.departures || []).map(f => normFlight(f, 'dep', own)),
      arrivals: (data?.arrivals || []).map(f => normFlight(f, 'arr', own)),
    };
  });
}

/** Tutte le tratte di un volo in una data (YYYY-MM-DD). */
export async function getFlight(number, date) {
  number = number.toUpperCase().replace(/\s+/g, '');
  if (isDemo()) return demo.flight(number, date);
  return cached(`flight:${number}:${date}`, 60e3, async () => {
    const data = await adb(`/flights/number/${encodeURIComponent(number)}/${date}?withAircraftImage=false&withLocation=true`);
    return (data || []).map(f => normFlight(f));
  });
}

/** Voli effettuati da un aeromobile (marche) in una data. */
export async function getFlightsByReg(reg, date) {
  if (isDemo()) return demo.byReg(reg, date);
  return cached(`reg:${reg}:${date}`, 5 * 60e3, async () => {
    const data = await adb(`/flights/reg/${encodeURIComponent(reg)}/${date}?withAircraftImage=false&withLocation=true`);
    return (data || []).map(f => normFlight(f));
  });
}

/** Coordinate di un aeroporto (db locale, altrimenti API). */
export async function getAirportInfo(iata) {
  const local = airportByIata(iata);
  if (local || isDemo()) return local || null;
  return cached(`ap:${iata}`, 24 * 3600e3, async () => {
    const a = await adb(`/airports/iata/${iata}`);
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
      return { inbound: back, method: 'guess' };
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
        pos: a.lat != null ? { lat: a.lat, lon: a.lon, alt: a.alt_baro === 'ground' ? 0 : a.alt_baro, gs: a.gs, track: a.track, at: new Date(Date.now() - (a.seen_pos || 0) * 1000).toISOString(), source: 'adsb.lol' } : null,
      };
    } catch { return null; }
  });
}
const AIRBORNE = ['Departed', 'EnRoute', 'Approaching'];

/** Posizione live dell'aereo: prima AeroDataBox (se già nel volo), poi adsb.lol, poi OpenSky. */
export async function getLivePosition(flight) {
  if (isDemo()) return demo.livePosition(flight);
  if (flight.location) return flight.location;
  const hex = flight.aircraft?.hex;
  if (!hex) {
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
        if (a?.lat != null) return { lat: a.lat, lon: a.lon, alt: a.alt_baro === 'ground' ? 0 : a.alt_baro, gs: a.gs, track: a.track, at: new Date(Date.now() - (a.seen_pos || 0) * 1000).toISOString(), source: 'adsb.lol' };
      }
    } catch { /* passa al prossimo */ }
    try {
      const r = await fetch(`https://opensky-network.org/api/states/all?icao24=${hex}`);
      if (r.ok) {
        const s = (await r.json()).states?.[0];
        if (s && s[6] != null) return { lat: s[6], lon: s[5], alt: s[7] != null ? Math.round(s[7] * 3.281) : null, gs: s[9] != null ? Math.round(s[9] * 1.944) : null, track: s[10], at: new Date(s[4] * 1000).toISOString(), source: 'OpenSky' };
      }
    } catch { /* nessuna fonte disponibile */ }
    return null;
  });
}

export const isoDate = d => {
  const z = new Date(d);
  return `${z.getFullYear()}-${String(z.getMonth() + 1).padStart(2, '0')}-${String(z.getDate()).padStart(2, '0')}`;
};
