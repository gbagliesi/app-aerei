// Modalità demo: genera voli realistici e coerenti (stesso aereo su più tratte, orari, gate,
// ritardi, posizione in volo interpolata) per provare l'app senza chiave API.
import { AIRPORTS, airportByIata } from './airports.js';

const AIRLINES = [
  ['AZ', 'ITA Airways', 'EI-'], ['FR', 'Ryanair', 'EI-'], ['U2', 'easyJet', 'G-E'], ['LH', 'Lufthansa', 'D-A'],
  ['AF', 'Air France', 'F-G'], ['KL', 'KLM', 'PH-'], ['BA', 'British Airways', 'G-E'], ['IB', 'Iberia', 'EC-'],
  ['VY', 'Vueling', 'EC-'], ['W6', 'Wizz Air', 'HA-L'], ['LX', 'Swiss', 'HB-J'], ['EK', 'Emirates', 'A6-E'],
];
const MODELS = ['Airbus A320neo', 'Airbus A321', 'Boeing 737-800', 'Airbus A319', 'Embraer 195', 'Airbus A220-300', 'Boeing 787-9'];

function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { let a = seed; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const toRad = d => d * Math.PI / 180, toDeg = r => r * 180 / Math.PI;

export function distanceKm(a, b) {
  if (a?.lat == null || b?.lat == null) return 1000; // coordinate ignote: durata tipica
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(x));
}

function fmtTime(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const p = n => String(Math.abs(n)).padStart(2, '0');
  const local = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}${off >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
  return { utc: d.toISOString(), local };
}

// Registro dei voli generati (persistito per la sessione, così il ricaricamento della pagina funziona)
const REG_KEY = 'aerei.demo.registry';
let registry = (() => { try { return JSON.parse(sessionStorage.getItem(REG_KEY) || '{}'); } catch { return {}; } })();
const persist = () => { try { sessionStorage.setItem(REG_KEY, JSON.stringify(registry)); } catch { /* quota */ } };
const legKey = (number, depMs) => `${number}@${depMs}`;

function makeLeg(r, { number, airline, from, to, depMs, reg, hex, model }) {
  const durMin = Math.round(distanceKm(from, to) / 780 * 60 + 25);
  const delay = r() < 0.65 ? 0 : Math.round(r() * (r() < 0.8 ? 35 : 120));
  const leg = {
    number, airline, from: from.iata, to: to.iata, depMs, arrMs: depMs + durMin * 60e3, delay,
    canceled: r() < 0.02, reg, hex, model,
    depTerm: pick(r, ['1', '1', '3', '2']), depGate: `${pick(r, ['A', 'B', 'C', 'D', 'E'])}${1 + Math.floor(r() * 40)}`,
    arrTerm: pick(r, ['1', '2', '3']), arrGate: `${pick(r, ['A', 'B', 'C'])}${1 + Math.floor(r() * 30)}`,
    belt: String(1 + Math.floor(r() * 12)), checkIn: `${100 + Math.floor(r() * 300)}-${110 + Math.floor(r() * 300)}`,
  };
  registry[legKey(number, depMs)] = leg;
  return leg;
}

function aircraftFor(r, prefix) {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const tail = Array.from({ length: prefix.length >= 4 ? 2 : 3 }, () => pick(r, letters)).join('');
  return { reg: prefix + tail, hex: Math.floor(r() * 0xffffff).toString(16).padStart(6, '0'), model: pick(r, MODELS) };
}

function otherAirport(r, exclude) {
  let a; do { a = pick(r, AIRPORTS); } while (exclude.includes(a.iata)); return a;
}

