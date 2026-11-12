// Avvistamenti ADS-B attorno agli aeroporti che NON pubblicano le marche sul tabellone (es. Pisa).
// Ogni 3 minuti il Durable Object (istanza "adsb") chiede alla rete ADS-B pubblica adsb.lol gli aerei entro
// ~25 miglia da ognuno degli aeroporti consultati di recente e ne tiene i punti sotto i 10000 piedi. Da questi
// punti si ricavano atterraggi e decolli con marche e orario: l'app li incrocia con gli orari effettivi del tabellone
// ufficiale ("atterrato alle 09:24") e così sa quale aereo ha fatto quale volo, anche per le low cost.
//
//   GET /seen?airport=PSA&day=YYYY-MM-DD   →  { airport, day, events: [{ hex, reg, type, cs, ev: 'arr'|'dep', t }], polls, lastPoll }
//
// day è il giorno UTC. Si tengono 3 giorni. Nessun dato da Flightradar24.

import { airportByIata } from '../js/airports.js';

// aeroporti il cui tabellone ufficiale pubblica già le marche: non servono gli avvistamenti, ma la loro copia
// oraria (snapshots.js) serve all'app per incrociare le marche dei voli che arrivano o partono da lì
export const REG_BOARDS = ['MXP', 'LIN', 'GVA', 'ZRH', 'FRA', 'BER', 'ARN', 'AMS', 'LCY', 'DBV'];

const POLL_MS = 3 * 60e3;
const RADIUS_NM = 25;   // la copertura ADS-B vicino a Pisa arriva a ~6000 piedi: si guarda l'avvicinamento, non la pista
const MAX_ALT = 10000;
const MAX_AIRPORTS = 6;
const KEEP_DAYS = 3;
const MAX_PTS = 30;

const SOURCES = (lat, lon, r) => [
  ['adsb.lol', `https://api.adsb.lol/v2/point/${lat}/${lon}/${r}`],
  ['airplanes.live', `https://api.airplanes.live/v2/point/${lat}/${lon}/${r}`],
  ['adsb.fi', `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${r}`],
];
const stub = env => env.WATCHER.get(env.WATCHER.idFromName('adsb'));
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
const nm = (a, b) => {
  const r = Math.PI / 180, x = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2;
  return 6875.5 * Math.asin(Math.sqrt(x));
};

/** GET /seen dal Worker. */
export async function handleSeen(url, env, json) {
  if (!env.WATCHER) return json({ error: 'avvistamenti non configurati (manca il Durable Object WATCHER)' }, 501);
  const airport = (url.searchParams.get('airport') || '').toUpperCase(), day = url.searchParams.get('day') || '';
  if (!/^[A-Z]{3}$/.test(airport) || !/^\d{4}-\d\d-\d\d$/.test(day)) return json({ error: 'parametri non validi (airport, day=YYYY-MM-DD)' }, 400);
  const r = await stub(env).fetch(`https://do/adsb/get?airport=${airport}&day=${day}`);
  return json(await r.json(), r.status, { 'Cache-Control': 'max-age=120' });
}

/** Dal cron orario: fa ripartire il giro di controllo se si era fermato. */
export async function kickAdsb(env) {
  if (!env.WATCHER) return;
  await stub(env).fetch('https://do/adsb/kick', { method: 'POST' });
}

/** Parte eseguita dentro il Durable Object. self = l'istanza Watcher (storage, env). */
export async function adsbDo(self, url) {
  const storage = self.storage;
  if (url.pathname === '/adsb/kick') {
    await storage.put('role', 'adsb');
    const a = await storage.getAlarm();
    if (!a || a < Date.now() - 60e3) await storage.setAlarm(Date.now() + 5e3);
    return { ok: true };
  }
  if (url.pathname === '/adsb/get') {
    const airport = url.searchParams.get('airport'), day = url.searchParams.get('day');
    const v = await storage.get(`adsb:${airport}:${day}`);
    // il giro si riavvia anche da qui, se si era fermato (es. subito dopo una pubblicazione del Worker)
    await storage.put('role', 'adsb');
    const al = await storage.getAlarm();
    if (!al || al < Date.now() - 60e3) await storage.setAlarm(Date.now() + 5e3);
    return { airport, day, events: v ? events(v.ac) : [], polls: v?.polls || 0, lastPoll: v?.lastPoll || null, source: v?.source || null,
      lastError: (await storage.get(`adsberr:${airport}`)) || null, nextPoll: (await storage.getAlarm()) || null };
  }
  return { error: 'not found' };
}

