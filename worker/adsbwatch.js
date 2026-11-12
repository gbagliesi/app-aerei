// Avvistamenti ADS-B attorno agli aeroporti che NON pubblicano le marche sul tabellone (es. Pisa).
// Ogni 4 minuti il Durable Object (istanza "adsb") chiede alla rete ADS-B OpenSky (account gratuito, segreti del Worker
// OPENSKY_CLIENT_ID e OPENSKY_CLIENT_SECRET; le reti adsb.lol, airplanes.live e adsb.fi rifiutano i Worker) gli aerei entro
// ~25 miglia da ognuno degli aeroporti consultati di recente e ne tiene i punti sotto i 10000 piedi. Da questi
// punti si ricavano atterraggi e decolli con marche e orario: l'app li incrocia con gli orari effettivi del tabellone
// ufficiale ("atterrato alle 09:24") e così sa quale aereo ha fatto quale volo, anche per le low cost.
//
//   GET /seen?airport=PSA&day=YYYY-MM-DD   →  { airport, day, events: [{ hex, reg, type, cs, ev: 'arr'|'dep', t }], polls, lastPoll }
//
// day è il giorno UTC. Si tengono 3 giorni. Le marche vengono da hexdb.io (ICAO24 → marche). Nessun dato da Flightradar24.

import { airportByIata } from '../js/airports.js';

// aeroporti il cui tabellone ufficiale pubblica già le marche: non servono gli avvistamenti, ma la loro copia
// oraria (snapshots.js) serve all'app per incrociare le marche dei voli che arrivano o partono da lì
export const REG_BOARDS = ['MXP', 'LIN', 'GVA', 'ZRH', 'FRA', 'BER', 'ARN', 'AMS', 'LCY', 'DBV'];

const POLL_MS = 4 * 60e3; // OpenSky: 1 credito per richiesta su un'area piccola, 4000 crediti al giorno con l'account
const RADIUS_NM = 25;   // la copertura ADS-B vicino a Pisa arriva a ~6000 piedi: si guarda l'avvicinamento, non la pista
const MAX_ALT = 10000;
const MAX_AIRPORTS = 10;
// aeroporti di Giuseppe, guardati sempre anche se non consultati di recente
const ALWAYS = ['PSA', 'BRI', 'FLR', 'FCO', 'CIA'];
const KEEP_DAYS = 3;
const MAX_PTS = 30;

const OS_TOKEN = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const OS_STATES = 'https://opensky-network.org/api/states/all';
const osConfigured = env => !!(env.OPENSKY_CLIENT_ID && env.OPENSKY_CLIENT_SECRET);

async function osToken(storage, env) {
  const c = await storage.get('ostoken');
  if (c && c.exp > Date.now() + 60e3) return c.token;
  const r = await fetch(OS_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.OPENSKY_CLIENT_ID, client_secret: env.OPENSKY_CLIENT_SECRET }) });
  if (!r.ok) throw new Error(`OpenSky token ${r.status}`);
  const j = await r.json();
  await storage.put('ostoken', { token: j.access_token, exp: Date.now() + (j.expires_in || 1800) * 1000 });
  return j.access_token;
}

// marche dall'ICAO24 (OpenSky non le dà): hexdb.io, tenute in memoria per sempre
async function regOf(storage, hex, budget) {
  const k = `hexreg:${hex}`, c = await storage.get(k);
  if (c !== undefined) return c;
  if (budget.n-- <= 0) return null;
  try {
    const r = await fetch(`https://hexdb.io/api/v1/aircraft/${hex}`, { signal: AbortSignal.timeout(6000) });
    const j = r.ok ? await r.json() : null;
    const v = j?.Registration ? { reg: j.Registration, type: j.ICAOTypeCode || null } : { reg: null };
    await storage.put(k, v);
    return v;
  } catch { return null; }
}