function ensureDay(iata, dayStartMs) {
  const tag = `day:${iata}:${dayStartMs}`;
  if (registry[tag]) return;
  const home = airportByIata(iata) || { iata, name: iata, lat: null, lon: null };
  const r = rng(hash(tag));
  for (let t = dayStartMs + 5.5 * 3600e3; t < dayStartMs + 24 * 3600e3; t += (10 + r() * 22) * 60e3) {
    const depMs = Math.round(t / 300e3) * 300e3;
    const [code, name, prefix] = pick(r, AIRLINES);
    const ac = aircraftFor(r, prefix);
    const other = otherAirport(r, [iata]);
    const isDeparture = r() < 0.5;
    const number = `${code}${100 + Math.floor(r() * 8800)}`;
    const airline = { name, iata: code };
    if (isDeparture) {
      // volo in partenza + la sua tratta precedente (aereo in arrivo)
      const prev = otherAirport(r, [iata]);
      const turn = (45 + r() * 70) * 60e3;
      const prevDur = (distanceKm(prev, home) / 780 * 60 + 25) * 60e3;
      const prevDep = Math.round((depMs - turn - prevDur) / 300e3) * 300e3;
      makeLeg(r, { number: `${code}${100 + Math.floor(r() * 8800)}`, airline, from: prev, to: home, depMs: prevDep, ...ac });
      // anche la tratta precedente compare negli arrivi: le do a sua volta un volo precedente
      const prev2 = otherAirport(r, [prev.iata, iata]);
      const prev2Dur = (distanceKm(prev2, prev) / 780 * 60 + 25) * 60e3;
      makeLeg(r, { number: `${code}${100 + Math.floor(r() * 8800)}`, airline, from: prev2, to: prev, depMs: Math.round((prevDep - (50 + r() * 60) * 60e3 - prev2Dur) / 300e3) * 300e3, ...ac });
      makeLeg(r, { number, airline, from: home, to: other, depMs, ...ac });
    } else {
      const dur = (distanceKm(other, home) / 780 * 60 + 25) * 60e3;
      const d = Math.round((depMs - dur) / 300e3) * 300e3;
      const prev = otherAirport(r, [other.iata, iata]);
      const prevDur = (distanceKm(prev, other) / 780 * 60 + 25) * 60e3;
      makeLeg(r, { number: `${code}${100 + Math.floor(r() * 8800)}`, airline, from: prev, to: other, depMs: Math.round((d - (50 + r() * 60) * 60e3 - prevDur) / 300e3) * 300e3, ...ac });
      makeLeg(r, { number, airline, from: other, to: home, depMs: d, ...ac });
    }
  }
  registry[tag] = 1;
  persist();
}

function statusOf(l, now = Date.now()) {
  if (l.canceled) return 'Canceled';
  const dep = l.depMs + l.delay * 60e3, arr = l.arrMs + l.delay * 60e3;
  if (now >= arr) return 'Arrived';
  if (now >= arr - 15 * 60e3) return 'Approaching';
  if (now >= dep + 10 * 60e3) return 'EnRoute';
  if (now >= dep) return 'Departed';
  if (now >= dep - 15 * 60e3) return 'GateClosed';
  if (now >= dep - 45 * 60e3) return 'Boarding';
  if (l.delay >= 15) return 'Delayed';
  if (now >= dep - 3 * 3600e3) return 'CheckIn';
  return 'Expected';
}

function toFlight(l) {
  const now = Date.now();
  const A = airportByIata(l.from) || { iata: l.from, name: l.from }, B = airportByIata(l.to) || { iata: l.to, name: l.to };
  const depRev = l.depMs + l.delay * 60e3, arrRev = l.arrMs + l.delay * 60e3;
  return {
    number: l.number, callSign: l.number, airline: l.airline, status: statusOf(l, now),
    aircraft: { reg: l.reg, hex: l.hex, model: l.model },
    dep: { iata: A.iata, icao: A.icao, name: A.name, lat: A.lat, lon: A.lon, sched: fmtTime(l.depMs), revised: l.delay ? fmtTime(depRev) : null, actual: now > depRev && !l.canceled ? fmtTime(depRev + 8 * 60e3) : null, terminal: l.depTerm, gate: l.depGate, checkIn: l.checkIn },
    arr: { iata: B.iata, icao: B.icao, name: B.name, lat: B.lat, lon: B.lon, sched: fmtTime(l.arrMs), revised: l.delay ? fmtTime(arrRev) : null, actual: now > arrRev && !l.canceled ? fmtTime(arrRev) : null, terminal: l.arrTerm, gate: l.arrGate, belt: l.belt },
    location: null, _demo: l,
  };
}