/** Un giro di controllo (alarm del Durable Object "adsb"). */
export async function adsbAlarm(self) {
  const { storage, env } = self;
  const now = Date.now();
  let airports = [];
  try {
    const r = await env.WATCHER.get(env.WATCHER.idFromName('snapshots')).fetch('https://do/snap/airports');
    airports = ((await r.json()).airports || []).filter(a => !REG_BOARDS.includes(a) && airportByIata(a)).slice(0, MAX_AIRPORTS);
  } catch { /* riprovo al prossimo giro */ }
  for (const code of airports) {
    const ap = airportByIata(code);
    try {
      // reti ADS-B pubbliche con la stessa interfaccia (readsb): la prima che risponde
      let list = null, source = null;
      const errs = [];
      for (const [name, u] of SOURCES(ap[4], ap[5], RADIUS_NM)) {
        try {
          const r = await fetch(u, { signal: AbortSignal.timeout(10000), headers: { 'Accept': 'application/json', 'User-Agent': 'tabelloni-voli (uso personale)' } });
          if (!r.ok) { errs.push(`${name} ${r.status}`); continue; }
          const j = await r.json();
          list = j.ac || j.aircraft || []; source = name; break;
        } catch (e) { errs.push(`${name} ${String(e.message || e).slice(0, 80)}`); }
      }
      if (errs.length) await storage.put(`adsberr:${code}`, { at: now, errors: errs });
      if (!list) continue;
      const key = `adsb:${code}:${dayOf(now)}`;
      const cur = (await storage.get(key)) || { ac: {}, polls: 0 };
      for (const a of list) {
        const alt = a.alt_baro === 'ground' ? 0 : typeof a.alt_baro === 'number' ? a.alt_baro : null;
        if (alt == null || alt > MAX_ALT || a.lat == null || !a.hex) continue;
        const hex = a.hex.toLowerCase();
        const t = Math.round(now - (a.seen_pos || 0) * 1000);
        const e = cur.ac[hex] || (cur.ac[hex] = { reg: null, type: null, cs: null, pts: [] });
        e.reg = a.r || e.reg; e.type = a.t || e.type;
        const cs = (a.flight || '').trim(); if (cs) e.cs = cs;
        const vr = typeof a.baro_rate === 'number' ? a.baro_rate : typeof a.geom_rate === 'number' ? a.geom_rate : null;
        e.pts.push([t, alt, Math.round(nm({ lat: a.lat, lon: a.lon }, { lat: ap[4], lon: ap[5] }) * 10) / 10, vr, Math.round(a.gs || 0), cs || null]);
        if (e.pts.length > MAX_PTS) e.pts.splice(0, e.pts.length - MAX_PTS);
      }
      cur.polls++; cur.lastPoll = now; cur.source = source;
      await storage.put(key, cur);
    } catch (e) { await storage.put(`adsberr:${code}`, { at: now, error: String(e.message || e) }); }
  }
  // pulizia dei giorni vecchi
  if ((await storage.get('adsbclean')) !== dayOf(now)) {
    const oldest = dayOf(now - KEEP_DAYS * 86400e3);
    const old = [...(await storage.list({ prefix: 'adsb:' })).keys()].filter(k => k.slice(-10) < oldest);
    if (old.length) await storage.delete(old);
    await storage.put('adsbclean', dayOf(now));
  }
  if (airports.length) await storage.setAlarm(now + POLL_MS);
}

// Dai punti di ogni aereo ricava atterraggi e decolli: in discesa vicino all'aeroporto → atterraggio stimato
// (ora + quota / velocità di discesa), in salita → decollo stimato; un aereo fermo a terra che poi sale è un decollo.
function events(ac) {
  const out = [];
  for (const [hex, a] of Object.entries(ac)) {
    const land = [], off = [];
    for (const [t, alt, d, vr, gs, cs] of a.pts) {
      // minuti alla pista: media tra quota/velocità verticale e distanza/velocità al suolo (+2 per le manovre)
      const eta = vr => Math.min(((alt / Math.max(Math.abs(vr), 600)) + (d / (Math.max(gs, 120) / 60) + 2)) / 2, 25) * 60e3;
      if (alt > 0 && vr != null && vr < -250) land.push({ t: t + eta(vr), cs });
      else if (alt > 0 && vr != null && vr > 250) off.push({ t: t - eta(vr), cs });
      else if (alt === 0 && gs > 60 && d < 3) off.push({ t, cs }); // corsa di decollo (o atterraggio veloce: si separa sotto)
    }
    for (const [list, ev] of [[land, 'arr'], [off, 'dep']]) {
      list.sort((x, y) => x.t - y.t);
      // gruppi a meno di 25 minuti l'uno dall'altro = lo stesso atterraggio/decollo
      let g = [];
      const flush = () => {
        if (!g.length) return;
        const ts = g.map(x => x.t).sort((x, y) => x - y);
        out.push({ hex, reg: a.reg, type: a.type, cs: g.map(x => x.cs).filter(Boolean).pop() || a.cs, ev, t: Math.round(ts[Math.floor(ts.length / 2)]), n: g.length });
        g = [];
      };
      for (const x of list) { if (g.length && x.t - g[g.length - 1].t > 25 * 60e3) flush(); g.push(x); }
      flush();
    }
  }
  return out.sort((x, y) => x.t - y.t);
}
export const _events = events; // per i test