/** Aerei attorno a un punto, nel formato readsb (hex, r, t, flight, alt_baro ft, baro_rate ft/min, gs kt, lat, lon). */
async function osAround(storage, env, lat, lon, nmR) {
  const dLat = nmR / 60, dLon = nmR / (60 * Math.cos(lat * Math.PI / 180));
  const u = `${OS_STATES}?lamin=${(lat - dLat).toFixed(3)}&lomin=${(lon - dLon).toFixed(3)}&lamax=${(lat + dLat).toFixed(3)}&lomax=${(lon + dLon).toFixed(3)}`;
  const r = await fetch(u, { signal: AbortSignal.timeout(12000), headers: { Authorization: `Bearer ${await osToken(storage, env)}` } });
  if (!r.ok) throw new Error(`OpenSky ${r.status} ${(await r.text()).slice(0, 100)}`);
  const j = await r.json(), now = (j.time || Date.now() / 1000);
  const budget = { n: 12 };
  const out = [];
  for (const s of j.states || []) {
    const [hex, cs, , tPos, , lo, la, altM, onGround, vel, , vrMs] = s;
    if (la == null) continue;
    const alt = onGround ? 0 : altM == null ? null : Math.round(altM * 3.281);
    if (alt == null || alt > MAX_ALT) continue;
    const info = await regOf(storage, hex, budget);
    out.push({ hex, r: info?.reg || null, t: info?.type || null, flight: (cs || '').trim(), alt_baro: onGround ? 'ground' : alt,
      baro_rate: vrMs == null ? null : Math.round(vrMs * 196.85), gs: vel == null ? 0 : vel * 1.944, lat: la, lon: lo, seen_pos: tPos ? Math.max(0, now - tPos) : 0 });
  }
  return out;
}
const stub = env => env.WATCHER.get(env.WATCHER.idFromName('adsb'));
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
const nm = (a, b) => {
  const r = Math.PI / 180, x = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2;
  return 6875.5 * Math.asin(Math.sqrt(x));
};

