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

async function adb(path) {
  const { apiKey } = getSettings();
  if (!apiKey) throw new Error('Manca la chiave API AeroDataBox: aggiungila in Impostazioni.');
  const res = await fetch(`https://${ADB_HOST}${path}`, {
    headers: { 'X-RapidAPI-Key': apiKey, 'X-RapidAPI-Host': ADB_HOST },
  });
  if (res.status === 204) return null;
  if (res.status === 429) throw new Error('Limite di richieste API raggiunto, riprova tra poco.');
  if (res.status === 401 || res.status === 403) throw new Error('Chiave API non valida o piano non abilitato.');
  if (!res.ok) throw new Error(`Errore API (${res.status})`);
  return res.json();
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
 * Restituisce { inbound, reason } dove reason spiega perché manca.
 */
export async function getInbound(flight) {
  const reg = flight.aircraft?.reg;
  if (!reg) return { inbound: null, reason: "La compagnia non ha ancora assegnato l'aeromobile (succede di solito poche ore prima del volo)." };
  const depUtc = flight.dep?.sched?.utc && new Date(flight.dep.sched.utc);
  if (!depUtc) return { inbound: null, reason: 'Orario di partenza non disponibile.' };
  const d0 = isoDate(depUtc), d1 = isoDate(new Date(depUtc - 86400e3));
  const lists = await Promise.all([getFlightsByReg(reg, d0), d1 !== d0 ? getFlightsByReg(reg, d1) : []]);
  const candidates = lists.flat()
    .filter(f => f.number !== flight.number || f.dep?.iata !== flight.dep?.iata)
    .filter(f => f.arr?.sched?.utc && new Date(f.arr.sched.utc) <= depUtc)
    .filter(f => !flight.dep?.iata || !f.arr?.iata || f.arr.iata === flight.dep.iata)
    .sort((a, b) => new Date(b.arr.sched.utc) - new Date(a.arr.sched.utc));
  return { inbound: candidates[0] || null, reason: candidates[0] ? '' : 'Nessuna tratta precedente trovata per questo aeromobile.' };
}

/** Posizione live dell'aereo: prima AeroDataBox (se già nel volo), poi adsb.lol, poi OpenSky. */
export async function getLivePosition(flight) {
  if (isDemo()) return demo.livePosition(flight);
  if (flight.location) return flight.location;
  const hex = flight.aircraft?.hex;
  if (!hex) return null;
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