const legs = () => Object.entries(registry).filter(([k]) => !k.startsWith('day:')).map(([, v]) => v);
const startOfDay = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const delayed = v => new Promise(res => setTimeout(() => res(v), 250));

export function board(iata) {
  const now = Date.now();
  ensureDay(iata, startOfDay(now));
  ensureDay(iata, startOfDay(now + 86400e3));
  ensureDay(iata, startOfDay(now - 86400e3));
  const from = now - 2 * 3600e3, to = now + 10 * 3600e3;
  const all = legs();
  const dep = all.filter(l => l.from === iata && l.depMs >= from && l.depMs <= to).sort((a, b) => a.depMs - b.depMs);
  const arr = all.filter(l => l.to === iata && l.arrMs >= from && l.arrMs <= to).sort((a, b) => a.arrMs - b.arrMs);
  return delayed({ departures: dep.map(toFlight), arrivals: arr.map(toFlight) });
}

export function flight(number, date) {
  const day = new Date(`${date}T00:00:00`).getTime();
  let found = legs().filter(l => l.number === number && l.depMs >= day && l.depMs < day + 86400e3);
  if (!found.length) {
    // volo non visto in un tabellone: lo genero in modo deterministico dal numero
    const r = rng(hash(`${number}:${date}`));
    const code = number.replace(/\d+$/, '');
    const al = AIRLINES.find(a => a[0] === code) || [code, code, 'I-'];
    const A = pick(r, AIRPORTS), B = otherAirport(r, [A.iata]), P = otherAirport(r, [A.iata]);
    const ac = aircraftFor(r, al[2]);
    const depMs = Math.round((day + (6 + r() * 16) * 3600e3) / 300e3) * 300e3;
    const prevDur = (distanceKm(P, A) / 780 * 60 + 25) * 60e3;
    makeLeg(r, { number: `${code}${100 + Math.floor(r() * 8800)}`, airline: { name: al[1], iata: code }, from: P, to: A, depMs: Math.round((depMs - prevDur - 60 * 60e3) / 300e3) * 300e3, ...ac });
    found = [makeLeg(r, { number, airline: { name: al[1], iata: code }, from: A, to: B, depMs, ...ac })];
    persist();
  }
  return delayed(found.map(toFlight));
}

export function byReg(reg, date) {
  const day = new Date(`${date}T00:00:00`).getTime();
  return delayed(legs().filter(l => l.reg === reg && l.depMs >= day - 6 * 3600e3 && l.depMs < day + 86400e3).map(toFlight));
}

function bearing(a, b) {
  const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function greatCircle(a, b, f) {
  const φ1 = toRad(a.lat), λ1 = toRad(a.lon), φ2 = toRad(b.lat), λ2 = toRad(b.lon);
  const d = distanceKm(a, b) / 6371;
  if (d === 0) return { lat: a.lat, lon: a.lon };
  const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);
  return { lat: toDeg(Math.atan2(z, Math.hypot(x, y))), lon: toDeg(Math.atan2(y, x)) };
}

export function livePosition(f) {
  const l = f._demo;
  if (!l || l.canceled || f.dep.lat == null || f.arr.lat == null) return Promise.resolve(null);
  const now = Date.now();
  const dep = l.depMs + l.delay * 60e3 + 8 * 60e3, arr = l.arrMs + l.delay * 60e3;
  if (now < dep || now > arr) return Promise.resolve(null);
  const p = (now - dep) / (arr - dep);
  const pos = greatCircle(f.dep, f.arr, p), next = greatCircle(f.dep, f.arr, Math.min(1, p + 0.01));
  const minIn = (now - dep) / 60e3, minLeft = (arr - now) / 60e3;
  const alt = Math.round(Math.min(36000, minIn * 1800, minLeft * 1400) / 100) * 100;
  return Promise.resolve({ ...pos, alt, gs: Math.round(alt > 20000 ? 450 + (hash(l.hex) % 30) : 250 + alt / 100), track: bearing(pos, next), at: new Date().toISOString(), source: 'demo' });
}