/** GET /seen dal Worker. */
export async function handleSeen(url, env, json, request) {
  if (!env.WATCHER) return json({ error: 'avvistamenti non configurati (manca il Durable Object WATCHER)' }, 501);
  // raccoglitore esterno (Home Assistant a casa): GET /seen/targets e POST /seen/push?airport=PSA, con la chiave SEEN_KEY
  if (url.pathname === '/seen/targets' || url.pathname === '/seen/push') {
    const key = url.searchParams.get('key') || '';
    if (!env.SEEN_KEY || key !== env.SEEN_KEY) return json({ error: 'chiave mancante o sbagliata' }, 403);
    if (url.pathname === '/seen/targets') {
      const r = await stub(env).fetch('https://do/adsb/targets');
      return new Response(((await r.json()).lines || []).join('\n') + '\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    if (request.method !== 'POST') return json({ error: 'usa POST' }, 405);
    const body = await request.text();
    if (body.length > 2e6) return json({ error: 'troppo grande' }, 413);
    const r = await stub(env).fetch(`https://do/adsb/push?airport=${encodeURIComponent(url.searchParams.get('airport') || '')}`, { method: 'POST', body });
    return json(await r.json());
  }
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
export async function adsbDo(self, url, request) {
  const storage = self.storage;
  if (url.pathname === '/adsb/kick') {
    await storage.put('role', 'adsb');
    const a = await storage.getAlarm();
    if (!a || a < Date.now() - 60e3) await storage.setAlarm(Date.now() + 5e3);
    return { ok: true };
  }
  // elenco degli aeroporti da guardare, per il raccoglitore esterno (Home Assistant): "PSA 43.6839 10.3927" per riga
  if (url.pathname === '/adsb/targets') return { lines: (await targets(self.env)).map(c => { const ap = airportByIata(c); return `${c} ${ap.lat} ${ap.lon}`; }) };
  if (url.pathname === '/adsb/push' && request?.method === 'POST') {
    const code = (url.searchParams.get('airport') || '').toUpperCase(), ap = airportByIata(code);
    if (!ap) return { error: 'aeroporto sconosciuto' };
    let j; try { j = await request.json(); } catch { return { error: 'JSON non valido' }; }
    const list = (j.ac || j.aircraft || []).slice(0, 400);
    await ingest(storage, code, ap, list, url.searchParams.get('src') || 'adsb.lol (Home Assistant)', Date.now());
    await storage.put('lastpush', Date.now());
    return { ok: true, n: list.length };
  }
  if (url.pathname === '/adsb/get') {
    const airport = url.searchParams.get('airport'), day = url.searchParams.get('day');
    const v = await storage.get(`adsb:${airport}:${day}`);
    // il giro si riavvia anche da qui, se si era fermato (es. subito dopo una pubblicazione del Worker)
    await storage.put('role', 'adsb');
    const al = await storage.getAlarm();
    if (!al || al < Date.now() - 60e3) await storage.setAlarm(Date.now() + 5e3);
    return { airport, day, configured: osConfigured(self.env), lastPush: (await storage.get('lastpush')) || null, events: v ? events(v.ac) : [], polls: v?.polls || 0, lastPoll: v?.lastPoll || null, source: v?.source || null,
      lastError: (await storage.get(`adsberr:${airport}`)) || null, nextPoll: (await storage.getAlarm()) || null };
  }
  return { error: 'not found' };
}

/** Aeroporti da guardare: consultati negli ultimi 3 giorni, senza marche sul tabellone. */
async function targets(env) {
  try {
    const r = await env.WATCHER.get(env.WATCHER.idFromName('snapshots')).fetch('https://do/snap/airports');
    const recent = ((await r.json()).airports || []).filter(a => !REG_BOARDS.includes(a) && airportByIata(a) && !ALWAYS.includes(a));
    return [...ALWAYS, ...recent].slice(0, MAX_AIRPORTS);
  } catch { return [...ALWAYS]; }
}

/** Aggiunge alla giornata di un aeroporto gli aerei visti (formato readsb: hex, r, t, flight, alt_baro, baro_rate, gs, lat, lon). */
async function ingest(storage, code, ap, list, source, now) {
  const key = `adsb:${code}:${dayOf(now)}`;
  const cur = (await storage.get(key)) || { ac: {}, polls: 0 };
  for (const a of list) {
    const alt = a.alt_baro === 'ground' ? 0 : typeof a.alt_baro === 'number' ? a.alt_baro : null;
    if (alt == null || alt > MAX_ALT || a.lat == null || !a.hex) continue;
    const hex = a.hex.toLowerCase();
    const t = Math.round(now - Math.min(a.seen_pos || 0, 120) * 1000);
    const e = cur.ac[hex] || (cur.ac[hex] = { reg: null, type: null, cs: null, pts: [] });
    e.reg = a.r || e.reg; e.type = a.t || e.type;
    const cs = (a.flight || '').trim(); if (cs) e.cs = cs;
    const vr = typeof a.baro_rate === 'number' ? a.baro_rate : typeof a.geom_rate === 'number' ? a.geom_rate : null;
    e.pts.push([t, alt, Math.round(nm({ lat: a.lat, lon: a.lon }, { lat: ap.lat, lon: ap.lon }) * 10) / 10, vr, Math.round(a.gs || 0), cs || null]);
    if (e.pts.length > MAX_PTS) e.pts.splice(0, e.pts.length - MAX_PTS);
  }
  cur.polls++; cur.lastPoll = now; cur.source = source;
  await storage.put(key, cur);
}

/** Un giro di controllo (alarm del Durable Object "adsb"). */
export async function adsbAlarm(self) {
  const { storage, env } = self;
  const now = Date.now();
  let airports = [];
  if (!osConfigured(env)) return; // senza account OpenSky non si chiede nulla (si riprova al cron orario)
  // se arrivano già i dati dal raccoglitore di casa (Home Assistant), OpenSky non serve
  if (Date.now() - ((await storage.get('lastpush')) || 0) < 15 * 60e3) { await storage.setAlarm(now + 3600e3); return; }
  airports = await targets(env);
  let failed = 0;
  for (const code of airports) {
    const ap = airportByIata(code);
    try {
      let list, source = 'OpenSky';
      try { list = await osAround(storage, env, ap.lat, ap.lon, RADIUS_NM); } catch (e) { await storage.put(`adsberr:${code}`, { at: now, error: String(e.message || e) }); failed++; continue; }
      await ingest(storage, code, ap, list, source, now);
    } catch (e) { await storage.put(`adsberr:${code}`, { at: now, error: String(e.message || e) }); }
  }
  // pulizia dei giorni vecchi
  if ((await storage.get('adsbclean')) !== dayOf(now)) {
    const oldest = dayOf(now - KEEP_DAYS * 86400e3);
    const old = [...(await storage.list({ prefix: 'adsb:' })).keys()].filter(k => k.slice(-10) < oldest);
    if (old.length) await storage.delete(old);
    await storage.put('adsbclean', dayOf(now));
  }
  // se OpenSky non risponde a nessun aeroporto (es. 522: non accetta le connessioni dai Worker) riprovo tra un'ora
  if (airports.length) await storage.setAlarm(now + (failed && failed === airports.length ? 3600e3 : POLL_MS));
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
