// Cloudflare Worker per "Tabellone Voli": legge i tabelloni ufficiali di Pisa, Firenze, Ginevra, Fiumicino,
// Ciampino, degli aeroporti pugliesi, di Milano (MXP, LIN), Bologna, Catania, Palermo, Zurigo, Francoforte e Monaco
// (che il browser non può leggere direttamente) e li restituisce in un formato unico.
//
//   GET /board?airport=PSA&nature=D   (D = partenze, A = arrivi)  →  { flights: [...] }
//   GET /debug?airport=PSA&nature=D                                 →  diagnostica (URL provati, inizio risposta)
//
//   /push/...  notifiche sui voli seguiti (Web Push): vedi notify.js
//
// Uso personale: le risposte restano in cache 90 secondi, così l'aeroporto riceve poche richieste.

import { Watcher, setBoardFn } from './notify.js';
export { Watcher };
export const _readBoard = (a, n, env, log) => readBoard(a, n, env, log); // per i test locali

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const CACHE_SECONDS = 90;

// Toscana Aeroporti: API pubblica usata dai siti pisa-airport.com e firenze-airport.it
const TOSCANA = { PSA: 'psa', FLR: 'flr' };
// Aeroporti di Puglia: backend pubblico dell'app ufficiale (nessuna autenticazione)
const PUGLIA = ['BRI', 'BDS', 'FOG', 'TAR'];
// Aeroporti di Roma: pagina pubblica "Voli in tempo reale" di adr.it (portlet Liferay, HTML)
const ADR = {
  FCO: 'https://www.adr.it/web/aeroporti-di-roma-en/pax-fco-realtime-flight',
  CIA: 'https://www.adr.it/pax-cia-voli-in-tempo-reale',
};
// Altri aeroporti: funzione che legge il tabellone (definite più sotto)
const PROBE_HOSTS = ['aeroportoverona.it', 'trevisoairport.it', 'riminiairport.com', 'veniceairport.it', 'veneziaairport.it', 'aeroportodigenova.it', 'airport.genova.it', 'geasar.it', 'aeroportodialghero.it', 'milanbergamoairport.it', 'orioaeroporto.it', 'aeroportodinapoli.it', 'gesac.it',
  // grandi hub e USA (prova 2026-11-09)
  'hongkongairport.com', 'changiairport.com', 'dubaiairports.ae', 'dohahamadairport.com', 'zayedinternationalairport.ae', 'abudhabiairport.ae',
  'tokyo-haneda.com', 'narita-airport.jp', 'bcia.com.cn', 'istairport.com', 'jfkairport.com', 'newarkairport.com', 'flylax.com', 'flysfo.com',
  'dfwairport.com', 'atl.com', 'flychicago.com', 'iah.org', 'fly2houston.com', 'mia-airport.com', 'flydenver.com', 'iflyorlando.com', 'orlandoairports.net',
  // aeroporti europei bloccati dal server di GitHub (prova dal Worker, 2026-11-10)
  'cph.dk', 'aia.gr', 'heraklion-airport.gr', 'brusselsairport.be', 'stuttgart-airport.com', 'flughafen-stuttgart.de', 'glasgowairport.com', 'split-airport.hr', 'euroairport.com', 'finavia.fi', 'maa.nl',
  'baden-airpark.de', 'bru-system.be', 'airport.ai', 'lameziaairport.it', 'sacal.it'];
const OTHER = {
  MXP: (n, log, env) => sea('mxp', n, log, env), LIN: (n, log, env) => sea('lin', n, log, env),
  ZRH: zurich, FRA: frankfurt, CTA: (n, log) => catania(n, log, 'CTA'), CIY: (n, log) => catania(n, log, 'CIY'), TPS: trapani, AOI: ancona, TRS: trieste, MUC: munich, PMO: palermo, BLQ: bologna,
  MAD: (n, log) => aena('MAD', n, log), BCN: (n, log) => aena('BCN', n, log),
  LIS: lisbon, TRN: torino, CAG: cagliari, STN: stansted, LGW: gatwick, LTN: luton, LCY: londonCity, LYS: lyon, BVA: beauvais, AMS: schiphol, GOA: genova, VCE: (n, log) => venezia(n, log), VRN: (n, log) => venezia(n, log, 'www.aeroportoverona.it', 'vrn_store_it', 'Verona'), TSF: (n, log) => venezia(n, log, 'www.trevisoairport.it', 'tsf_store_it', 'Treviso'), HKG: hongKong,
  // altri aeroporti europei (2026-11-10)
  ...Object.fromEntries(['TFS', 'TFN', 'LPA', 'ACE', 'FUE', 'VLC'].map(c => [c, (n, log) => aena(c, n, log)])),
  MAN: manchester, HAM: hamburg, BER: berlin, ARN: (n, log) => swedavia('ARN', n, log), VIE: vienna, PRG: prague, DUB: dublin, EDI: edinburgh,
  CGN: cologne, BUD: budapest, SKG: (n, log) => fraportGreece('skg-airport.gr', 'Salonicco', n, log), CHQ: (n, log) => fraportGreece('chq-airport.gr', 'Chania', n, log),
  WAW: warsaw, KRK: krakow, LCA: (n, log) => hermes('LCA', n, log), PFO: (n, log) => hermes('PFO', n, log), MLA: malta, ZAG: zagreb, DBV: dubrovnik,
  SXB: strasbourg, BSL: euroairport, STR: stuttgart,
  SUF: (n, log) => sacal('SUF', n, log), REG: (n, log) => sacal('REG', n, log), CRV: (n, log) => sacal('CRV', n, log), // FKB (baden-airpark.de) risponde 403 al Worker: lettore badenAirpark pronto ma non attivo
};

const isSupported = a => !!(TOSCANA[a] || PUGLIA.includes(a) || ADR[a] || OTHER[a] || a === 'GVA');
async function readBoard(airport, nature, env, log = []) {
  return OTHER[airport] ? OTHER[airport](nature, log, env) : airport === 'GVA' ? geneva(nature, log) : ADR[airport] ? adr(airport, nature, log) : PUGLIA.includes(airport) ? puglia(airport, nature, log) : toscana(airport, nature, log);
}
setBoardFn((a, n, env) => (isSupported(a) ? readBoard(a, n, env) : null));

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || 'https://gbagliesi.github.io,http://localhost:8000').split(',').map(s => s.trim());
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const airport = (url.searchParams.get('airport') || '').toUpperCase();
    const nature = url.searchParams.get('nature') === 'A' ? 'A' : 'D';
    const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors, ...extra } });

    // notifiche: tutto passa dal Durable Object "Watcher" (iscritti, voli seguiti, controllo periodico)
    if (url.pathname.startsWith('/push/')) {
      if (!env.WATCHER) return json({ error: 'notifiche non configurate nel Worker (manca il Durable Object WATCHER)' }, 501);
      const r = await env.WATCHER.get(env.WATCHER.idFromName('main')).fetch(request);
      return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors } });
    }
    if (url.pathname === '/' ) return json({ ok: true, airports: [...Object.keys(TOSCANA), ...PUGLIA, ...Object.keys(ADR), 'GVA', ...Object.keys(OTHER)] });
    // Prova diagnostica: una richiesta normale (nessun aggiramento) verso i siti degli aeroporti non ancora supportati
    if (url.pathname === '/probe') {
      const target = url.searchParams.get('url') || '';
      let host = '';
      try { host = new URL(target).hostname; } catch {}
      if (!PROBE_HOSTS.some(h => host === h || host.endsWith('.' + h))) return json({ error: 'host non ammesso' }, 400);
      const t0 = Date.now();
      try {
        const body = url.searchParams.get('body');
        // hp: profilo di intestazioni (browser, curl, xhr) per capire se un 403 dipende dagli header o dalla rete
        const hp = url.searchParams.get('hp') || 'browser';
        const base = hp === 'curl' ? { 'User-Agent': 'curl/8.5.0', 'Accept': '*/*' }
          : { 'User-Agent': UA, 'Accept': 'application/json, text/html;q=0.9, */*;q=0.8', 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8,it;q=0.7' };
        if (hp === 'xhr') Object.assign(base, { 'X-Requested-With': 'XMLHttpRequest', 'Referer': new URL(target).origin + '/' });
        const r = await fetch(target, { signal: AbortSignal.timeout(15000), method: body ? 'POST' : 'GET', body: body || undefined,
          headers: { ...base, ...(body ? { 'Content-Type': url.searchParams.get('ctype') || 'application/json' } : {}) } });
        const t = await r.text();
        const grep = url.searchParams.get('grep');
        let matches;
        if (grep) { try { matches = [...new Set((t.match(new RegExp(grep, 'gi')) || []))].slice(0, 60); } catch (e) { matches = [String(e.message)]; } }
        return json({ url: target, hp, status: r.status, cfRay: r.headers.get('cf-ray'), ms: Date.now() - t0, length: t.length, server: r.headers.get('server'), type: r.headers.get('content-type'), start: t.slice(0, 600), matches });
      } catch (e) { return json({ url: target, error: String(e.message || e) }, 502); }
    }
    // Traccia del giorno di un aereo (ICAO24) dalla rete ADS-B adsb.lol (file "trace" di tar1090), ridotta all'essenziale
    if (url.pathname === '/trace') {
      const hex = (url.searchParams.get('hex') || '').toLowerCase();
      if (!/^~?[0-9a-f]{6}$/.test(hex)) return json({ error: 'hex non valido' }, 400);
      const kind = url.searchParams.get('recent') ? 'recent' : 'full';
      const src = `https://globe.adsb.lol/data/traces/${hex.slice(-2)}/trace_${kind}_${hex}.json`;
      const cache = caches.default, key = new Request(`https://cache.local/trace/${kind}/${hex}`);
      const hit = await cache.match(key);
      if (hit) return json(await hit.json());
      try {
        const r = await fetch(src, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://globe.adsb.lol/' } });
        if (r.status === 404) return json({ hex, points: [], source: 'adsb.lol' });
        if (!r.ok) return json({ error: `adsb.lol ha risposto ${r.status}` }, 502);
        const t = await r.json();
        const base = t.timestamp || 0;
        // punto: [secondi unix, lat, lon, quota ft (null = a terra), velocità kt, rotta, nuova tratta 0/1]
        const points = (t.trace || []).filter(p => p[1] != null).map(p => [Math.round(base + p[0]), +p[1].toFixed(4), +p[2].toFixed(4), p[3] === 'ground' ? null : p[3], p[4] == null ? null : Math.round(p[4]), p[5] == null ? null : Math.round(p[5]), (p[6] & 2) ? 1 : 0]);
        const out = { hex, reg: t.r || null, type: t.t || null, points, source: 'adsb.lol' };
        ctx.waitUntil(cache.put(key, new Response(JSON.stringify(out), { headers: { 'Cache-Control': 'max-age=60' } })));
        return json(out);
      } catch (e) { return json({ error: String(e.message || e) }, 502); }
    }
    if (!['/board', '/debug'].includes(url.pathname)) return json({ error: 'not found' }, 404);
    if (!TOSCANA[airport] && !PUGLIA.includes(airport) && !ADR[airport] && !OTHER[airport] && airport !== 'GVA') return json({ error: `aeroporto ${airport} non supportato` }, 400);

    const debug = url.pathname === '/debug';
    const cacheKey = new Request(`https://cache.local/board/${airport}/${nature}`);
    const staleKey = new Request(`https://cache.local/stale/${airport}/${nature}`);
    if (!debug) {
      const hit = await caches.default.match(cacheKey);
      if (hit) return json(await hit.json(), 200, { 'X-Cache': 'HIT' });
    }

    const log = [];
    try {
      const flights = await readBoard(airport, nature, env, log);
      const body = { airport, nature, fetchedAt: new Date().toISOString(), count: flights.length, flights };
      if (debug) return json({ ...body, flights: flights.slice(0, 5), log });
      if (flights.length) ctx.waitUntil(Promise.all([
        caches.default.put(cacheKey, new Response(JSON.stringify(body), { headers: { 'Cache-Control': `max-age=${CACHE_SECONDS}` } })),
        // copia di riserva per 3 ore: si usa solo se il sito dell'aeroporto non risponde
        caches.default.put(staleKey, new Response(JSON.stringify(body), { headers: { 'Cache-Control': 'max-age=10800' } })),
      ]));
      return json(body);
    } catch (e) {
      if (!debug) {
        const old = await caches.default.match(staleKey);
        if (old) return json({ ...(await old.json()), stale: true }, 200, { 'X-Cache': 'STALE' });
      }
      return json({ error: String(e.message || e), log: debug ? log : undefined }, 502);
    }
  },
};

// ---------- Toscana Aeroporti (Pisa, Firenze) ----------
async function toscana(airport, nature, log) {
  const romeDate = off => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(Date.now() + off * 86400e3)).replace(/\//g, '');
  const u = `https://www.toscana-aeroporti.com/console/api/v1/flights/${TOSCANA[airport]}/getFlights?from=${romeDate(-1)}&to=${romeDate(1)}&nat=${nature === 'A' ? 'A' : 'P'}`;
  const t0 = Date.now();
  const r = await fetch(u, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Accept-Language': 'it-IT,it;q=0.9' } });
  const t = await r.text();
  log.push({ url: u, status: r.status, length: t.length, ms: Date.now() - t0, start: t.slice(0, 300) });
  if (!r.ok) throw new Error(`Toscana Aeroporti: errore ${r.status}`);
  const data = JSON.parse(t);
  const root = data?.RESPONSE?.result ?? data?.result ?? data;
  const list = Array.isArray(root) ? root : root?.elements || root?.flights || [];
  // orari dell'API in ora locale di Roma: li confronto con l'ora di Roma attuale espressa allo stesso modo
  const localMs = v => (v ? Date.parse(v.slice(0, 16) + ':00Z') : NaN);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(x => [x.type, x.value]));
  const nowLocal = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`);
  const resources = (f, re) => Object.values(f).filter(Array.isArray).flat()
    .filter(x => x && x.resource && re.test(x.resource.class || '')).map(x => x);
  return list.map(f => {
    const sched = f.scheduledAt, est = f.actualAt || null;
    const gates = resources(f, /Gate/i), desks = resources(f, /CheckIn/i), belts = resources(f, /Belt|Reclaim|Baggage|Carousel/i);
    const gate = gates[gates.length - 1];
    const descr = (f.flightStatus?.descr || '').trim();
    let status = null;
    if (/^(X|CNL|CANC|CAN)/i.test(descr)) status = 'Cancellato';
    else if (est && localMs(est) <= nowLocal) status = nature === 'A' ? 'Atterrato' : 'Decollato';
    else if (nature !== 'A' && gate?.actualStart && !gate.actualEnd) status = 'Imbarco';
    else if (nature !== 'A' && gate?.actualEnd) status = 'Gate chiuso';
    else if (est && sched && localMs(est) - localMs(sched) >= 15 * 60e3) status = 'Ritardato';
    const r0 = f.routing || [];
    const other = nature === 'A' ? r0[0] : r0[r0.length - 1];
    return {
      number: normNum(`${f.carrier?.publicCode || f.carrier?.iataCode || ''}${f.number || ''}`),
      sched: clock(sched), schedDate: sched ? sched.slice(0, 16) : null, est: clock(est), actual: status === 'Atterrato' || status === 'Decollato' ? clock(est) : null,
      status, statusCode: descr || null, gate: gate?.resource?.acronym || null,
      checkin: desks.map(d => d.resource.acronym).filter(Boolean).join(', ') || null, stand: null,
      belt: belts.map(d => d.resource.acronym).filter(Boolean).join(', ') || null,
      reg: null, type: null, city: other?.city?.descr || other?.descr || null, cityCode: other?.acronym || null,
    };
  }).filter(f => f.number && f.sched);
}

const clock = s => { const m = /(\d{1,2})[:.](\d{2})/.exec((s || '').replace(/^\d{4}-\d\d-\d\dT/, '')); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null; };
const normNum = s => (s || '').trim().toUpperCase().replace(/\s+/g, '').replace(/^([A-Z0-9]{2}[A-Z]?)0+(\d)/, '$1$2');

// ---------- Aeroporti di Puglia (Bari, Brindisi, Foggia, Taranto) ----------
// POST https://info.aeroportidipuglia.it/getVoliApp/  campi: aeroporto, lingua, bound (0 partenze, 1 arrivi)
async function puglia(airport, nature, log) {
  const u = 'https://info.aeroportidipuglia.it/getVoliApp/';
  const t0 = Date.now();
  const r = await fetch(u, {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': 'tabellone-voli personale (Cloudflare Worker)', 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ aeroporto: airport, lingua: 'IT', bound: nature === 'A' ? '1' : '0' }),
  });
  const t = await r.text();
  log.push({ url: u, airport, status: r.status, length: t.length, ms: Date.now() - t0, start: t.slice(0, 300) });
  if (!r.ok) throw new Error(`Aeroporti di Puglia: errore ${r.status}`);
  const list = JSON.parse(t);
  if (!Array.isArray(list)) return [];
  // "06/11/2026 05:50:00" (ora di Roma) → "2026-11-06T05:50"
  const iso = s => { const m = /(\d\d)\/(\d\d)\/(\d{4}) (\d\d):(\d\d)/.exec(s || ''); return m ? `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}` : null; };
  const ms = v => (v ? Date.parse(v + ':00Z') : NaN);
  return list.map(f => {
    const sched = iso(f.ST), est = iso(f.ET), act = iso(f.AT);
    let status = (f.NOTE || f.CLS || '').trim() || null;
    if (!status && est && sched && ms(est) - ms(sched) >= 15 * 60e3) status = 'Ritardato';
    const done = /decoll|atterr/i.test(status || '');
    return {
      number: normNum((f.VOLO || '').replace(/\s+/g, '')), sched: clock(sched), schedDate: sched,
      est: clock(est || act), actual: done ? clock(act || est) : null,
      status, statusCode: f.CLS || null, gate: f.GATE || null, checkin: f.CHECK_IN || null, stand: f.POS || null,
      belt: null, reg: null, type: null, city: f.DESTINAZIONE || null, cityCode: f.PROVDEST || null,
      airline: f.descrizione || null,
      codeshare: [f.CODESHARE_1, f.CODESHARE_2, f.CODESHARE_3, f.CODESHARE_4].filter(Boolean).map(c => normNum(c.replace(/\s+/g, ''))),
    };
  }).filter(f => f.number && f.sched);
}

// ---------- Ginevra: feed pubblico dell'app dell'aeroporto ----------
async function geneva(nature, log) {
  const r = await fetch('https://app4airport.com/api/flights', { method: 'POST', headers: { 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json', 'Content-Type': 'application/json' } });
  const t = await r.text();
  log.push({ url: 'app4airport.com/api/flights', status: r.status, length: t.length, start: t.slice(0, 300) });
  const data = JSON.parse(t);
  const list = (nature === 'A' ? data?.flights?.arrivals : data?.flights?.departures) || [];
  const dt = s => (s && /\d{4}-\d\d-\d\d/.test(s) ? s.replace(' ', 'T').slice(0, 16) : null);
  return list.map(f => {
    const sched = nature === 'A' ? f.scheduled_arrival : f.scheduled_departure;
    const est = nature === 'A' ? (f.estimated_landing || f.public_arrival) : (f.estimated_departure || f.public_departure);
    const act = nature === 'A' ? f.actual_landing || f.landed : f.actual_departure || f.takeoff;
    return {
      number: normNum(f.flight_identity), sched: clock(sched), schedDate: dt(sched), est: clock(est), actual: clock(act),
      status: f.flight_status || f.state || null, gate: f.gate || null, checkin: f.checkin || f.check_in || null, stand: null,
      belt: f.carousel || null, reg: fmtReg(f.aircraft_registration), type: f.aircraft || null, city: f.airport_city || f.airport || null,
      delay: f.delay_minuts != null ? +f.delay_minuts : null,
    };
  }).filter(f => f.number);
}

// ---------- Aeroporti di Roma (Fiumicino, Ciampino) ----------
// Tabellone "Voli in tempo reale" di adr.it: HTML server-rendered di una portlet Liferay (nessuna API JSON pubblica).
// Attenzione alle etichette della pagina inglese, tradotte male: "Actual time:" sta sull'orario PREVISTO.
// I blocchi HTML sono affidabili: date-estimated = orario previsto, date-actual = orario effettivo
// (verificato sulle etichette italiane "Orario previsto"/"Orario effettivo" della stessa riga).
// Sui voli partiti adr.it mostra solo il previsto; l'effettivo esiste solo sugli arrivi atterrati.
// _delta=200 è il massimo per pagina (a Fiumicino il giorno intero sono 800+ voli): si paginano con
// _cur limitando _orario alla finestra del tabellone (la portlet accetta orari arbitrari, verificato),
// così Fiumicino sono 2-3 richieste e Ciampino una.
async function adr(airport, nature, log) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
  const fmt = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const nowMin = +parts.hour * 60 + +parts.minute;
  const toMin = s => { const m = /(\d{1,2}):(\d{2})/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : null; };
  // finestra dell'app (da 2 ore fa a 10 ore avanti, con margine), chiusa dentro la giornata odierna
  const from = fmt(Math.max(0, nowMin - 130)), to = fmt(Math.min(1440, nowMin + 610));
  const base = ADR[airport]
    + '?p_p_id=3_WAR_realtimeflightsportlet&p_p_lifecycle=0&p_p_state=normal&p_p_mode=view'
    + `&_3_WAR_realtimeflightsportlet_tab=${nature === 'A' ? 'arrival' : 'departure'}`
    + '&_3_WAR_realtimeflightsportlet_searchType=standard'
    + `&_3_WAR_realtimeflightsportlet_codScaOpe=${airport}`
    + `&_3_WAR_realtimeflightsportlet_date=${today}`
    + `&_3_WAR_realtimeflightsportlet_orario=${from}-${to}`
    + '&_3_WAR_realtimeflightsportlet_delta=200';
  const rows = [];
  let status = 0, ms = 0, pages = 0, covered = false;
  for (let cur = 1; cur <= 8 && !covered; cur++) {
    const t0 = Date.now();
    const r = await fetch(`${base}&_3_WAR_realtimeflightsportlet_cur=${cur}`, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': UA, 'Accept': 'text/html' } });
    status = r.status; ms += Date.now() - t0;
    if (status !== 200) break;
    const page = [...(await r.text()).matchAll(/<tr[^>]*data-qa-id="row"[^>]*>([\s\S]*?)<\/tr>/g)].map(m => m[1]);
    rows.push(...page); pages++;
    const lastSched = toMin(/class="date-estimated__time"[^>]*>\s*(\d{1,2}:\d{2})/.exec(page[page.length - 1] || '')?.[1]);
    covered = page.length < 200 || (lastSched != null && lastSched >= nowMin + 580); // ultima pagina o finestra piena
  }
  log.push({ url: `${base}&_cur=1..${pages}`, status, rows: rows.length, pages, ms });
  if (status !== 200 || !rows.length) throw new Error(`Aeroporti di Roma: nessun dato (HTTP ${status})`);
  return rows.map(html => {
    const flat = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const cells = /class="[^"]*lfr-scheduled-time-column[^"]*"[^>]*>([\s\S]*?)<\/td>/.exec(html)?.[1] || '';
    const sched = /class="date-estimated__time"[^>]*>\s*(\d{1,2}:\d{2})/.exec(cells)?.[1] || null;
    const act = /class="date-actual__time"[^>]*>\s*(\d{1,2}:\d{2})/.exec(cells)?.[1] || null;
    // prima coppia codice+numero = volo della riga; se c'è "Operato da", l'ultima è il vettore effettivo
    const nums = [...flat.matchAll(/\b([A-Z][A-Z0-9]|\d[A-Z])\s?(\d{1,4})\b/g)].map(m => normNum(m[0]));
    const status = /(?:Flight status|Stato volo):\s*([A-Za-zÀ-ÿ'’ ]+?)(?:\s+Tracking|\s+Activate|\s+Traccia|\s+Attiva|\s+Dettagli|\s+Details|\s+Check-in|$)/.exec(flat)?.[1]?.trim() || null;
    // città dalla sua cella (card-fg__dest: negli arrivi la colonna si chiama lfr-flight-departure-column,
    // nelle partenze lfr-flight-destination-column; e ci sono accentate estese: Brașov, CHIȘINĂU)
    const dest = /class="[^"]*card-fg__dest[^"]*"[^>]*>([\s\S]*?)<\/td>/.exec(html)?.[1]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const cityM = /^(.*?)\s*\(([A-Z]{3})\)/.exec(dest || '');
    // il tabellone raggruppa per data programmata: schedDate è la data richiesta
    const schedDate = sched ? `${today}T${sched.padStart(5, '0')}` : null;
    return {
      number: nums[0] || null, sched, schedDate, est: act, actual: act,
      status, gate: null, checkin: null, stand: null, belt: null, reg: null, type: null,
      city: cityM?.[1]?.trim() || null, cityCode: cityM?.[2] || null,
      codeshare: /Operato da/.test(flat) && nums.length > 1 ? [nums[nums.length - 1]] : undefined,
    };
  }).filter(f => f.number && f.sched);
}

// Marche nel formato con trattino (EI-DWS, F-HPNB, HB-JQW, N123AB)
const PREFIX2 = ['VN', 'UK', 'EI', 'EC', 'HB', 'OE', 'PH', 'OO', 'SE', 'LN', 'OY', 'OH', 'SX', 'YR', 'TC', 'HA', 'SP', 'OK', 'OM', 'CS', 'TF', 'ES', 'YL', 'LY', 'UR', 'LZ', 'ER', 'S5', '9A', '9H', '4X', 'A6', 'A7', 'A9', 'VP', 'VQ', 'JA', 'HL', 'VH', 'ZS', 'SU', 'CN', 'TS', '5B', 'Z3', 'E7', '4O', 'T7', 'LX', 'EW', 'RA', 'VT', 'B'];
function fmtReg(r) {
  r = (r || '').trim().toUpperCase();
  if (!r) return null;
  if (r.includes('-') || /^N\d/.test(r)) return r;
  const p2 = PREFIX2.find(p => p.length === 2 && r.startsWith(p) && r.length >= 5);
  if (p2) return `${p2}-${r.slice(2)}`;
  if (/^[DFGIMC]/.test(r) && r.length === 5) return `${r[0]}-${r.slice(1)}`;
  return r;
}

// ---------- utilità comuni per i nuovi aeroporti ----------
// Data e ora locali di un fuso: { date: 'YYYY-MM-DD', hm: 'HH:MM', min }
function localNow(tz, offMin = 0) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(Date.now() + offMin * 60e3)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, min: +p.hour * 60 + +p.minute };
}
const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
const hmMin = s => { const m = /(\d{1,2}):(\d{2})/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : null; };
// ISO UTC ("...Z") → ora locale "YYYY-MM-DDTHH:MM"
const utcToLocal = (iso, tz) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (isNaN(t)) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};
const trimOrNull = v => { const t = (v == null ? '' : String(v)).trim(); return t && t !== '--' && t !== '-' ? t : null; };
const strip = html => (html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
// Tabelloni in HTML con solo l'orario: assegna la data seguendo l'ordine (quando l'orario torna indietro di
// oltre 6 ore è il giorno dopo); il tratto con più voli è la data di riferimento `base` (oggi), salvo `fixedStart`.
function assignDates(rows, base, fixedStart = false) {
  let day = 0, prev = null;
  const days = rows.map(r => { const m = hmMin(r.sched); if (prev != null && m != null && m < prev - 360) day++; if (m != null) prev = m; return day; });
  let ref = 0;
  if (!fixedStart) {
    const count = {};
    days.forEach(d => (count[d] = (count[d] || 0) + 1));
    ref = +Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] || 0;
  }
  rows.forEach((r, i) => { r.schedDate = r.sched ? `${addDays(base, days[i] - ref)}T${r.sched}` : null; });
  return rows;
}
// Stati in tedesco/inglese → italiano (come gli altri tabelloni)
function statusIt(t, nature) {
  const s = (t || '').trim();
  const l = s.toLowerCase();
  if (!l || l === 'geplant' || l === 'scheduled' || l === 'planned') return null;
  const m = /^(?:gate info|next info|nächste info|gate info um|next info at)\D*(\d{1,2}:\d{2})/i.exec(s);
  if (m) return /gate/i.test(s) ? `Gate alle ${m[1]}` : `Info alle ${m[1]}`;
  if (/^(departing|expected|estimated|prévu|on time|in orario|previsto|scheduled)\b/i.test(s) && !/annul|cancel/i.test(s)) return null;
  const map = [
    [/annul|cancel|soppress/, 'Cancellato'], [/umgeleitet|divert|dérout|dirott/, 'Dirottato'],
    [/boarding (closed|finished|completed)|embarquement terminé|eingestiegen/, 'Gate chiuso'],
    [/gelandet|landed|auf position|gepäck|baggage|bags|arrived|arrivat|arrivé|arrive [aà]|atterr|bagagli/, 'Atterrato'],
    [/anflug|approach|approche|in arrivo/, 'In arrivo'],
    [/attesa decollo/, 'In rullaggio'],
    [/gestartet|departed|airborne|en route|unterwegs|décollé|decoll|partito/, nature === 'A' ? 'In volo' : 'Decollato'],
    [/rolling|rollt|taxied/, 'In rullaggio'],
    [/letzter aufruf|last call|final call|ultima chiamata|ultimo avviso|dernier appel/, 'Ultima chiamata'],
    [/boarding|einsteigen|embarquement|imbarco/, 'Imbarco'],
    [/gate geschlossen|closed|geschlossen|fermé|chiuso/, 'Gate chiuso'],
    [/gate offen|gate open/, 'Gate aperto'],
    [/zum gate|go to gate|al gate/, 'Al gate'],
    [/wait in lounge/, 'Attendere in sala'],
    [/verspät|delay|retard|ritard/, 'Ritardato'],
    [/check-?in|enregistrement|bag drop|accettazione/, 'Check-in'],
  ];
  for (const [re, it] of map) if (re.test(l)) return it;
  return s;
}
const isDone = st => /^(Atterrato|Decollato)$/.test(st || '');

// ---------- Milano Malpensa e Linate (SEA) ----------
// API usata dai siti milanomalpensa-airport.com e milanolinate-airport.com: risponde solo con l'header keyId,
// la chiave pubblica che il sito stesso manda (se SEA la cambia, si aggiorna la variabile SEA_KEY_ID del Worker).
// Orari in ora locale "YYYY-MM-DD HH:MM"; una chiamata per giornata.
const SEA_KEY_DEFAULT = '6bc034ea-ae66-40ce-891e-3dccf63cb2eb';
async function sea(code, nature, log, env) {
  const key = (env && env.SEA_KEY_ID) || SEA_KEY_DEFAULT;
  const dates = [...new Set([localNow('Europe/Rome', -150).date, localNow('Europe/Rome', 630).date])];
  const all = [];
  for (const d of dates) {
    const u = `https://apiextra.seamilano.eu/ols-flights/v1/it/operative/flights/lists?movementType=${nature === 'A' ? 'A' : 'D'}&dateFrom=${d}+00:00&dateTo=${d}+23:59&loadingType=P&airportReferenceIata=${code}&mfFlightType=P`;
    const t0 = Date.now();
    // la prima risposta della giornata a volte supera i 15 s: attesa più lunga e un secondo tentativo
    const get = async () => { const r = await fetch(u, { signal: AbortSignal.timeout(20000), headers: { 'keyId': key, 'Accept': 'application/json', 'User-Agent': UA } }); return [r, await r.text()]; };
    const [r, t] = await get().catch(() => get());
    log.push({ url: u, status: r.status, length: t.length, ms: Date.now() - t0, start: t.slice(0, 200) });
    if (!r.ok) { if (all.length) continue; throw new Error(`SEA: errore ${r.status}${r.status === 401 ? ' (chiave keyId non valida)' : ''}`); }
    all.push(...(JSON.parse(t).data || []));
  }
  const A = nature === 'A';
  return all.map(f => {
    const sched = A ? f.scheduledArrivalTime : f.scheduledTime;
    const est = A ? f.estimatedArrivalTime : f.estimatedTime;
    const act = A ? f.actualArrivalTime : f.actualTime;
    const other = (f.routing || []).find(x => x.airportRoutingType === (A ? 'origin' : 'destination')) || {};
    const mine = (f.routing || []).find(x => x.airportIata === code.toUpperCase()) || {};
    const desc = trimOrNull(f.statusPubblicDescription);
    let status = desc ? desc.charAt(0) + desc.slice(1).toLowerCase() : null;
    if (act) status = A ? 'Atterrato' : 'Decollato';
    else if (f.statusPubblic === 'FCL') status = 'Gate chiuso';
    else if (!status && est && sched && hmMin(est.slice(11)) != null && Date.parse(est.replace(' ', 'T') + ':00Z') - Date.parse(sched.replace(' ', 'T') + ':00Z') >= 15 * 60e3) status = 'Ritardato';
    return {
      number: normNum(f.flightNumber), sched: clock(sched?.slice(11)), schedDate: sched ? sched.replace(' ', 'T').slice(0, 16) : null,
      est: clock((act || est || '').slice(11)), actual: act ? clock(act.slice(11)) : null,
      estAt: (act || est || '').replace(' ', 'T').slice(0, 16) || null, actualAt: act ? act.replace(' ', 'T').slice(0, 16) : null,
      status, statusCode: f.statusPubblic || null, gate: trimOrNull(f.gate), checkin: trimOrNull(f.checkIn), stand: trimOrNull(f.stand),
      belt: trimOrNull(f.baggageClaim), reg: fmtReg(f.aircraftRegistration), type: trimOrNull(f.aircraftType),
      terminal: trimOrNull(mine.terminal)?.replace(/^T/i, '') || null, city: other.airportLabel || other.airportDescription || null, cityCode: other.airportIata || null,
      airline: f.airlineDescription || null,
      codeshare: (f.codeShare || []).map(c => normNum(c.codeShareFlightNumber)).filter(Boolean),
    };
  }).filter(f => f.number && f.sched);
}

// ---------- Zurigo ----------
// JSON pubblico del sito (5 giorni, ~2,7 MB): orari in UTC ("...Z"). Per non sprecare CPU del Worker
// si analizzano solo i voli del giorno giusto (oggetti piatti, senza annidamenti).
async function zurich(nature, log) {
  const u = 'https://flightdata.flughafen-zuerich.ch/flights';
  const t0 = Date.now();
  const r = await fetch(u, { signal: AbortSignal.timeout(20000), cf: { cacheTtl: 60, cacheEverything: true }, headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  const t = await r.text();
  log.push({ url: u, status: r.status, length: t.length, ms: Date.now() - t0 });
  if (!r.ok) throw new Error(`Zurigo: errore ${r.status}`);
  const tz = 'Europe/Zurich';
  const days = [...new Set([localNow(tz, -150).date, localNow(tz, 630).date])].map(d => `"SDT":"${d}"`);
  const type = `"flightType":"${nature === 'A' ? 'A' : 'D'}"`;
  const body = t.trim().replace(/^\[\{?|\}?\]$/g, '');
  const list = body.split(/\},\s*\{/).filter(x => x.includes(type) && days.some(d => x.includes(d))).map(x => { try { return JSON.parse(`{${x}}`); } catch { return null; } }).filter(Boolean);
  const A = nature === 'A';
  return list.filter(f => f.isCommercial !== false).map(f => {
    const sched = utcToLocal(A ? f.STA : f.STD, tz), est = utcToLocal(A ? f.ETA : f.ETD, tz), act = utcToLocal(A ? f.ATA : f.ATD, tz);
    let status = statusIt(f.statusTextEn, nature);
    if (act && !/Cancellato|Dirottato/.test(status || '')) status = A ? 'Atterrato' : 'Decollato';
    return {
      number: normNum(`${f.FLC || ''}${f.FLN || ''}`), sched: clock(sched?.slice(11)), schedDate: sched,
      est: clock((act || est || '').slice(11)), actual: act ? clock(act.slice(11)) : null,
      estAt: act || est || null, actualAt: act || null,
      status, statusCode: f.statusCode != null ? String(f.statusCode) : null, gate: trimOrNull(f.GAT), checkin: trimOrNull(f.CIR),
      stand: null, belt: trimOrNull(f.BDC), reg: fmtReg(f.REG), type: f.model || trimOrNull(f.TYP), terminal: trimOrNull(f.TER),
      city: f.cityEn || f.airportName || null, cityCode: (A ? f.POR : f.PDS) || null, airline: f.airline || null,
      codeshare: (f.codeShare || '').split(',').map(c => normNum(c)).filter(Boolean),
    };
  }).filter(f => f.number && f.sched);
}

// ---------- Francoforte ----------
// JSON pubblico del sito, a pagine: senza il parametro time la pagina 1 parte da "adesso", le pagine 0, -1… vanno indietro.
// Orari con fuso esplicito (+0100). Le righe "TRS" sono treni (Lufthansa Express Rail): escluse.
async function frankfurt(nature, log) {
  const kind = nature === 'A' ? 'arrivals' : 'departures';
  const pages = [-1, 0, 1, 2, 3, 4, 5, 6];
  const res = await Promise.all(pages.map(async p => {
    const u = `https://www.frankfurt-airport.com/de/_jcr_content.flights.json/filter?perpage=100&lang=de-DE&page=${p}&flighttype=${kind}`;
    try {
      const t0 = Date.now();
      const r = await fetch(u, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*' } });
      const t = await r.text();
      log.push({ url: u, status: r.status, length: t.length, ms: Date.now() - t0 });
      return r.ok && t ? JSON.parse(t).data || [] : [];
    } catch (e) { log.push({ url: u, error: String(e.message || e) }); return []; }
  }));
  const seen = new Set(), A = nature === 'A';
  const loc = s => (s ? s.slice(0, 16) : null);
  const out = [];
  for (const f of res.flat()) {
    if (!f || f.ac === 'TRS' || seen.has(f.id)) continue;
    seen.add(f.id);
    let status = statusIt(f.status, nature);
    const est = f.esti || null;
    const done = isDone(status);
    out.push({
      number: normNum(f.fnr), sched: clock(f.sched?.slice(11)), schedDate: loc(f.sched),
      est: clock(est?.slice(11)), actual: done ? clock((est || f.sched)?.slice(11)) : null,
      estAt: loc(est), actualAt: done ? loc(est || f.sched) : null,
      status, statusCode: f.flstatus != null ? String(f.flstatus) : null, gate: trimOrNull(f.gate),
      checkin: trimOrNull(f.schalter), stand: trimOrNull(f.pos), belt: (f.bag || []).join(', ') || null,
      reg: fmtReg(f.reg), type: trimOrNull(f.ac), terminal: trimOrNull(f.terminal),
      city: f.apname || null, cityCode: f.iata || null, airline: f.alname || null,
      codeshare: (f.cs || []).map(normNum).filter(Boolean),
    });
  }
  if (!out.length) throw new Error('Francoforte: nessun volo (pagine vuote)');
  return out.sort((a, b) => (a.schedDate < b.schedDate ? -1 : 1));
}

// ---------- Catania ----------
// API GraphQL del sito aeroporto.catania.it (nessuna chiave): una chiamata per giornata, fino a 200 voli.
// Orari "DD/MM/YYYY, HH:MM" in ora locale.
const CTA_QUERY = 'query flights($offset:Int=0,$size:Int=10,$airport:Airport!,$date:FlightDay!,$keyword:String,$locale:Locale!,$timeRange:String,$type:FlightType!){flights(offsetPagination:{offset:$offset,size:$size},filters:{airport:$airport,date:$date,locale:$locale,type:$type,timeRange:$timeRange,keyword:$keyword}){edges{node{airline terminal scheduledTime rescheduledTime origin flightStatus gate flightNumber estimatedTime destination codesharing{flightNumber airline} checkIn baggageClaim destinationCity originCity divertedTo}} pageInfo{offsetPagination{total hasMore}}}}';
async function catania(nature, log, airport = 'CTA') {
  const A = nature === 'A';
  // TOMORROW è un tentativo (verificato solo TODAY): se l'API non lo accetta resta solo oggi
  const days = localNow('Europe/Rome').min >= 13 * 60 ? ['TODAY', 'TOMORROW'] : ['TODAY'];
  const all = [];
  for (const day of days) {
    const u = 'https://www.aeroporto.catania.it/api/middleware/flights';
    try {
      const t0 = Date.now();
      const r = await fetch(u, {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': UA, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ query: CTA_QUERY, variables: { offset: 0, size: 200, airport, date: day, locale: 'IT', type: A ? 'ARRIVALS' : 'DEPARTURES', timeRange: '00:00 - 23:59', keyword: '' } }),
      });
      const t = await r.text();
      log.push({ url: u, day, status: r.status, length: t.length, ms: Date.now() - t0, start: t.slice(0, 200) });
      if (!r.ok) { if (day === 'TODAY') throw new Error(`${airport === 'CIY' ? 'Comiso' : 'Catania'}: errore ${r.status}`); continue; }
      all.push(...(JSON.parse(t)?.data?.flights?.edges || []).map(e => e.node));
    } catch (e) { if (day === 'TODAY') throw e; }
  }
  const iso = s => { const m = /(\d\d)\/(\d\d)\/(\d{4}),?\s*(\d\d):(\d\d)/.exec(s || ''); return m ? `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}` : null; };
  const CODES = { LAN: 'Atterrato', DEC: 'Decollato', CNL: 'Cancellato', CAN: 'Cancellato', CANC: 'Cancellato', DIV: 'Dirottato', DIR: 'Dirottato', IMB: 'Imbarco', BOR: 'Imbarco', BRD: 'Imbarco', RIT: 'Ritardato', DEL: 'Ritardato' };
  return all.map(f => {
    const sched = iso(f.scheduledTime), est = iso(f.rescheduledTime) || iso(f.estimatedTime);
    const code = (f.flightStatus || '').trim().toUpperCase();
    let status = CODES[code] || (code && code !== 'TBD' ? code : null);
    if (f.divertedTo) status = 'Dirottato';
    const place = A ? f.origin : f.destination;
    const pm = /^(.*?)\s*\(([A-Z]{3})\)/.exec(place || '');
    return {
      number: normNum(f.flightNumber), sched: clock(sched?.slice(11)), schedDate: sched,
      est: clock(est?.slice(11)), actual: isDone(status) ? clock((est || sched)?.slice(11)) : null,
      estAt: est, actualAt: isDone(status) ? est || sched : null,
      status, statusCode: code || null, gate: trimOrNull(f.gate), checkin: trimOrNull(f.checkIn)?.replace(/\s*>\s*/, '–') || null,
      stand: null, belt: trimOrNull(f.baggageClaim), reg: null, type: null, terminal: trimOrNull(f.terminal),
      city: pm ? pm[1] : place || null, cityCode: pm ? pm[2] : null, airline: f.airline || null,
      codeshare: (f.codesharing || []).map(c => normNum(c.flightNumber)).filter(Boolean),
    };
  }).filter(f => f.number && f.sched);
}

// ---------- Monaco di Baviera ----------
// Frammenti HTML del tabellone di munich-airport.de (/flightsearch, 50 voli per pagina, nessun token).
// Le righe hanno solo l'orario: la data si ricava dall'ora di partenza della ricerca. Il gate non è nell'elenco.
async function munich(nature, log) {
  const tz = 'Europe/Berlin', start = localNow(tz, -130);
  const kind = nature === 'A' ? 'arrivals' : 'departures';
  const q = `from=${start.date}T${start.hm}%3A00&allow_scroll_back=1&per_page=50&allow_pagination=1&min_date=${addDays(start.date, -1)}T00%3A00%3A00&max_date=${addDays(start.date, 2)}T00%3A00%3A00`;
  const pages = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map(async p => {
    const u = `https://www.munich-airport.de/flightsearch/${kind}?${q}&page=${p}`;
    try {
      const t0 = Date.now();
      const r = await fetch(u, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': UA, 'Accept': 'text/html' } });
      const t = await r.text();
      log.push({ url: u, status: r.status, length: t.length, ms: Date.now() - t0 });
      if (!r.ok) return [];
      let big = t.slice(Math.max(0, t.indexOf('fp-flights-table-large')));
      big = big.slice(0, big.indexOf('</table>'));
      return [...big.matchAll(/<tr data-flight-id="([^"]*)" class="fp-flight-item">([\s\S]*?)<\/tr>/g)].map(m => [m[1], m[2]]);
    } catch (e) { log.push({ url: u, error: String(e.message || e) }); return []; }
  }));
  const seen = new Set(), rows = [];
  for (const [id, html] of pages.flat()) {
    if (seen.has(id)) continue;
    seen.add(id);
    const cell = c => strip(new RegExp(`<td class="fp-flight-${c}"[^>]*>([\\s\\S]*?)</td>`).exec(html)?.[1]);
    const num = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(cell('number'));
    const [sched, exp] = cell('time-muc').split('|').map(s => trimOrNull(s));
    const place = /^(.*?)\s*\(([A-Z]{3})\)/.exec(cell('airport'));
    const status = statusIt(cell('status'), nature);
    rows.push({
      number: normNum(num ? num[1] : cell('number')), sched: clock(sched), est: clock(exp), actual: isDone(status) ? clock(exp || sched) : null,
      status, statusCode: cell('status') || null, gate: null, checkin: null, stand: null, belt: null, reg: null,
      type: num ? num[2] : null, terminal: trimOrNull(cell('area'))?.replace(/^T/i, '') || null, city: place ? place[1] : cell('airport') || null, cityCode: place ? place[2] : null,
      airline: /aria-label="([^"]*)"/.exec(html)?.[1] || null,
    });
  }
  return assignDates(rows, start.date, true).filter(f => f.number && f.sched);
}

// ---------- Palermo ----------
// Pagina "Voli" di aeroportodipalermo.it: due tabelle HTML (partenze, arrivi) con i voli di oggi.
async function palermo(nature, log) {
  const u = 'https://www.aeroportodipalermo.it/voli/';
  const t0 = Date.now();
  const r = await fetch(u, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'it-IT,it;q=0.9' } });
  const t = await r.text();
  log.push({ url: u, status: r.status, length: t.length, ms: Date.now() - t0 });
  if (!r.ok) throw new Error(`Palermo: errore ${r.status}`);
  const A = nature === 'A';
  let seg = t.slice(Math.max(0, t.indexOf(A ? 'id="nav-arrivi"' : 'id="partenze"')));
  seg = seg.slice(0, seg.indexOf('</table>'));
  const rows = [...seg.matchAll(/<tr class="text-uppercase justify-content-center[^"]*">([\s\S]*?)<\/tr>/g)].map(m => m[1]);
  const today = localNow('Europe/Rome').date;
  return rows.map(html => {
    const tds = [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]);
    const c = tds.map(strip);
    const volo = tds[2] || '';
    const number = strip(/<a[^>]*>([\s\S]*?)<\/a>/.exec(volo)?.[1] || c[2]);
    const shared = [...(/list-shared[^>]*>([\s\S]*?)<\/ul>/.exec(volo)?.[1] || '').matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map(m => normNum(strip(m[1]))).filter(Boolean);
    const st = trimOrNull(A ? c[6] : c[7]);
    const status = st ? st.charAt(0) + st.slice(1).toLowerCase() : null;
    const sched = clock(c[4]), est = clock(c[5]);
    return {
      number: normNum(number), sched, schedDate: sched ? `${today}T${sched}` : null, est, actual: isDone(status) ? est || sched : null,
      status, statusCode: st, gate: A ? null : trimOrNull((c[6] || '').replace(/^gate\s*/i, '')), checkin: null, stand: null, belt: null,
      reg: null, type: null, city: c[3] || null, cityCode: null, airline: c[1] || null, codeshare: shared.filter(n => n !== normNum(number)),
    };
  }).filter(f => f.number && f.sched);
}

// ---------- Bologna ----------
// Pagina "Voli in tempo reale" di bologna-airport.it (ASP.NET, schede HTML con i voli di oggi).
async function bologna(nature, log) {
  const u = 'https://www.bologna-airport.it/voli/vola-da-bologna/voli-in-tempo-reale/?idC=62178';
  const t0 = Date.now();
  const r = await fetch(u, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'it,en;q=0.8' } });
  const t = await r.text();
  log.push({ url: u, status: r.status, length: t.length, ms: Date.now() - t0 });
  if (!r.ok) throw new Error(`Bologna: errore ${r.status}`);
  const A = nature === 'A';
  const iD = t.indexOf('id="section-departures"', t.indexOf('<section')), iA = t.indexOf('id="section-arrivals"', iD);
  const seg = A ? t.slice(iA) : t.slice(iD, iA > 0 ? iA : undefined);
  const cards = [...seg.matchAll(/<div class="c-flight-info-card__inner">([\s\S]*?)<div class="c-flight-info-card__footer">/g)].map(m => m[1]);
  const rows = cards.map(html => {
    const sched = clock(/class="schedule__time"[^>]*>\s*([\d:]+)/.exec(html)?.[1]);
    const late = clock(/<span class="c-rounded-label[^"]*"[^>]*>\s*([\d:]+)/.exec(html)?.[1]);
    const body = /c-flight-info-card__body">\s*<p>([\s\S]*?)<\/p>/.exec(html)?.[1] || '';
    const parts = strip(body).split('|').map(s => s.trim()).filter(Boolean);
    const nums = parts.slice(1).map(normNum).filter(Boolean);
    const stHtml = /<div class="flight-status">([\s\S]*?)<\/div>\s*<\/div>/.exec(html)?.[1] || '';
    const first = /<div><p>([^<]*)<strong>([^<]*)<\/strong>/.exec(stHtml) || /<div><p>([^<]*)<\/p>/.exec(stHtml);
    const label = (first?.[1] || '').trim(), value = (first?.[2] || '').trim();
    let status = null, checkin = null, actual = null;
    if (/^check-in/i.test(label)) checkin = trimOrNull(value);
    else if (label) status = label;
    if (/decollato|atterrato/i.test(label)) actual = clock(value);
    const gate = trimOrNull(/Gate\s*<strong>([^<]*)<\/strong>/.exec(stHtml)?.[1]);
    const city = strip(/<div class="place">([\s\S]*?)<\/div>/.exec(html)?.[1]);
    const cm = /^(.*?)\s+([A-Z]{3})$/.exec(city);
    return {
      number: nums[0] || null, sched, est: actual || late, actual, status, statusCode: label || null, gate, checkin,
      stand: null, belt: null, reg: null, type: null, city: cm ? cm[1] : city || null, cityCode: cm ? cm[2] : null,
      airline: parts[0] || null, codeshare: nums.slice(1),
    };
  });
  return assignDates(rows, localNow('Europe/Rome').date).filter(f => f.number && f.sched);
}

// Orario dentro un testo di stato ("Departed 06:05", "DÉCOLLÉ À 06:09", "PREVISTO ALLE ORE 07:40")
const timeIn = t => clock(/(\d{1,2}[:.]\d{2})/.exec(t || '')?.[1]);
const titleCase = v => (v || '').toLowerCase().replace(/(^|[\s\-/(])\S/g, c => c.toUpperCase()) || null;
async function getText(u, log, opt = {}) {
  const t0 = Date.now();
  const r = await fetch(u, { signal: AbortSignal.timeout(opt.timeout || 15000), method: opt.method || 'GET', body: opt.body,
    headers: { 'User-Agent': UA, 'Accept': opt.accept || 'application/json, text/html;q=0.9, */*;q=0.8', 'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8', ...(opt.headers || {}) } });
  const t = await r.text();
  log.push({ url: u, status: r.status, length: t.length, ms: Date.now() - t0, start: opt.quiet ? undefined : t.slice(0, 160) });
  if (!r.ok) throw new Error(`${opt.name || 'aeroporto'}: errore ${r.status}`);
  return t;
}
// Righe <tr> di una tabella → celle di testo
const tableRows = html => [...(html || '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => strip(c[1])));

// ---------- Madrid e Barcellona (Aena) ----------
// JSON pubblico di aena.es: oggi e domani (dosDias=si), un array con molti voli (Madrid ~4,5 MB). Per risparmiare CPU
// si analizzano solo i record nella finestra del tabellone. Orari locali "dd/mm/yyyy" + "HH:MM:SS".
const CANARY = ['TFS', 'TFN', 'LPA', 'ACE', 'FUE', 'SPC'];
async function aena(code, nature, log) {
  const u = `https://www.aena.es/sites/Satellite?pagename=AENA_ConsultarVuelos&airport=${code}&flightType=${nature === 'A' ? 'L' : 'S'}&dosDias=si`;
  const t = await getText(u, log, { name: 'Aena', timeout: 20000, quiet: true, headers: { 'Accept': 'application/json, text/javascript, */*' } });
  const tz = CANARY.includes(code) ? 'Atlantic/Canary' : 'Europe/Madrid', from = localNow(tz, -180), to = localNow(tz, 660);
  const key = (d, hm) => `${d}T${hm}`;
  const lo = key(from.date, from.hm), hi = key(to.date, to.hm);
  const body = t.trim().replace(/^\[\{?|\}?\]$/g, '');
  const list = [];
  for (const x of body.split(/\},\s*\{/)) {
    const m = /"fecha":"(\d\d)\/(\d\d)\/(\d{4})","horaProgramada":"(\d\d:\d\d)/.exec(x);
    if (!m) continue;
    const k = key(`${m[3]}-${m[2]}-${m[1]}`, m[4]);
    if (k < lo || k > hi) continue;
    try { list.push(JSON.parse(`{${x}}`)); } catch { /* record non valido */ }
  }
  const nul = v => (v == null || v === 'null' || v === '' ? null : String(v).trim());
  const iso = (d, h) => { const m = /(\d\d)\/(\d\d)\/(\d{4})/.exec(d || ''); return m && h ? `${m[3]}-${m[2]}-${m[1]}T${h.slice(0, 5)}` : null; };
  const CODES = { INI: 'Check-in', EMB: 'Imbarco', BOR: 'Imbarco', ULL: 'Ultima chiamata', CER: 'Gate chiuso', RET: 'Ritardato', CAN: 'Cancellato',
    FLY: nature === 'A' ? 'In volo' : 'Decollato', DES: nature === 'A' ? 'In volo' : 'Decollato', LND: 'Atterrato', ATE: 'Atterrato', IBK: 'Atterrato', FNL: 'Atterrato', DIV: 'Dirottato' };
  return list.map(f => {
    const sched = iso(f.fecha, f.horaProgramada), est = iso(f.fechaEstimada || f.fecha, nul(f.horaEstimada));
    const status = CODES[f.estado] || null;
    const desk = [nul(f.mostradorDesde), nul(f.mostradorHasta)].filter(Boolean);
    return {
      number: normNum(`${f.iataCompania || ''}${f.numVuelo || ''}`), sched: clock(sched?.slice(11)), schedDate: sched,
      est: clock(est?.slice(11)), actual: isDone(status) ? clock(est?.slice(11)) : null, estAt: est, actualAt: isDone(status) ? est : null,
      status, statusCode: f.estado || null, gate: nul(f.puertaPrimera), checkin: desk.length ? [...new Set(desk)].join('–') : null, stand: null,
      belt: nul(f.cintaPrimera), reg: null, type: nul(f.tipoAeronave), terminal: nul(f.terminal)?.replace(/^T/i, '') || null,
      city: titleCase(nul(f.ciudadIataOtro)), cityCode: nul(f.iataOtro), airline: nul(f.nombreCompania),
      codeshare: (nul(f.iatasCompaniaSecundarios) || '').split(',').map(normNum).filter(Boolean),
    };
  }).filter(f => f.number && f.sched);
}

// ---------- Lisbona (ANA) ----------
// JSON del sito aeroportolisboa.pt: giornata intera, orari locali; niente gate né nastro.
async function lisbon(nature, log) {
  const u = `https://www.aeroportolisboa.pt/en/flights_proxy?day=hoje&movtype=${nature === 'A' ? 'A' : 'D'}&IATA=LIS`;
  const data = JSON.parse(await getText(u, log, { name: 'Lisbona' }));
  return (data.flights || []).map(f => {
    const m = /(\d\d)\/(\d\d)\/(\d{4})/.exec(f.day || '');
    const sched = m && f.time ? `${m[3]}-${m[2]}-${m[1]}T${f.time}` : null;
    const label = (f.state?.label || '').trim(), val = clock(f.state?.value);
    const status = statusIt(label, nature);
    return {
      number: normNum(f.flightNumber), sched: clock(f.time), schedDate: sched, est: val, actual: isDone(status) ? val : null,
      status, statusCode: label || null, gate: null, checkin: null, stand: null, belt: null, reg: null, type: null,
      terminal: trimOrNull(f.terminal)?.replace(/^T/i, '') || null, city: f.destination || null, cityCode: null, airline: titleCase(f.airline),
      codeshare: Array.isArray(f.sharedAirlinesFlights) ? f.sharedAirlinesFlights.map(c => normNum(c.flightNumber)).filter(Boolean) : [],
    };
  }).filter(f => f.number && f.sched);
}

// ---------- Torino (SAGAT) ----------
// Pagina "Partenze e arrivi" di aeroportoditorino.it: due tabelle HTML (partenze, arrivi) con data "gg-mm" e ora.
async function torino(nature, log) {
  const t = await getText('https://www.aeroportoditorino.it/it/tofly/voli/partenze-arrivi?orario=oggi', log, { name: 'Torino', quiet: true, accept: 'text/html' });
  const tables = t.match(/<table[\s\S]*?<\/table>/g) || [];
  const tb = tables[nature === 'A' ? 1 : 0] || '';
  const year = localNow('Europe/Rome').date.slice(0, 4);
  return [...tb.matchAll(/<tr class="row-flight[^"]*"[^>]*>([\s\S]*?)<\/tr>/g)].map(m => {
    const c = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(x => strip(x[1]));
    const dm = /(\d\d)-(\d\d)/.exec(c[0] || ''), sched = clock(c[1]);
    const note = trimOrNull(c[4]);
    const status = statusIt(note, nature);
    const tm = timeIn(note);
    return {
      number: normNum(c[3]), sched, schedDate: dm && sched ? `${year}-${dm[2]}-${dm[1]}T${sched}` : null, est: tm, actual: isDone(status) ? tm : null,
      status, statusCode: note, gate: null, checkin: nature === 'A' ? null : trimOrNull(c[6]), stand: null, belt: null, reg: null,
      type: trimOrNull(c[5]), city: titleCase(c[2]), cityCode: null, airline: null,
    };
  }).filter(f => f.number && f.sched);
}

// ---------- Cagliari (SOGAER) ----------
// JSON di sogaer.it con arrivi e partenze insieme; orari solo "HH:MM": la data dell'orario stimato è in ORDER_KEY (…GGMMHHMM).
async function cagliari(nature, log) {
  const data = JSON.parse(await getText('https://www.sogaer.it/it/sogaer/flights', log, { name: 'Cagliari', quiet: true }));
  const A = nature === 'A';
  const list = Object.values((A ? data.arrivals : data.departures) || {});
  const now = localNow('Europe/Rome');
  return list.filter(f => f.pUBLIC_FLIGHT_FLAG !== 'N').map(f => {
    const sched = clock(f.sCHEDULED_DATE_TIME), est = clock(f.eSTIMATED_DATE_TIME);
    const k = String(f.oRDER_KEY || '');
    const dd = k.length >= 8 ? k.slice(-8, -6) : null, mm = k.length >= 8 ? k.slice(-6, -4) : null;
    let estDate = dd && mm ? `${now.date.slice(0, 4)}-${mm}-${dd}` : (f.tOMORROWS_FLIGHT ? addDays(now.date, 1) : now.date);
    let schedDay = estDate;
    if (sched && est && hmMin(sched) - hmMin(est) > 12 * 60) schedDay = addDays(estDate, -1);
    else if (sched && est && hmMin(est) - hmMin(sched) > 12 * 60) schedDay = addDays(estDate, 1);
    const remark = trimOrNull(f.rEMARK_PUB);
    const status = statusIt(remark, nature);
    return {
      number: normNum(f.fLIGHT_HR || `${f.aIRLINE_2 || ''}${f.fLIGHT || ''}`), sched, schedDate: sched ? `${schedDay}T${sched}` : null,
      est, actual: isDone(status) ? est : null, estAt: est ? `${estDate}T${est}` : null, actualAt: isDone(status) && est ? `${estDate}T${est}` : null,
      status, statusCode: f.fLIGHT_STATE_PUB1 || null, gate: trimOrNull(f.gATE), checkin: null, stand: null, belt: null, reg: null, type: null,
      city: titleCase(A ? f.oRIGIN : f.dESTINATION), cityCode: null, airline: f.aIRLINE_DESCRIPTION || null,
    };
  }).filter(f => f.number && f.sched);
}

// ---------- Londra Stansted (MAG) ----------
// GraphQL pubblico (AWS AppSync) usato da stanstedairport.com; orari ISO in UTC.
async function stansted(nature, log) {
  const A = nature === 'A', tz = 'Europe/London';
  const s = new Date(Date.now() - 3 * 3600e3).toISOString(), e = new Date(Date.now() + 12 * 3600e3).toISOString();
  const q = A
    ? 'query($t:String!,$s:AWSDateTime,$e:AWSDateTime){ allArrivals(tenant:$t,startDate:$s,endDate:$e,from:0,size:1000){ flightNumber status scheduledArrivalDateTime estimatedArrivalDateTime actualArrivalDateTime arrivalTerminal airline{name code} departureAirport{code name cityName} arrivalBaggageClaim{number} } }'
    : 'query($t:String!,$s:AWSDateTime,$e:AWSDateTime){ allDepartures(tenant:$t,startDate:$s,endDate:$e,from:0,size:1000){ flightNumber status scheduledDepartureDateTime estimatedDepartureDateTime actualDepartureDateTime departureTerminal airline{name code} arrivalAirport{code name cityName} departureGate{number name} } }';
  const t = await getText('https://d3ebfrkw2baepa.cloudfront.net/', log, { name: 'Stansted', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q, variables: { t: 'STN', s, e } }) });
  const j = JSON.parse(t);
  if (j.errors?.length) throw new Error(`Stansted: ${j.errors[0].message}`);
  const list = (A ? j.data?.allArrivals : j.data?.allDepartures) || [];
  return list.map(f => {
    const sched = utcToLocal(A ? f.scheduledArrivalDateTime : f.scheduledDepartureDateTime, tz);
    const est = utcToLocal(A ? f.estimatedArrivalDateTime : f.estimatedDepartureDateTime, tz);
    const act = utcToLocal(A ? f.actualArrivalDateTime : f.actualDepartureDateTime, tz);
    let status = statusIt(f.status, nature);
    if (act && !/Cancellato|Dirottato/.test(status || '')) status = A ? 'Atterrato' : 'Decollato';
    const other = A ? f.departureAirport : f.arrivalAirport;
    return {
      number: normNum(f.flightNumber), sched: clock(sched?.slice(11)), schedDate: sched, est: clock((act || est || '').slice(11)), actual: act ? clock(act.slice(11)) : null,
      estAt: act || est || null, actualAt: act || null, status, statusCode: f.status || null,
      gate: A ? null : trimOrNull(f.departureGate?.number), checkin: null, stand: null, belt: A ? trimOrNull(f.arrivalBaggageClaim?.number) : null,
      reg: null, type: null, terminal: trimOrNull(A ? f.arrivalTerminal : f.departureTerminal),
      city: titleCase(other?.cityName || other?.name), cityCode: other?.code || null, airline: titleCase(f.airline?.name),
    };
  }).filter(f => f.number && f.sched);
}

// ---------- Londra Gatwick ----------
// Frammenti HTML di gatwickairport.com a fasce di 2 ore (page=0 è la fascia attuale, -1 la precedente, 1..6 le successive).
async function gatwick(nature, log) {
  const A = nature === 'A';
  const pages = await Promise.all([-1, 0, 1, 2, 3, 4, 5, 6].map(p => getText(`https://www.gatwickairport.com/on/demandware.store/Sites-Gatwick-Site/en_GB/LiveFlights-FetchFlights?page=${p}&terminal=all&destination=${A ? 'A' : 'D'}&search=`, log, { name: 'Gatwick', quiet: true, accept: 'text/html' }).catch(() => '')));
  const seen = new Set(), rows = [];
  for (const html of pages) {
    for (const m of html.matchAll(/<tr class="flight-line[^"]*" id="([^"]+)">([\s\S]*?)<\/tr>/g)) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      const tds = [...m[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(x => strip(x[1]));
      const al = /data-airline="([^"]*)"/.exec(m[2])?.[1], fn = /data-flightNumber="([^"]*)"/.exec(m[2])?.[1];
      const sched = clock(tds[1]), st = trimOrNull(tds[5]);
      const status = statusIt(st, nature), tm = timeIn(st);
      rows.push({
        number: normNum(al && fn ? `${al}${fn}` : tds[4]), sched, est: /gate info/i.test(st || '') ? null : tm, actual: isDone(status) || status === 'In rullaggio' ? tm : null,
        status, statusCode: st, gate: A ? null : trimOrNull(tds[6] === '-' ? null : tds[6]), checkin: null, stand: null, belt: null, reg: null, type: null,
        terminal: trimOrNull(A ? tds[6] : tds[7]), city: tds[2] || null, cityCode: null, airline: null,
      });
    }
  }
  return assignDates(rows, localNow('Europe/London').date).filter(f => f.number && f.sched);
}

// ---------- Londra Luton ----------
// Pagine /departures e /arrivals di london-luton.co.uk (HTML, finestra di circa 12 ore; ogni volo compare due volte).
async function luton(nature, log) {
  const t = await getText(`https://www.london-luton.co.uk/${nature === 'A' ? 'arrivals' : 'departures'}`, log, { name: 'Luton', quiet: true, accept: 'text/html' });
  const seen = new Set(), rows = [];
  for (const m of t.matchAll(/<[^>]*data-flightno="([^"]*)"[^>]*>/g)) {
    const tag = m[0];
    const num = normNum(m[1]), time = clock(/data-flighttime=['"]([^'"]*)/.exec(tag)?.[1]);
    const k = `${num}|${time}`;
    if (!num || seen.has(k)) continue;
    seen.add(k);
    const st = trimOrNull(strip(/data-flightstatus="([^"]*)"/.exec(tag)?.[1]));
    const status = statusIt(st, nature), tm = timeIn(st);
    rows.push({
      number: num, sched: time, est: tm, actual: isDone(status) ? tm : null, status, statusCode: st,
      gate: /gate\s+([A-Z0-9]+)/i.exec(st || '')?.[1] || null, checkin: /desk\s+([\w-]+)/i.exec(st || '')?.[1] || null, stand: null, belt: null, reg: null, type: null,
      city: strip(/data-flightorgdest="([^"]*)"/.exec(tag)?.[1]) || null, cityCode: null, airline: null,
    });
  }
  return assignDates(rows, localNow('Europe/London').date).filter(f => f.number && f.sched);
}

// ---------- Londra City ----------
// API JSON apis.londoncityairport.com (Veovo): partenze e arrivi insieme, orari ISO in UTC; marche e tipo dal blocco AIDX.
async function londonCity(nature, log) {
  const data = JSON.parse(await getText('https://apis.londoncityairport.com/api/veovo/flight-data', log, { name: 'London City', quiet: true }));
  const A = nature === 'A', tz = 'Europe/London';
  return (data.flights || []).filter(f => f.flightDirection === (A ? 'Arrival' : 'Departure')).map(f => {
    const leg = f.data?.LegData || {};
    const ops = Object.values(leg.OperationTime || {}).map(o => ({ type: o._attributes?.TimeType, q: o._attributes?.OperationQualifier, v: o._value })).filter(o => o.v);
    const pick = type => ops.filter(o => o.type === type).map(o => o.v).pop() || null;
    const sched = utcToLocal(f.flightTimes?.scheduledTime?.value || pick('SCT'), tz);
    const est = utcToLocal(pick('EST'), tz), act = utcToLocal(f.flightTimes?.actualTime?.value || pick('ACT'), tz);
    let status = statusIt(f.flightStatus?.status, nature);
    if (act && !/Cancellato|Dirottato/.test(status || '')) status = A ? 'Atterrato' : 'Decollato';
    const res = Object.values(leg.AirportResources || {}).map(r => r.Resource || {}).find(r => typeof r.BaggageClaimUnit === 'string' || typeof r.PassengerGate === 'string') || {};
    const other = A ? f.departureAirport : f.arrivalAirport;
    const reg = leg.AircraftInfo?.Registration;
    return {
      number: normNum(f.flightNumber), sched: clock(sched?.slice(11)), schedDate: sched, est: clock((act || est || '').slice(11)), actual: act ? clock(act.slice(11)) : null,
      estAt: act || est || null, actualAt: act || null, status, statusCode: f.flightStatus?.code || null,
      gate: A ? null : trimOrNull(f.passengerGate), checkin: null, stand: null, belt: A && typeof res.BaggageClaimUnit === 'string' ? res.BaggageClaimUnit.replace(/^0+/, '') : null,
      reg: typeof reg === 'string' ? fmtReg(reg) : null, type: typeof leg.AircraftInfo?.AircraftType === 'string' ? leg.AircraftInfo.AircraftType : null,
      city: other?.name || null, cityCode: other?.iata_code || null, airline: f.airline?.name || null,
    };
  }).filter(f => f.number && f.sched);
}

// ---------- Lione (Lyon Aéroports) ----------
// API JSON del sito lyonaeroports.com, una giornata per chiamata, orari locali.
async function lyon(nature, log) {
  const tz = 'Europe/Paris';
  const dates = [...new Set([localNow(tz, -150).date, localNow(tz, 630).date])];
  const all = [];
  for (const d of dates) {
    try { all.push(...JSON.parse(await getText(`https://www.lyonaeroports.com/api/flights/list?direction=${nature === 'A' ? 'A' : 'D'}&date=${d}`, log, { name: 'Lione', quiet: true }))); }
    catch (e) { if (!all.length && d === dates[dates.length - 1]) throw e; }
  }
  const dmy = s => { const m = /(\d\d)\/(\d\d)\/(\d{4}) (\d\d:\d\d)/.exec(s || ''); return m ? `${m[3]}-${m[2]}-${m[1]}T${m[4]}` : null; };
  return all.map(f => {
    const sched = f.HORAIRE ? f.HORAIRE.replace(' ', 'T').slice(0, 16) : null;
    const st = trimOrNull(f.STATUTF) || trimOrNull(f.status?.label);
    const status = statusIt(st, nature);
    const estAt = dmy(nature === 'A' ? f.EIBT_DTH : f.EOBT_DTH);
    const tm = timeIn(f.STATUTF);
    const est = clock(f.HACTU) || clock(estAt?.slice(11));
    return {
      number: normNum(f.NUMVOL), sched: clock(sched?.slice(11)), schedDate: sched, est, actual: isDone(status) ? tm || est : null,
      estAt: estAt && clock(estAt.slice(11)) === est ? estAt : null, status, statusCode: st,
      gate: nature === 'A' ? null : trimOrNull(f.PORTE), checkin: trimOrNull(f.COMPTOIR_ENREGISTREMENT)?.replace(/\s*-\s*/, '–') || null, stand: null,
      belt: nature === 'A' ? trimOrNull(f.TAPIS) : null, reg: null, type: trimOrNull(f.AIRCRAFT_MODEL), terminal: trimOrNull(f.TERMINAL)?.replace(/^T/i, '') || null,
      city: titleCase(f.AERO_SLIBELLE), cityCode: f.CODEESC1 || null, airline: f.CIE_LIBELLE || null,
      codeshare: (f.share_codes || []).map(normNum).filter(n => n && n !== normNum(f.NUMVOL)),
    };
  }).filter(f => f.number && f.sched);
}

// ---------- Parigi Beauvais ----------
// Pagina "Vols du jour" di aeroportparisbeauvais.com: due tabelle HTML (prima arrivi, poi partenze), solo orari.
async function beauvais(nature, log) {
  const t = await getText('https://www.aeroportparisbeauvais.com/vols/etat-des-vols/vols-du-jour', log, { name: 'Beauvais', quiet: true, accept: 'text/html' });
  const tables = t.match(/<table[\s\S]*?<\/table>/g) || [];
  const tb = tables.find(x => (nature === 'A' ? /Provenance/ : /Destination/).test(x)) || '';
  const today = localNow('Europe/Paris').date;
  return tableRows(tb).filter(c => c.length >= 6).map(c => {
    const sched = clock(c[0]), st = trimOrNull(c[5]), prev = timeIn(c[6]);
    const status = statusIt(st?.replace(/&#039;/g, "'"), nature);
    return {
      number: normNum(c[1]), sched, schedDate: sched ? `${today}T${sched}` : null, est: prev, actual: isDone(status) ? prev : null,
      status, statusCode: st, gate: null, checkin: null, stand: null, belt: null, reg: null, type: null,
      terminal: trimOrNull(c[4])?.replace(/^T/i, '') || null, city: titleCase(c[2]), cityCode: null, airline: titleCase(c[3]),
    };
  }).filter(f => f.number && f.sched);
}

// ---------- Amsterdam Schiphol ----------
// Public Flight API 4.2 ufficiale (developer.schiphol.nl). L'app registrata sul portale dà client_id e client_secret
// (segreti del Worker SCHIPHOL_APP_ID e SCHIPHOL_APP_KEY) che si scambiano con un token JWT (OAuth client_credentials);
// Token da https://api.auth.schiphol.nl/oauth/token con audience https://api.schiphol.nl/public (durata 30 minuti). 20 voli per pagina; orari ISO con fuso.
const AMS_STATES = { SCH: null, DEL: 'Ritardato', WIL: 'Attendere in sala', GTO: 'Gate aperto', BRD: 'Imbarco', GCH: 'Cambio gate',
  GCL: 'Ultima chiamata', GTD: 'Gate chiuso', DEP: 'Decollato', CNX: 'Cancellato', TOM: 'Domani', AIR: 'In volo', EXP: 'In arrivo',
  FIR: 'In arrivo', LND: 'Atterrato', FIB: 'Atterrato', ARR: 'Atterrato', DIV: 'Dirottato' };
let amsToken = null;
async function schipholToken(env, log) {
  if (amsToken && amsToken.until > Date.now()) return amsToken.value;
  const ck = new Request('https://cache.local/schiphol-token');
  const hit = await caches.default.match(ck).catch(() => null);
  if (hit) { const c = await hit.json(); if (c.until > Date.now()) { amsToken = c; return c.value; } }
  const id = env.SCHIPHOL_APP_ID, secret = env.SCHIPHOL_APP_KEY;
  const url = env.SCHIPHOL_TOKEN_URL || 'https://api.auth.schiphol.nl/oauth/token';
  const form = { grant_type: 'client_credentials', audience: env.SCHIPHOL_AUDIENCE || 'https://api.schiphol.nl/public' };
  const tries = [
    { body: new URLSearchParams({ ...form, client_id: id, client_secret: secret }), headers: {} },
    { body: new URLSearchParams(form), headers: { 'Authorization': 'Basic ' + btoa(`${id}:${secret}`) } },
  ];
  let last = '';
  for (const [i, t] of tries.entries()) {
    const t0 = Date.now();
    const r = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(15000), body: t.body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', ...t.headers } });
    const txt = await r.text();
    let j = {};
    try { j = JSON.parse(txt); } catch {}
    log.push({ url: `${url} (token, tentativo ${i + 1})`, status: r.status, length: txt.length, ms: Date.now() - t0, start: j.access_token ? 'token ok' : txt.slice(0, 200) });
    if (r.ok && j.access_token) {
      amsToken = { value: j.access_token, until: Date.now() + Math.max(60, (+j.expires_in || 3600) - 120) * 1000 };
      const ttl = Math.floor((amsToken.until - Date.now()) / 1000);
      await caches.default.put(ck, new Response(JSON.stringify(amsToken), { headers: { 'Cache-Control': `max-age=${ttl}` } })).catch(() => {});
      return amsToken.value;
    }
    last = `${r.status} ${j.error_description || j.error || j.message || ''}`.trim();
  }
  throw new Error(`Schiphol: token non ottenuto (${last})`);
}
async function schiphol(nature, log, env) {
  if (!env || !env.SCHIPHOL_APP_ID || !env.SCHIPHOL_APP_KEY) throw new Error('Schiphol: mancano i segreti SCHIPHOL_APP_ID e SCHIPHOL_APP_KEY nel Worker');
  const A = nature === 'A', tz = 'Europe/Amsterdam';
  const iso = n => `${n.date}T${n.hm}:00`;
  const base = `https://api.schiphol.nl/public/public-flights/v4/flights?flightDirection=${A ? 'A' : 'D'}&includedelays=false&isOperationalFlight=true&sort=%2BscheduleTime`
    + `&searchDateTimeField=scheduleDateTime&fromDateTime=${iso(localNow(tz, -150))}&toDateTime=${iso(localNow(tz, 600))}`;
  const token = await schipholToken(env, log);
  const headers = { 'Accept': 'application/json', 'Authorization': `Bearer ${token}` };
  const page = async p => {
    const t0 = Date.now();
    const r = await fetch(`${base}&page=${p}`, { signal: AbortSignal.timeout(15000), headers });
    const t = r.status === 204 ? '' : await r.text();
    log.push({ url: `${base}&page=${p}`, status: r.status, length: t.length, ms: Date.now() - t0, start: p ? undefined : t.slice(0, 160) });
    if (r.status === 401 || r.status === 403) { amsToken = null; await caches.default.delete(new Request('https://cache.local/schiphol-token')).catch(() => {}); }
    if (!r.ok) throw new Error(`Schiphol: errore ${r.status}${r.status === 401 || r.status === 403 ? ' (token rifiutato)' : ''}`);
    const link = r.headers.get('link') || '';
    return { flights: t ? JSON.parse(t).flights || [] : [], link, next: /rel="?next"?/.test(link) };
  };
  const first = await page(0);
  const last = Math.min(+(/[?&]page=(\d+)[^>]*>;\s*rel="?last"?/.exec(first.link)?.[1] || 0), 44);
  const rest = [];
  if (last) {
    for (let p = 1; p <= last; p += 10) {
      rest.push(...await Promise.all(Array.from({ length: Math.min(10, last - p + 1) }, (_, i) => page(p + i).catch(() => ({ flights: [] })))));
    }
  } else if (first.next) {
    for (let p = 1, more = true; more && p <= 44; p++) { const x = await page(p).catch(() => ({ flights: [] })); rest.push(x); more = x.next; }
  }
  const seen = new Set();
  return [first, ...rest].flatMap(x => x.flights).filter(f => {
    if (f.mainFlight && f.flightName && f.mainFlight !== f.flightName) return false;
    if (f.serviceType && !/^[JC]$/.test(f.serviceType)) return false;
    const k = `${f.id || f.flightName}|${f.scheduleDateTime}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).map(f => {
    const sched = utcToLocal(f.scheduleDateTime, tz) || (f.scheduleDate && f.scheduleTime ? `${f.scheduleDate}T${f.scheduleTime.slice(0, 5)}` : null);
    const est = utcToLocal(A ? f.estimatedLandingTime : f.publicEstimatedOffBlockTime, tz);
    const act = utcToLocal(A ? f.actualLandingTime : f.actualOffBlockTime, tz);
    const code = (f.publicFlightState?.flightStates || []).slice(-1)[0] || null;
    let status = code in AMS_STATES ? AMS_STATES[code] : code;
    if (act && !/Cancellato|Dirottato/.test(status || '')) status = A ? 'Atterrato' : 'Decollato';
    const t = f.aircraftType || {};
    return {
      number: normNum(f.flightName), sched: clock(sched?.slice(11)), schedDate: sched, est: clock((act || est || '').slice(11)), actual: act ? clock(act.slice(11)) : null,
      estAt: act || est || null, actualAt: act || null, status, statusCode: code,
      gate: trimOrNull(f.gate), checkin: null, stand: null, belt: A ? (f.baggageClaim?.belts || []).join(', ') || null : null,
      reg: fmtReg(f.aircraftRegistration), type: trimOrNull(t.iataSub || t.iatasub || t.iataMain || t.iatamain), terminal: f.terminal != null ? String(f.terminal) : null,
      city: null, cityCode: (f.route?.destinations || [])[A ? 0 : (f.route?.destinations || []).length - 1] || null, airline: null,
      codeshare: (f.codeshares?.codeshares || []).map(normNum).filter(n => n && n !== normNum(f.flightName)),
    };
  }).filter(f => f.number && f.sched);
}

// ---------- Genova ----------
// API WordPress del sito airport.genova.it (plugin goavoli): partenze e arrivi della giornata insieme, orari locali.
async function genova(nature, log) {
  const data = JSON.parse(await getText('https://www.airport.genova.it/wp-json/goavoli/v1/voli', log, { name: 'Genova', quiet: true }));
  const A = nature === 'A';
  const t = v => (v && !v.startsWith('0001') ? v.slice(0, 16) : null);
  return ((A ? data.arrival : data.departure) || []).filter(f => (f.TRANSPORT_TYPE || 'P') === 'P' && f.PUBLIC_FLIGHT_FLAG !== 'N').map(f => {
    const sched = t(f.SCHEDULED_DATE_TIME), est = t(f.RESCHEDULED_DATE_TIME) || t(f.ESTIMATED_DATE_TIME);
    const st = trimOrNull(f.REMARK_PUB_LOC);
    const status = statusIt(st, nature);
    const done = isDone(status);
    const act = done ? est : null;
    const num = normNum(`${(f.AIRLINE_2 || '').trim()}${(f.FLIGHT || '').trim()}`);
    return {
      number: num, sched: clock(sched?.slice(11)), schedDate: sched, est: clock(est?.slice(11)), actual: act ? clock(act.slice(11)) : null,
      estAt: est, actualAt: act, status, statusCode: trimOrNull(f.REMARK_PUB),
      gate: A ? null : trimOrNull(f.GATE), checkin: A ? null : trimOrNull(f.CHECKIN), stand: null, belt: A ? trimOrNull(f.BELT_FIDS) : null,
      reg: null, type: null, terminal: null,
      city: titleCase(A ? f.ORIGIN_LOC : f.DESTINATION_LOC), cityCode: trimOrNull(A ? f.ORIGIN : f.DESTINATION), airline: trimOrNull(f.AIRLINE_DESCRIPTION_LOC),
    };
  }).filter(f => f.number && f.sched);
}

// ---------- Venezia (SAVE) ----------
// API Magento del sito veneziaairport.it: POST /it_it/rest/V1/flights/get, 15 voli per pagina, orari ISO con fuso.
// Stessa API (gruppo SAVE) per Verona e Treviso: cambiano solo il sito e lo store_code
async function venezia(nature, log, host = 'www.veneziaairport.it', store = 'vce_store_it', name = 'Venezia') {
  const A = nature === 'A', tz = 'Europe/Rome';
  const page = async p => JSON.parse(await getText(`https://${host}/it_it/rest/V1/flights/get`, log, {
    name, method: 'POST', quiet: p > 1, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: null, date: 'any', type: A ? 'arrivals' : 'departures', page: p, store_code: store }) }));
  const first = await page(1);
  const per = +first.pagination?.per_page || 15, total = +first.pagination?.total || +first.results?.total || 0;
  const pages = Math.min(Math.ceil(total / per), 30);
  const rest = await Promise.all(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => page(i + 2).catch(() => ({}))));
  const items = [first, ...rest].flatMap(x => x.results?.items || []);
  const loc = v => (v ? utcToLocal(v, tz) : null);
  return items.map(f => {
    const tm = f.time || {};
    const sched = loc(tm.scheduled || tm.scheduled_time || tm.planned || tm.expected);
    const est = loc(tm.estimated || tm.expected), act = loc(tm.actual);
    const st = trimOrNull(f.status?.description);
    let status = statusIt(st, nature);
    if (act && !/Cancellato|Dirottato/.test(status || '')) status = A ? 'Atterrato' : 'Decollato';
    const nums = (f.flights || []).map(x => normNum(x.number)).filter(Boolean);
    return {
      number: nums[0], sched: clock(sched?.slice(11)), schedDate: sched, est: clock((act || est || '').slice(11)), actual: act ? clock(act.slice(11)) : null,
      estAt: act || est || null, actualAt: act || null, status, statusCode: trimOrNull(f.status?.type),
      gate: A ? null : trimOrNull(typeof f.gate === 'object' ? f.gate?.name || f.gate?.code : f.gate),
      checkin: A ? null : trimOrNull(typeof f.check_in === 'object' ? f.check_in?.name || f.check_in?.desks : f.check_in),
      stand: null, belt: A ? trimOrNull(typeof f.belt === 'object' ? f.belt?.name : f.belt || f.baggage_claim) : null, reg: null, type: null, terminal: null,
      city: titleCase((A ? f.origin?.name : f.destination?.name) || f.destination?.name || f.origin?.name),
      cityCode: trimOrNull((A ? f.origin?.code : f.destination?.code) || null), airline: trimOrNull(f.airline?.name),
      codeshare: nums.slice(1),
    };
  }).filter(f => f.number && f.sched);
}

// ---------- Hong Kong (AAHK) ----------
// Open data dell'aeroporto (data.gov.hk): GET /flightinfo-rest/rest/flights/past?date=YYYY-MM-DD&arrival=&cargo=false&lang=en,
// nessuna chiave. Risponde con un elenco di giornate, ognuna con i voli in ora di Hong Kong; lo stato è un testo
// ("Dep 01:28 (09/11/2026)", "At gate 13:20", "Est at 14:05", "Boarding", "Cancelled"...).
async function hongKong(nature, log) {
  const A = nature === 'A', tz = 'Asia/Hong_Kong';
  const dates = [...new Set([localNow(tz, -150).date, localNow(tz, 630).date])];
  const days = (await Promise.all(dates.map((d, i) => getText(`https://www.hongkongairport.com/flightinfo-rest/rest/flights/past?date=${d}&lang=en&cargo=false&arrival=${A}`, log, { name: 'Hong Kong', quiet: i > 0 })
    .then(t => JSON.parse(t)).catch(e => (i ? [] : Promise.reject(e)))))).flat();
  const seen = new Set(), out = [];
  for (const day of days) {
    for (const f of day.list || []) {
      const nums = (f.flight || []).map(x => normNum((x.no || '').replace(/\s+/g, ''))).filter(Boolean);
      const sched = day.date && f.time ? `${day.date}T${f.time}` : null;
      if (!nums[0] || !sched || seen.has(nums[0] + sched)) continue;
      seen.add(nums[0] + sched);
      const st = trimOrNull(f.status) || '';
      // orario nel testo dello stato, con la data se c'è ("(10/11/2026)")
      const m = /(\d{1,2}:\d{2})(?:\s*\((\d{2})\/(\d{2})\/(\d{4})\))?/.exec(st);
      const at = m ? `${m[4] ? `${m[4]}-${m[3]}-${m[2]}` : day.date}T${m[1].padStart(5, '0')}` : null;
      const done = /^(dep|at gate|arrived|landed)/i.test(st);
      let status;
      if (/cancel/i.test(st)) status = 'Cancellato';
      else if (/divert/i.test(st)) status = 'Dirottato';
      else if (done) status = A ? 'Atterrato' : 'Decollato';
      else if (/^est/i.test(st)) status = at && at > sched ? 'Ritardato' : null;
      else status = statusIt(st, nature) || null;
      const place = A ? f.origin : f.destination;
      out.push({
        number: nums[0], sched: clock(f.time), schedDate: sched, est: at ? clock(at.slice(11)) : null, actual: done && at ? clock(at.slice(11)) : null,
        estAt: at, actualAt: done ? at : null, status, statusCode: trimOrNull(f.statusCode),
        gate: A ? null : trimOrNull(f.gate), checkin: A ? null : trimOrNull(f.aisle), stand: A ? trimOrNull(f.stand) : null, belt: A ? trimOrNull(f.baggage) : null,
        reg: null, type: null, terminal: trimOrNull(f.terminal),
        city: null, cityCode: Array.isArray(place) ? place[place.length - 1] : trimOrNull(place), airline: null,
        codeshare: nums.slice(1),
      });
    }
  }
  return out;
}

// =====================================================================================================
// Altri aeroporti europei (2026-11-10): API JSON pubbliche dei siti ufficiali e tabelloni HTML.
// =====================================================================================================

// Finestra del tabellone (ora locale "YYYY-MM-DDTHH:MM"): da 3 ore fa a 12 ore avanti
function windowTest(tz, back = 180, ahead = 720) {
  const a = localNow(tz, -back), b = localNow(tz, ahead);
  const lo = `${a.date}T${a.hm}`, hi = `${b.date}T${b.hm}`;
  return d => !!d && d >= lo && d <= hi;
}
// Data/ora → ora locale "YYYY-MM-DDTHH:MM" (se ha il fuso o la Z si converte, altrimenti è già locale)
const toLocal = (v, tz) => {
  if (!v || /^-0001/.test(v)) return null;
  const s = String(v).trim().replace(' ', 'T');
  return /(Z|[+-]\d\d:?\d\d)$/.test(s) ? utcToLocal(s.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'), tz) : (/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(s) ? s.slice(0, 16) : null);
};
// Record nel formato comune; actualAt = orario effettivo (decollato/atterrato), estAt = stimato
function rec(f, nature) {
  const number = normNum(f.number);
  let status = f.status && !/^[-–\s]*$/.test(f.status) ? f.status : null;
  const actualAt = f.actualAt || null, estAt = actualAt || f.estAt || null;
  if (actualAt && !/Cancellato|Dirottato/.test(status || '')) status = nature === 'A' ? 'Atterrato' : 'Decollato';
  return {
    number, sched: clock(f.schedDate?.slice(11)), schedDate: f.schedDate || null,
    est: estAt ? clock(estAt.slice(11)) : null, actual: actualAt ? clock(actualAt.slice(11)) : null, estAt, actualAt,
    status, statusCode: f.statusCode != null ? String(f.statusCode) : null,
    gate: trimOrNull(f.gate), checkin: trimOrNull(f.checkin), stand: trimOrNull(f.stand), belt: trimOrNull(f.belt),
    reg: fmtReg(f.reg), type: trimOrNull(f.type), terminal: trimOrNull(f.terminal),
    city: trimOrNull(f.city), cityCode: trimOrNull(f.cityCode), airline: trimOrNull(f.airline),
    codeshare: [...new Set((f.codeshare || []).map(normNum).filter(c => c && c !== number))],
  };
}
const finish = (list, tz, name) => {
  const inWin = windowTest(tz), seen = new Set();
  const out = list.filter(f => f.number && f.schedDate && inWin(f.schedDate) && !seen.has(f.number + f.schedDate) && seen.add(f.number + f.schedDate))
    .sort((a, b) => (a.schedDate < b.schedDate ? -1 : 1));
  if (!out.length && list.length === 0) throw new Error(`${name}: nessun volo`);
  return out;
};
// stato da un testo con orario ("Departed 06:38", "Landed 07:24", "AIRBORNE 15:27", "Arrived 16:06", "Estimate 18:40")
function textTimes(txt, schedDate, nature) {
  const t = timeIn(txt);
  if (!t || !schedDate) return {};
  let d = schedDate.slice(0, 10);
  const diff = hmMin(t) - hmMin(schedDate.slice(11));
  if (diff < -720) d = addDays(d, 1); else if (diff > 720) d = addDays(d, -1);
  const at = `${d}T${t}`;
  const done = /depart|airborne|landed|arrived|taxied|décoll|atterr|gestartet|gelandet|take ?off/i.test(txt || '');
  return done ? { actualAt: at } : { estAt: at };
}

// ---------- Manchester (MAG, come Stansted) ----------
async function manchester(nature, log) { return magAirport('MAN', 'Manchester', nature, log); }
async function magAirport(tenant, name, nature, log) {
  const A = nature === 'A', tz = 'Europe/London';
  const s = new Date(Date.now() - 3 * 3600e3).toISOString(), e = new Date(Date.now() + 12 * 3600e3).toISOString();
  const q = A
    ? 'query($t:String!,$s:AWSDateTime,$e:AWSDateTime){ allArrivals(tenant:$t,startDate:$s,endDate:$e,from:0,size:1000){ flightNumber status scheduledArrivalDateTime estimatedArrivalDateTime actualArrivalDateTime arrivalTerminal airline{name code} departureAirport{code name cityName} arrivalBaggageClaim{number} } }'
    : 'query($t:String!,$s:AWSDateTime,$e:AWSDateTime){ allDepartures(tenant:$t,startDate:$s,endDate:$e,from:0,size:1000){ flightNumber status scheduledDepartureDateTime estimatedDepartureDateTime actualDepartureDateTime departureTerminal airline{name code} arrivalAirport{code name cityName} departureGate{number name} } }';
  const j = JSON.parse(await getText('https://d3ebfrkw2baepa.cloudfront.net/', log, { name, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q, variables: { t: tenant, s, e } }) }));
  if (j.errors?.length) throw new Error(`${name}: ${j.errors[0].message}`);
  return finish(((A ? j.data?.allArrivals : j.data?.allDepartures) || []).map(f => {
    const other = A ? f.departureAirport : f.arrivalAirport;
    return rec({
      number: f.flightNumber, schedDate: utcToLocal(A ? f.scheduledArrivalDateTime : f.scheduledDepartureDateTime, tz),
      estAt: utcToLocal(A ? f.estimatedArrivalDateTime : f.estimatedDepartureDateTime, tz), actualAt: utcToLocal(A ? f.actualArrivalDateTime : f.actualDepartureDateTime, tz),
      status: statusIt(f.status, nature), statusCode: f.status, gate: A ? null : f.departureGate?.number, belt: A ? f.arrivalBaggageClaim?.number : null,
      terminal: A ? f.arrivalTerminal : f.departureTerminal, city: titleCase(other?.cityName || other?.name), cityCode: other?.code, airline: titleCase(f.airline?.name),
    }, nature);
  }), tz, name);
}

// ---------- Amburgo ----------
// GET hamburg-airport.de/service/flightdata/departures|arrivals: JSON di più giorni (~1 MB), orari UTC.
async function hamburg(nature, log) {
  const A = nature === 'A', tz = 'Europe/Berlin';
  const list = JSON.parse(await getText(`https://www.hamburg-airport.de/service/flightdata/${A ? 'arrivals' : 'departures'}`, log, { name: 'Amburgo', quiet: true, timeout: 20000 }));
  const inWin = windowTest(tz);
  return finish(list.map(f => {
    const schedDate = utcToLocal(A ? f.plannedArrivalTime : f.plannedDepartureTime, tz);
    if (!inWin(schedDate)) return null;
    const st = A ? f.flightStatusArrival : f.flightStatusDeparture;
    let status = f.cancelled ? 'Cancellato' : f.diverted ? 'Dirottato' : ({ BRD: 'Imbarco', GCL: 'Gate chiuso', GTO: 'Gate aperto', DEL: 'Ritardato', APR: 'In arrivo', LND: 'Atterrato' }[st] || null);
    return rec({
      number: f.flightnumber, schedDate, estAt: utcToLocal(A ? f.expectedArrivalTime : f.expectedDepartureTime, tz),
      actualAt: f.cancelled ? null : utcToLocal(A ? f.actualArrivalTime : f.actualDepartureTime, tz), status, statusCode: st,
      gate: A ? null : f.gate, checkin: A ? null : f.checkinRow, belt: A ? f.baggageClaim : null, type: f.aircraftType,
      terminal: A ? f.arrivalTerminal : f.departureTerminal, city: A ? (f.originAirportNameInt || f.originAirportName) : (f.destinationAirportNameInt || f.destinationAirportName),
      cityCode: A ? f.originAirport3LCode : f.destinationAirport3LCode, airline: f.airlineName, codeshare: f.codeShareInfoFlightnumber,
    }, nature);
  }).filter(Boolean), tz, 'Amburgo');
}

// ---------- Berlino Brandeburgo ----------
// GET ber.berlin-airport.de/api.flights.json (risponde solo con il Referer della pagina del tabellone). Ha marche e tipo.
async function berlin(nature, log) {
  const A = nature === 'A', tz = 'Europe/Berlin', from = localNow(tz, -180);
  const page = p => getText(`https://ber.berlin-airport.de/api.flights.json?arrivalDeparture=${nature}&dateFrom=${from.date}T${from.hm}&dateUntil=${addDays(from.date, 1)}&search=&lang=en&page=${p}&terminal=&itemsPerPage=100`, log,
    { name: 'Berlino', quiet: p > 1, headers: { 'Referer': 'https://ber.berlin-airport.de/en/flying/departures-arrivals.html', 'Accept': 'application/json, text/plain, */*' } }).then(t => JSON.parse(t).data || {});
  const first = await page(1);
  const more = await Promise.all(Array.from({ length: Math.min(3, (first.total_pages || 1) - 1) }, (_, i) => page(i + 2).catch(() => ({}))));
  const ST = { X: 'Cancellato', P: null, S: null, G: 'Check-in', B: 'Imbarco', L: 'Ultima chiamata', C: 'Gate chiuso', '+': 'In arrivo' };
  return finish([first, ...more].flatMap(d => d.items || []).map(f => {
    const est = toLocal(A ? f.arr_estimated_time : f.dep_estimated_time, tz);
    const label = trimOrNull(f.flight_status_label);
    const done = /^(arrived|deboarding|end of deboarding|departed|airborne)/i.test(label || '');
    return rec({
      number: f.flight_number, schedDate: toLocal(f.scheduled_time, tz), estAt: done ? null : est, actualAt: done ? est || toLocal(f.scheduled_time, tz) : null,
      status: ST[f.flight_status] !== undefined && !/delay/i.test(label || '') ? ST[f.flight_status] : statusIt(label, nature), statusCode: f.flight_status,
      gate: A ? null : f.gate, checkin: A ? null : f.checkin_counter, belt: A ? f.arr_belt : null, reg: f.aircraft_reg, type: f.aircraft_type, terminal: f.terminal,
      city: A ? f.dep_airport_name : f.arr_airport_name, cityCode: A ? f.dep_airport_iata : f.arr_airport_iata, airline: f.airline_name, codeshare: f.code_shares,
    }, nature);
  }), tz, 'Berlino');
}

// ---------- Stoccolma Arlanda (Swedavia) ----------
// GET swedavia.com/services/publicflightsboard/v3/departures|arrivals/en/ARN/YYYY-MM-DD: tutta la giornata, orari UTC, marche.
async function swedavia(iata, nature, log) {
  const A = nature === 'A', tz = 'Europe/Stockholm';
  const dates = [...new Set([localNow(tz, -180).date, localNow(tz, 720).date])];
  const days = await Promise.all(dates.map((d, i) => getText(`https://www.swedavia.com/services/publicflightsboard/v3/${A ? 'arrivals' : 'departures'}/en/${iata}/${d}`, log,
    { name: 'Swedavia', quiet: true, headers: { 'Accept': 'application/json' } }).then(t => JSON.parse(t).flights || []).catch(e => (i ? [] : Promise.reject(e)))));
  return finish(days.flat().map(f => {
    const tm = (A ? f.arrivalTime : f.departureTime) || {}, ls = f.locationAndStatus || {};
    const leg = ls.flightLegStatusEnglish || '';
    const status = /cancel/i.test(leg) ? 'Cancellato' : /divert/i.test(leg) ? 'Dirottato' : statusIt(ls.gateActionEnglish || (/^estimated|^scheduled/i.test(leg) ? '' : leg), nature);
    const ci = f.checkIn || {};
    return rec({
      number: f.flightId, schedDate: utcToLocal(tm.scheduledUtc, tz), estAt: utcToLocal(tm.estimatedUtc, tz), actualAt: utcToLocal(tm.actualUtc, tz),
      status, statusCode: ls.flightLegStatus, gate: A ? null : ls.gate, checkin: A || !ci.checkInDeskFrom ? null : `${ci.checkInDeskFrom}${ci.checkInDeskTo && ci.checkInDeskTo !== ci.checkInDeskFrom ? `-${ci.checkInDeskTo}` : ''}`,
      belt: A ? f.baggage?.baggageClaimUnit : null, reg: f.flightLegIdentifier?.aircraftRegistration, terminal: ls.terminal,
      city: A ? f.departureAirportEnglish : f.arrivalAirportEnglish, cityCode: A ? f.flightLegIdentifier?.departureAirportIata : f.flightLegIdentifier?.arrivalAirportIata,
      airline: f.airlineOperator?.name, codeshare: f.codeShareData,
    }, nature);
  }), tz, 'Swedavia');
}

// ---------- Vienna ----------
// GET viennaairport.com/jart/prj3/va/data/flights/out.json | inc.json (file del sito, ~300 kB, oggi e domani, ora locale).
async function vienna(nature, log) {
  const A = nature === 'A', tz = 'Europe/Vienna';
  const j = JSON.parse(await getText(`https://viennaairport.com/jart/prj3/va/data/flights/${A ? 'inc' : 'out'}.json`, log, { name: 'Vienna', quiet: true }));
  const ST = { CNX: 'Cancellato', DEL: 'Ritardato', BRD: 'Imbarco', BOA: 'Imbarco', CLS: 'Gate chiuso', GCL: 'Gate chiuso', APP: 'In arrivo', LDG: 'In atterraggio', DIV: 'Dirottato' };
  return finish((j.monitor?.departure || j.monitor?.arrival || []).map(f => {
    const code = f.status?.code || '';
    const schedDate = toLocal(f.schedule, tz), at = toLocal(f.actual, tz);
    const done = /^(AIR|DEP|BLI|LND|ARR|ONB)$/.test(code);
    const place = (f.destinations || f.origins || f.origin || [])[0] || f.origin || {};
    return rec({
      number: f.fn, schedDate, estAt: !done && at && at !== schedDate ? at : null, actualAt: done ? at || schedDate : null,
      status: ST[code] || (done ? null : statusIt(f.status?.description, nature)), statusCode: code,
      gate: A ? null : f.gate, checkin: A ? null : f.checkin?.range, belt: A ? f.belt?.belt : null, type: f.aircraft?.description, terminal: f.checkin?.terminal,
      city: place.city?.nameEN || place.nameEN, cityCode: place.iataCode, airline: f.airline?.name, codeshare: (f.codeshares || []).map(c => c.fn),
    }, nature);
  }), tz, 'Vienna');
}

// ---------- Praga ----------
// GET api.prg.aero/en/departures-shorttime|arrivals-shorttime?offset=&limit=&from=DD-MM-YYYY_HH-mm (API del sito prg.aero), orari UTC.
async function prague(nature, log) {
  const A = nature === 'A', tz = 'Europe/Prague', f0 = localNow(tz, -180);
  const from = `${f0.date.slice(8, 10)}-${f0.date.slice(5, 7)}-${f0.date.slice(0, 4)}_${f0.hm.replace(':', '-')}`;
  const page = off => getText(`https://api.prg.aero/en/${A ? 'arrivals' : 'departures'}-shorttime?offset=${off}&limit=100&from=${from}`, log,
    { name: 'Praga', quiet: off > 0, headers: { 'Accept': 'application/json' } }).then(t => JSON.parse(t));
  const first = await page(0);
  const list = first.length >= 100 ? first.concat(await page(100).catch(() => [])) : first;
  return finish(list.filter(f => f.isMainFlight !== false).map(f => {
    const schedDate = toLocal(f.time, tz), st = trimOrNull(f.state) || '';
    const tt = textTimes(st, schedDate, nature);
    const est = toLocal(f['time-new'], tz);
    return rec({
      number: f.flyNumber, schedDate, estAt: tt.estAt || (est !== schedDate ? est : null), actualAt: tt.actualAt,
      status: /cancel/i.test(st) ? 'Cancellato' : tt.actualAt || tt.estAt ? (/delay/i.test(st) ? 'Ritardato' : null) : statusIt(st === '-' ? '' : st, nature), statusCode: f.state_id,
      gate: A ? null : f.gates, checkin: A ? null : f.chin_counters, terminal: f.terminal, city: (f.destination || '').replace(/\s*\([A-Z]{3}\)\s*$/, ''),
      cityCode: f['destination-id'], airline: f.company, codeshare: (f.codeshare || []).map(c => c.flyNumber),
    }, nature);
  }), tz, 'Praga');
}

// ---------- Dublino ----------
// GET dublinairport.com/api/flight-listing/departures|arrivals?date=ISO&limit=100 (API del sito), orari UTC.
async function dublin(nature, log) {
  const A = nature === 'A', tz = 'Europe/Dublin';
  const kind = A ? 'arrivals' : 'departures';
  const get = (iso, i) => getText(`https://www.dublinairport.com/api/flight-listing/${kind}?date=${encodeURIComponent(iso)}&limit=100`, log, { name: 'Dublino', quiet: i > 0 }).then(t => JSON.parse(t));
  let start = new Date(Date.now() - 3 * 3600e3).toISOString();
  const all = [];
  for (let i = 0; i < 3; i++) {
    const j = await get(start, i).catch(e => (i ? {} : Promise.reject(e)));
    all.push(...(j.content || []));
    const last = j.pagination?.latestTimestamp;
    if (!j.pagination?.hasNext || !last || Date.parse(last) > Date.now() + 12 * 3600e3) break;
    start = new Date(Date.parse(last) + 60e3).toISOString();
  }
  return finish(all.map(f => {
    const msg = trimOrNull(f.statusMessage) || '';
    const schedDate = utcToLocal(f.scheduledDateTime, tz), est = utcToLocal(f.estimatedDateTime, tz);
    const tt = textTimes(msg, schedDate, nature);
    return rec({
      number: f.flightIdentity, schedDate, estAt: tt.estAt || (est !== schedDate ? est : null), actualAt: tt.actualAt || (/departed|landed|arrived/i.test(msg) ? est : null),
      status: /^(on schedule|on time|scheduled)$/i.test(msg) ? null : statusIt(msg.replace(/\s*(AT\s*)?\d{1,2}:\d{2}.*$/i, ''), nature), statusCode: f.status, gate: A ? null : f.gate, checkin: A ? null : f.checkinDeskRange,
      belt: A ? f.baggageBelt || f.belt : null, terminal: f.terminalName, city: titleCase(A ? f.originAirportName || f.destinationAirportName : f.destinationAirportName),
      cityCode: f.airportCode, airline: f.carrierName, codeshare: f.codeShares,
    }, nature);
  }), tz, 'Dublino');
}

// ---------- Edimburgo ----------
// GET flights-api.edinburghairport.com/flights/departures|arrivals?version=2 (API del sito), ~30 ore, orari con fuso.
async function edinburgh(nature, log) {
  const A = nature === 'A', tz = 'Europe/London';
  const list = JSON.parse(await getText(`https://flights-api.edinburghairport.com/flights/${A ? 'arrivals' : 'departures'}?version=2`, log, { name: 'Edimburgo', quiet: true }));
  return finish(list.filter(f => !f.isCodeShare).map(f => {
    const schedDate = toLocal(f.scheduledDateTime, tz), st = trimOrNull(f.status) || '';
    const tt = textTimes(st, schedDate, nature);
    const word = st.replace(/\s*\d{1,2}:\d{2}.*$/, '');
    return rec({
      number: f.flightNo, schedDate, ...tt, status: /^(schedule|estimate|expected)/i.test(word) ? null : statusIt(word, nature), statusCode: word,
      gate: A ? null : f.gate, checkin: A || !f.checkInDeskFrom ? null : `${f.checkInDeskFrom}${f.checkInDeskTo && f.checkInDeskTo !== f.checkInDeskFrom ? `-${f.checkInDeskTo}` : ''}`,
      belt: A ? f.baggageBelt : null, type: titleCase(f.aircraftType), city: f.airport?.name, cityCode: f.airport?.codes?.iata, airline: f.airline?.name, codeshare: f.codeshareFlights,
    }, nature);
  }), tz, 'Edimburgo');
}

// ---------- Colonia/Bonn ----------
// POST koeln-bonn-airport.de/fluggaeste/fluege/abflug-ankunft/fsjson (modulo del sito), 25 voli per pagina, ora locale.
async function cologne(nature, log) {
  const tz = 'Europe/Berlin', d = localNow(tz, -180);
  const page = p => getText('https://www.koeln-bonn-airport.de/fluggaeste/fluege/abflug-ankunft/fsjson', log, {
    name: 'Colonia/Bonn', method: 'POST', quiet: p > 0, headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
    body: `mode=${nature}&tolerance=&page=${p}&START=&END=&destination=&date=${encodeURIComponent(`${d.date}T${d.hm}`)}&more=` }).then(t => JSON.parse(t).flights || []);
  const pages = await Promise.all([0, 1, 2, 3, 4, 5].map(p => page(p).catch(e => (p ? [] : Promise.reject(e)))));
  return finish(pages.flat().map(f => {
    const schedDate = toLocal(f.datetime, tz), st = strip(f.statusF);
    const exp = clock(f.expected || f.late);
    const tt = exp ? textTimes(`${/gestartet|gelandet/i.test(st) ? 'landed ' : ''}${exp}`, schedDate, nature) : {};
    return rec({
      number: f.number, schedDate, ...tt, actualAt: tt.actualAt || (/gestartet|gelandet/i.test(st) ? schedDate : null), status: statusIt(st, nature), statusCode: f.status,
      gate: nature === 'A' ? null : f.gate, checkin: nature === 'A' ? null : f.locationD, terminal: nature === 'A' ? f.locationA : null,
      city: f.destination_expanded || f.origin_expanded, cityCode: f.destination || f.origin, airline: f.operating_carrier_name,
    }, nature);
  }), tz, 'Colonia/Bonn');
}

// ---------- Budapest ----------
// GET bud.hu/ajax/flight-search?date=&time=&direction= (API del sito): ~2 ore per chiamata, ora locale.
async function budapest(nature, log) {
  const A = nature === 'A', tz = 'Europe/Budapest';
  const steps = [-180, -60, 60, 180, 300, 420, 540, 660].map(m => localNow(tz, m));
  const res = await Promise.all(steps.map((s, i) => getText(`https://www.bud.hu/ajax/flight-search?locale=en&query=&date=${s.date}&time=${s.hm.slice(0, 2)}:00&hideDeparted=0&hideArrived=0&direction=${A ? 'arrivals' : 'departures'}`, log,
    { name: 'Budapest', quiet: i > 0, headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' } }).then(t => JSON.parse(t)).catch(() => null)));
  if (res.every(r => r == null)) throw new Error('Budapest: nessuna risposta');
  const seen = new Set();
  return finish(res.filter(Boolean).flat().filter(f => f && !seen.has(f.uniqueAutoId) && seen.add(f.uniqueAutoId)).map(f => {
    const m = /(\d\d)\.(\d\d)\.(\d{4})/.exec(f.date || '');
    const date = m ? `${m[3]}-${m[2]}-${m[1]}` : null;
    const schedDate = date && f.planned ? `${date}T${f.planned}` : null;
    const type = f.status?.type || '';
    const exp = f.expected && schedDate ? textTimes(`${/landed|departed|taxied|airborne/.test(type) ? 'landed ' : ''}${f.expected}`, schedDate, nature) : {};
    return rec({
      number: f.flightNumber, schedDate, ...exp, status: type === 'scheduled' ? null : statusIt(f.status?.text, nature), statusCode: type,
      gate: A ? null : f.gate, checkin: A ? null : f.checkIn?.rangeAllocated, belt: A ? f.baggageClaim : null, reg: f.registration, terminal: f.terminal,
      city: f.city || f.destination, airline: f.airline?.name, codeshare: (f.codeshareFlights || []).map(c => c.flightNumber),
    }, nature);
  }), tz, 'Budapest');
}

// ---------- Grecia (Fraport Greece: Salonicco, Chania, ...) ----------
// GET <sito>/en/_jcr_content.departures.json | arrivals.json: stesso formato di Francoforte, ora locale.
async function fraportGreece(host, name, nature, log) {
  const A = nature === 'A', tz = 'Europe/Athens';
  const j = JSON.parse(await getText(`https://www.${host}/en/_jcr_content.${A ? 'arrivals' : 'departures'}.json`, log, { name }));
  return finish((j.data || []).map(f => {
    const st = strip(f.status);
    const schedDate = toLocal(f.sched, tz), est = toLocal(f.esti, tz);
    const done = /depart|airborne|landed|arrived/i.test(st);
    return rec({
      number: f.fnr, schedDate, estAt: done ? null : est, actualAt: done ? est || schedDate : null, status: statusIt(st, nature), statusCode: st || null,
      gate: A ? null : f.gate, checkin: A ? null : f.schalter, belt: A ? (f.bag || []).join(', ') || f.ausgang : null, terminal: f.terminal,
      city: f.apname, cityCode: f.iata, airline: f.alname, codeshare: f.cs,
    }, nature);
  }), tz, name);
}

// ---------- Basilea-Mulhouse (EuroAirport) ----------
// Elenco del sito (Drupal, 10 voli per pagina, dall'ora indicata) + JSON pubblico del singolo volo /eap_api/data/flight/{id}/en
// (orari stimati ed effettivi, gate, stand, nastro, marche e tipo aereo). Orari locali (Europe/Paris).
async function euroairport(nature, log) {
  const tz = 'Europe/Paris', A = nature === 'A', from = localNow(tz, -180);
  const base = `https://www.euroairport.com/en/${A ? 'vols-a-l-arrivee' : 'vols-au-depart'}?flight_type=passagers&field_scheduled_time=${encodeURIComponent(`${from.date} ${from.hm}`)}`;
  const pages = await Promise.all([0, 1, 2, 3, 4].map(p => getText(`${base}&page=${p}`, log, { name: 'EuroAirport', quiet: true, accept: 'text/html' }).catch(() => '')));
  if (!pages.some(Boolean)) throw new Error('EuroAirport: nessuna risposta');
  const rows = new Map();
  for (const t of pages) for (const m of t.matchAll(/data-eap-flight-id="(\d+)"([\s\S]*?)<\/article>/g)) {
    const h = m[2];
    rows.set(m[1], { sched: clock(/<time[^>]*>([^<]*)</.exec(h)?.[1]), city: strip(/flight-teaser__airport">([\s\S]*?)<\/a>/.exec(h)?.[1] || ''),
      number: strip(/body__code">([^<]*)</.exec(h)?.[1] || ''), airline: strip((/<\/span>([^<]*)<\/p>/.exec(h)?.[1]) || '') });
  }
  const ids = [...rows.keys()].slice(0, 40), today = localNow(tz).date, out = [];
  const at = (date, hm, ref) => { // HH:MM vicino all'orario previsto (passaggio della mezzanotte)
    if (!clock(hm)) return null;
    let d = date; const diff = hmMin(hm) - hmMin(ref || hm);
    if (ref && diff < -720) d = addDays(date, 1); else if (ref && diff > 720) d = addDays(date, -1);
    return `${d}T${clock(hm)}`;
  };
  const det = await Promise.all(ids.map(id => getText(`https://www.euroairport.com/eap_api/data/flight/${id}/en`, log, { name: 'EuroAirport', quiet: true, timeout: 10000 })
    .then(t => JSON.parse(t).flights?.[0]).catch(() => null)));
  ids.forEach((id, i) => {
    const r = rows.get(id), f = det[i];
    if (!f) { // solo l'elenco: orario previsto, città, volo
      if (r.sched && r.number) out.push(rec({ number: r.number, schedDate: `${today}T${r.sched}`, city: titleCase(r.city), airline: r.airline }, nature));
      return;
    }
    const s = A ? f.sta : f.std, date = f.flight_date || today, schedDate = at(date, s);
    if (!schedDate) return;
    const st = (f.flight_status_text || '').trim(), dash = v => (v && v !== '-' ? v : null);
    out.push(rec({ number: f.flight_no_iata || f.flight_no || r.number, schedDate,
      estAt: at(date, A ? f.eta : f.etd, s), actualAt: at(date, A ? f.ata : f.atd, s),
      status: statusIt(st.replace(/\s*\d{1,2}:\d{2}.*$/, ''), nature), statusCode: f.flight_status_code || st || null,
      gate: A ? null : dash(f.boarding_gate), checkin: A ? null : dash(f.check_in_counter), stand: dash(f.aircraft_parking_position), belt: A ? dash(f.belt_no) : null,
      reg: f.aircraft_reg_no, type: f.aircraft_type_code || f.aircraft_type, city: titleCase(f.airport_name || f.airport_name_custom || r.city), cityCode: f.airport_iata,
      airline: f.airline_name || r.airline, codeshare: (f.code_share_no || []).map(c => typeof c === 'string' ? c : c?.flight_no_iata || c?.flight_no) }, nature));
  });
  return finish(out, tz, 'EuroAirport');
}

// ---------- Stoccarda (STR) ----------
// Tabellone HTML del sito (ieri sera, oggi e domani in un'unica pagina, ~1,2 MB). Orari locali "H:MM";
// is--yesterday = ieri; data-flights-day = today/tomorrow. Codice IATA della città in fondo a data-filter.
async function stuttgart(nature, log) {
  const tz = 'Europe/Berlin', A = nature === 'A', today = localNow(tz).date, out = [];
  const t = await getText('https://www.stuttgart-airport.com/de/reisende-besucher/fliegen/ankunft-abflug', log, { name: 'Stoccarda', quiet: true, accept: 'text/html', timeout: 20000 });
  const re = new RegExp(`<a href="[^"]*/ankunft-abflug/\\d+"[^>]*data-flights-day="([a-z]+)"[^>]*data-flights-table-traffic="${A ? 'arrival' : 'departure'}" data-filter="([^"]*)"[^>]*>([\\s\\S]*?)</a>`, 'g');
  for (const m of t.matchAll(re)) {
    const h = m[3], cell = c => strip((new RegExp(`flights-table__cell-${c}[^"]*">([\\s\\S]*?)</div>\\s*(?:<div data-role|$)`).exec(h) || [])[1] || '').replace(/^[A-Za-z-]+:\s*/, '');
    const plan = clock(/is--plan">([^<]*)</.exec(h)?.[1]), est = clock(/<span class="is--(?:late|early|ontime|delayed)">([^<]*)</.exec(h)?.[1]);
    if (!plan) continue;
    const day = /is--yesterday/.test(h) ? -1 : m[1] === 'tomorrow' ? 1 : 0, date = addDays(today, day), schedDate = `${date}T${plan}`;
    const air = /flights-table__cell-airline">[\s\S]*?<p>\s*([^<]+?)\s*(?:<br>\s*([^<]+?)\s*)?<\/p>/.exec(h) || [];
    const st = strip((/data-tag><span>([^<]*)</.exec(h) || [])[1] || '');
    let estAt = null;
    if (est) { let d = date; const diff = hmMin(est) - hmMin(plan); if (diff < -720) d = addDays(date, 1); else if (diff > 720) d = addDays(date, -1); estAt = `${d}T${est}`; }
    const done = /gestartet|gelandet|gepäck/i.test(st);
    const code = (/([A-Z]{3})\s*$/.exec(m[2]) || [])[1];
    out.push(rec({ number: air[1], schedDate, estAt: done ? null : estAt, actualAt: done ? estAt : null,
      status: statusIt(st, nature), statusCode: st || null, gate: A ? null : cell('gate') || null, checkin: A ? null : cell('checkin') || null,
      terminal: cell('terminal') || null, type: cell('aircraft') || null, city: titleCase(cell('from')), cityCode: code, airline: air[2] }, nature));
  }
  return finish(out, tz, 'Stoccarda');
}

// ---------- Tabelloni HTML ----------
const attr = (html, name) => (new RegExp(`${name}="([^"]*)"`).exec(html) || [])[1];
const unesc = s => (s || '').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

// Varsavia Chopin: pagine HTML del sito (?page=N&operation=a|d), 20 voli per pagina, ora locale
async function warsaw(nature, log) {
  const tz = 'Europe/Warsaw', op = nature === 'A' ? 'a' : 'd';
  const pages = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(p => getText(`https://lotnisko-chopina.pl/en/arrivals-and-departures/?page=${p}&operation=${op}`, log,
    { name: 'Varsavia', quiet: p > 1, accept: 'text/html', headers: { 'X-Requested-With': 'XMLHttpRequest' } }).catch(e => (p > 1 ? '' : Promise.reject(e)))));
  const out = [];
  for (const t of pages) {
    let date = null;
    const list = t.slice(t.indexOf('id="flights-list"'));
    for (const m of list.matchAll(/(?:(\d\d)\.(\d\d)\.(\d{4})<\/div>)|<div class="row flight-row([\s\S]*?)<\/li>/g)) {
      if (m[1]) { date = `${m[3]}-${m[2]}-${m[1]}`; continue; }
      const h = m[4], col = c => strip((new RegExp(`column-${c}[^"]*">([\\s\\S]*?)</div>`).exec(h) || [])[1]);
      const sched = clock(col('time')), exp = clock(col('expected')), st = col('status');
      if (!date || !sched) continue;
      const schedDate = `${date}T${sched}`;
      const tt = exp ? textTimes(`${/landed|departed/i.test(st) ? 'landed ' : ''}${exp}`, schedDate, nature) : {};
      const cm = /^(.*?)\s*\(([A-Z]{3})\)$/.exec(col('origin-destination'));
      out.push(rec({
        number: col('flight-no'), schedDate, ...tt, actualAt: tt.actualAt || (/landed|departed/i.test(st) ? null : null), status: statusIt(st, nature), statusCode: st,
        gate: nature === 'A' ? null : col('gate'), checkin: nature === 'A' ? null : col('check-in'), belt: nature === 'A' ? col('belt').replace(/^tape\s*/i, '') : null,
        terminal: col('terminal'), city: cm ? cm[1] : col('origin-destination'), cityCode: cm?.[2], airline: attr(/column-airline[\s\S]*?<\/div>/.exec(h)?.[0] || '', 'alt'),
      }, nature));
    }
  }
  return finish(out, tz, 'Varsavia');
}

// Cracovia: tabella HTML del sito (data nel link al dettaglio del volo), ora locale
async function krakow(nature, log) {
  const tz = 'Europe/Warsaw', kind = nature === 'A' ? 'arrivals' : 'departures';
  const t = await getText(`https://krakowairport.pl/en/passenger/flights/destinations/${kind}`, log, { name: 'Cracovia', quiet: true, accept: 'text/html' });
  const out = [];
  for (const m of t.matchAll(/<tr>\s*<th scope="row">([\s\S]*?)<\/tr>/g)) {
    const h = m[1], cells = [...h.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => strip(c[1].replace(/<!--[\s\S]*?-->/g, '')));
    const link = /\/flight\/(?:departures|arrivals)\/[^/]+\/(\d\d)-(\d\d)-(\d{4})\/(\d\d)(\d\d)/.exec(h);
    if (!link) continue;
    const schedDate = `${link[3]}-${link[2]}-${link[1]}T${link[4]}:${link[5]}`;
    const cm = /^(.*?)\s*\(([A-Z]{3})\)$/.exec(cells[0] || '');
    const st = cells[2] || '';
    out.push(rec({ number: cells[1], schedDate, ...textTimes(st, schedDate, nature), status: statusIt(st.replace(/\s*\d{1,2}:\d{2}.*$/, ''), nature), statusCode: st,
      city: titleCase(cm ? cm[1] : cells[0]), cityCode: cm?.[2] }, nature));
  }
  return finish(out, tz, 'Cracovia');
}

// Larnaca e Paphos (Hermes Airports): tabelle HTML, data nell'attributo alt ("2026/11/10 18:00 GMT+02:00:00|EK0110|101")
async function hermes(code, nature, log) {
  const tz = 'Asia/Nicosia', A = nature === 'A';
  const t = await getText(`https://www.hermesairports.com/flight-info/arrivals-and-departures-${code.toLowerCase()}/`, log, { name: 'Hermes Airports', quiet: true, accept: 'text/html' });
  const i = t.indexOf(A ? 'id="arrivals-results-container"' : 'id="departures-results-container"');
  if (i < 0) throw new Error('Hermes Airports: tabella non trovata');
  const seg = t.slice(i, t.indexOf('</table>', i));
  const out = [];
  for (const m of seg.matchAll(/<tr class="inside-table-text">([\s\S]*?)<\/tr>/g)) {
    const h = m[1], cells = [...h.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => strip(c[1]));
    const d = /alt="(\d{4})\/(\d\d)\/(\d\d) (\d\d:\d\d)/.exec(h);
    if (!d) continue;
    const schedDate = `${d[1]}-${d[2]}-${d[3]}T${d[4]}`;
    const nums = (cells[1] || '').split('/').map(s => s.trim()).filter(Boolean);
    const st = cells[4] || '';
    out.push(rec({ number: nums[0], schedDate, ...textTimes(st, schedDate, nature), status: statusIt(st.replace(/\s*\d{1,2}:\d{2}.*$/, ''), nature), statusCode: st,
      city: cells[2], airline: titleCase(attr(h, 'title')), codeshare: nums.slice(1) }, nature));
  }
  return finish(out, tz, 'Hermes Airports');
}

// Malta: tabella HTML; i dati di ogni volo sono anche nel JSON del pulsante "Save flight"
async function malta(nature, log) {
  const tz = 'Europe/Malta';
  const t = await getText(`https://maltairport.com/flights/${nature === 'A' ? 'arrivals' : 'departures'}/`, log, { name: 'Malta', quiet: true, accept: 'text/html' });
  const today = localNow(tz).date, out = [];
  for (const m of t.matchAll(/toggleSaveFlight\(JSON\.parse\('([^']+)'/g)) {
    let f;
    try { f = JSON.parse(unesc(m[1]).replace(/\\\//g, '/')); } catch { continue; }
    const date = f.day === 'tomorrow' ? addDays(today, 1) : f.day === 'yesterday' ? addDays(today, -1) : today;
    const schedDate = f.time ? `${date}T${f.time.slice(0, 5)}` : null;
    const st = trimOrNull(f.status) || '';
    out.push(rec({ number: f.flight, schedDate, ...textTimes(st, schedDate, nature), status: statusIt(st.replace(/\s*\d{1,2}:\d{2}.*$/, ''), nature), statusCode: st,
      city: f.destination || f.origin, airline: f.airline }, nature));
  }
  return finish(out, tz, 'Malta');
}

// ---------- Trapani (Airgest) ----------
// JSON del sito airgest.it (/voli-dati?type=dep|arr), voli di oggi. "terminal" è il gate (partenze) o il nastro (arrivi).
async function trapani(nature, log) {
  const A = nature === 'A', tz = 'Europe/Rome';
  const list = JSON.parse(await getText(`https://www.airgest.it/voli-dati?type=${A ? 'arr' : 'dep'}`, log, { name: 'Trapani', headers: { 'X-Requested-With': 'XMLHttpRequest' } }));
  const out = (Array.isArray(list) ? list : []).map(f => {
    const date = (f.date || localNow(tz).date).replace(/\//g, '-');
    const schedDate = clock(f.scheduled) ? `${date}T${clock(f.scheduled)}` : null;
    const st = trimOrNull(f.statusEN) || trimOrNull(f.statusIT) || '';
    const status = statusIt(st, nature);
    const t = clock(f.actual), at = t && schedDate ? `${date}T${t}` : null;
    const done = isDone(status);
    return rec({ number: f.flightCode, schedDate, estAt: !done && at !== schedDate ? at : null, actualAt: done ? at || schedDate : null,
      status, statusCode: trimOrNull(f.statusIT), gate: A ? null : f.terminal, belt: A ? f.terminal : null,
      city: titleCase(f.destinationIT || f.destinationEN), cityCode: f.airportCode, airline: titleCase(f.airline) }, nature);
  });
  return finish(out, tz, 'Trapani');
}

// ---------- Ancona (Aeroporto delle Marche) ----------
// La home e le pagine partenze/arrivi di ancona-airport.com contengono l'XML <FLIGHTS> del giorno (widget_voli_stamp).
// stato: C = partito, J = atterrato (visti il 2026-11-10); gli altri codici si mostrano come sono.
async function ancona(nature, log) {
  const A = nature === 'A', tz = 'Europe/Rome';
  const t = await getText(`https://www.ancona-airport.com/passeggeri/voli/${A ? 'arrivi' : 'partenze'}/`, log, { name: 'Ancona', quiet: true, accept: 'text/html' });
  const x = /<FLIGHTS update="(\d\d)\/(\d\d)\/(\d{4})[^"]*">([\s\S]*?)<\/FLIGHTS>/.exec(t);
  if (!x) throw new Error('Ancona: tabellone non trovato');
  const date = `${x[3]}-${x[2]}-${x[1]}`;
  const CODES = { C: A ? 'Atterrato' : 'Decollato', J: A ? 'Atterrato' : 'Decollato', X: 'Cancellato', D: 'Dirottato', R: 'Ritardato', B: 'Imbarco', I: 'Imbarco', K: 'Check-in' };
  const out = [...x[4].matchAll(/<FLIGHT ([^>]*)\/>/g)].map(m => {
    const a = unesc(m[1]), g = n => attr(a, n);
    const schedDate = clock(g('sched')) ? `${date}T${clock(g('sched'))}` : null;
    const code = trimOrNull(g('stato'));
    let status = CODES[code] || code;
    if (trimOrNull(g('dirottato_su'))) status = 'Dirottato';
    const e = clock(g('expect')), at = e && schedDate ? textTimes(e, schedDate, nature).estAt || null : null;
    const done = isDone(status);
    return rec({ number: `${g('code')}${g('numero')}`, schedDate, estAt: done ? null : at, actualAt: done ? at || schedDate : null,
      status, statusCode: code, terminal: g('terminal'), city: titleCase(g('city')), cityCode: g('airport_iata'), airline: titleCase(g('carrier')) }, nature);
  });
  return finish(out, tz, 'Ancona');
}

// ---------- Trieste ----------
// Tabelle HTML "Voli in tempo reale" di triesteairport.it: Volo, Destinazione/Provenienza (città + IATA), Previsto, Stimato, Note.
// Le righe non hanno la data: l'elenco va da adesso in avanti, quindi quando l'orario torna indietro di molto si passa a domani.
async function trieste(nature, log) {
  const A = nature === 'A', tz = 'Europe/Rome';
  const t = await getText('https://triesteairport.it/it/airport/voli-e-destinazioni/voli-in-tempo-reale/', log, { name: 'Trieste', quiet: true, accept: 'text/html' });
  const parts = t.split(/<h3>\s*(?:Partenze|Arrivi)\s*<\/h3>/);
  const html = (A ? parts[2] : parts[1]) || '';
  const tbl = (/<table[\s\S]*?<\/table>/.exec(html) || [''])[0];
  const now = localNow(tz);
  let date = now.date, prev = null, first = true;
  const out = [];
  for (const c of tableRows(tbl)) {
    if (c.length < 4) continue;
    const sched = clock(c[2]);
    if (!sched) continue;
    if (first && hmMin(sched) < now.min - 6 * 60) date = addDays(now.date, 1);
    else if (prev != null && hmMin(sched) < prev - 6 * 60) date = addDays(date, 1);
    first = false; prev = hmMin(sched);
    const schedDate = `${date}T${sched}`, st = c[4] || '';
    const status = /check-?in (chius|closed)/i.test(st) ? 'Check-in chiuso' : statusIt(st, nature), exp = clock(c[3]);
    const at = exp ? textTimes(exp, schedDate, nature).estAt || null : null;
    const done = isDone(status);
    const pm = /^(.*?)\s+([A-Z]{3})$/.exec(c[1] || '');
    out.push(rec({ number: c[0], schedDate, estAt: done ? null : at, actualAt: done ? at || schedDate : null, status, statusCode: st || null,
      city: pm ? pm[1] : c[1], cityCode: pm ? pm[2] : null }, nature));
  }
  return finish(out, tz, 'Trieste');
}

// Zagabria: tabella HTML con attributi data-*, oggi e domani (?sutra=1)
async function zagreb(nature, log) {
  const tz = 'Europe/Zagreb', A = nature === 'A', path = A ? 'arrivals/34' : 'departures/33';
  const days = await Promise.all(['', '?sutra=1'].map((q, i) => getText(`https://www.zagreb-airport.hr/en/passengers/flight-information/${path}${q}`, log,
    { name: 'Zagabria', quiet: true, accept: 'text/html' }).catch(e => (i ? '' : Promise.reject(e)))));
  const out = [];
  days.forEach((t, i) => {
    const date = localNow(tz, i * 1440).date;
    for (const m of t.matchAll(/<tr class="let"([^>]*)>([\s\S]*?)<\/tr>/g)) {
      const a = unesc(m[1]), h = m[2];
      const td = c => strip((new RegExp(`class="fi-${c}">([\\s\\S]*?)</td>`).exec(h) || [])[1]).replace(/^(Scheduled|Expected|Status|Flight No\.)\s*/i, '');
      const sched = clock(td('sta')), exp = clock(td('eta')), st = td('status'), speak = attr(a, 'data-speak') || '';
      if (!sched) continue;
      const schedDate = `${date}T${sched}`;
      const done = /take ?off|departed|arrived|landed/i.test(st);
      const tt = exp && exp !== sched ? textTimes(`${done ? 'landed ' : ''}${exp}`, schedDate, nature) : done ? { actualAt: schedDate } : {};
      out.push(rec({ number: attr(a, 'data-flight'), schedDate, ...tt, status: statusIt(st, nature), statusCode: st,
        gate: A ? null : /gate number ([A-Z0-9]+)/i.exec(speak)?.[1], belt: A ? /belt number '?([0-9A-Z]+)/i.exec(speak)?.[1] : null,
        city: titleCase(attr(a, 'data-city')), airline: attr(a, 'data-airline'), codeshare: (attr(a, 'data-codeshare') || '').split(/[,\s]+/).filter(Boolean) }, nature));
    }
  });
  return finish(out, tz, 'Zagabria');
}

// Dubrovnik: pagina HTML con il JSON di ogni volo nell'attributo data-item (marche, codeshare)
async function dubrovnik(nature, log) {
  const tz = 'Europe/Zagreb', A = nature === 'A';
  const t = await getText(`https://www.dbv.hr/en/${A ? 'arrivals/40' : 'departures/42'}`, log, { name: 'Dubrovnik', quiet: true, accept: 'text/html' });
  const out = [];
  for (const m of t.matchAll(/data-item="([^"]+)"/g)) {
    let f;
    try { f = JSON.parse(unesc(m[1])); } catch { continue; }
    if ((f.Ad || '').toUpperCase() !== nature) continue;
    const schedDate = toLocal(f.SchDateTime, tz), act = toLocal(f.ActDateTime, tz), est = toLocal(f.EstDateTime, tz);
    out.push(rec({ number: f.FlgtCode, schedDate, estAt: est !== schedDate ? est : null, actualAt: act, status: f.Cancelled ? 'Cancellato' : statusIt(f.RemarkPublic, nature), statusCode: f.RemarkPublic,
      gate: A ? null : f.DepGate, belt: A ? f.ArBaggiView || f.ArBaggd : null, reg: f.AirplaneReg, type: f.AirplaneType, city: titleCase(f.FromTo), cityCode: f.FromToCode,
      airline: f.CarrierName, codeshare: (f.FlightCodeShare || '').split(',') }, nature));
  }
  return finish(out, tz, 'Dubrovnik');
}

// Strasburgo: pagina "vols du jour en temps réel" (HTML), data "dd/mm/yy"
async function strasbourg(nature, log) {
  const tz = 'Europe/Paris', A = nature === 'A';
  const t = await getText(`https://www.strasbourg.aeroport.fr/en/passengers/to-travel/live-flight-information/?active=${A ? 'arrivee' : 'depart'}`, log, { name: 'Strasburgo', quiet: true, accept: 'text/html' });
  const i = t.indexOf(A ? 'view_arrivee' : 'view_depart');
  const seg = t.slice(i, t.indexOf(A ? 'view_depart' : 'view_arrivee', i + 20) > 0 ? t.indexOf(A ? 'view_depart' : 'view_arrivee', i + 20) : undefined);
  const out = [];
  for (const m of seg.matchAll(/<div class="ligne-vol"\s*>([\s\S]*?)<\/div>\s*<\/div>(?=\s*<div class="ligne-vol"|\s*<\/div>)/g)) {
    const v = c => strip((new RegExp(`class='${c}'[^>]*>[\\s\\S]*?class='value'[^>]*>([\\s\\S]*?)</span>`).exec(m[1]) || [])[1]);
    const d = /(\d\d)\/(\d\d)\/(\d\d)/.exec(v('date')), sched = clock(v('horaire'));
    if (!d || !sched) continue;
    const schedDate = `20${d[3]}-${d[2]}-${d[1]}T${sched}`, st = v('observ');
    out.push(rec({ number: v('num_vol'), schedDate, ...textTimes(st, schedDate, nature), status: statusIt(st.replace(/\s*\d{1,2}[:h]\d{2}.*$/, ''), nature), statusCode: st,
      city: titleCase(v('ville')), airline: v('compagnie') }, nature));
  }
  return finish(out, tz, 'Strasburgo');
}

// SACAL (Lamezia, Reggio Calabria, Crotone): tabella HTML del giorno su sacal.it/it/<aeroporto>/arrivi|partenze/
// (volo, città, orario, "est.HH:MM", stato); gate e nastro dai pochi voli in JSON nella home dell'aeroporto
const SACAL = { SUF: ['lamezia-terme', 'Lamezia Terme'], REG: ['reggio-calabria', 'Reggio Calabria'], CRV: ['crotone', 'Crotone'] };
async function sacal(code, nature, log) {
  const tz = 'Europe/Rome', A = nature === 'A', [slug, name] = SACAL[code];
  const [t, home] = await Promise.all([
    getText(`https://sacal.it/it/${slug}/${A ? 'arrivi' : 'partenze'}/`, log, { name, quiet: true, accept: 'text/html' }),
    getText(`https://sacal.it/it/${slug}/`, log, { name, quiet: true, accept: 'text/html' }).catch(() => ''),
  ]);
  const extra = {};
  const js = new RegExp(`${A ? 'arrivals' : 'departures'}\\s*:\\s*(\\[[\\s\\S]*?\\])\\s*[,}]`).exec(home);
  if (js) try { for (const o of JSON.parse(js[1])) extra[normNum(o.flight)] = o; } catch {}
  const i = t.indexOf(A ? 'id="container-arrivi"' : 'id="container-partenze"'), seg = i >= 0 ? t.slice(i) : t;
  const today = localNow(tz).date, out = [];
  for (const m of seg.slice(0, Math.max(0, seg.indexOf('</table>')) || undefined).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const td = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(x => strip(x[1]));
    if (td.length < 4) continue;
    const sched = clock(td[2]);
    if (!td[0] || !sched) continue;
    const schedDate = `${today}T${sched}`, st = td[4] || '', e = clock((/(\d{1,2}:\d{2})/.exec(td[3]) || [])[1]);
    let estAt = null;
    if (e) { const diff = hmMin(e) - hmMin(sched); estAt = `${diff < -720 ? addDays(today, 1) : diff > 720 ? addDays(today, -1) : today}T${e}`; }
    const done = /atterrat|decollat|arrivat/i.test(st), x = extra[normNum(td[0])] || {};
    const cm = /^(.*?)\s*\(([A-Z]{3})\)\s*$/.exec(td[1]);
    out.push(rec({ number: td[0], schedDate, estAt: done ? null : estAt, actualAt: done ? estAt : null,
      status: statusIt(st || x.gate_status || '', nature), statusCode: st || null,
      gate: A ? null : x.gate, belt: A ? x.belt : null, city: cm ? cm[1] : td[1], cityCode: cm ? cm[2] : null }, nature));
  }
  return finish(out, tz, name);
}

// Karlsruhe/Baden-Baden: pagina "Tagesaktueller Flugplan" (HTML), solo orario; "Morgen" = domani
async function badenAirpark(nature, log) {
  const tz = 'Europe/Berlin', A = nature === 'A';
  const t = await getText('https://www.baden-airpark.de/passagiere-besucher/fluege/tagesaktueller-flugplan/', log, { name: 'Baden-Airpark', quiet: true, accept: 'text/html' });
  const i = t.indexOf(A ? 'flight-results-block-arrivals&quot;' : 'flight-results-block-departures&quot;');
  const j = t.indexOf(A ? 'data-ajax-message="flight-results-block-arrivals"' : 'data-ajax-message="flight-results-block-departures"', i);
  const seg = t.slice(i, j > 0 ? j : undefined), today = localNow(tz).date, out = [];
  for (const r of seg.split('class="flight-table__row').slice(1)) {
    const col = c => [...((new RegExp(`flight-table__col__${c}[^"]*"[^>]*>([\\s\\S]*?)</div>\\s*(?=<div role="cell"|</div>)`).exec(r) || [])[1] || '').matchAll(/<(?:span|a)[^>]*>([^<]*)</g)].map(x => x[1].trim()).filter(Boolean);
    const o = col('origin'), stc = col('status'), cm = col('comment'), g = col('gate');
    const sched = clock(stc[0]);
    if (!o[1] || !sched) continue;
    const date = cm.some(x => /morgen/i.test(x)) ? addDays(today, 1) : today;
    const schedDate = `${date}T${sched}`, st = cm.filter(x => !/^(heute|morgen)$/i.test(x)).join(' ');
    out.push(rec({ number: o[1], schedDate, ...textTimes(st, schedDate, nature), status: statusIt(st.replace(/\s*\d{1,2}:\d{2}.*$/, ''), nature), statusCode: st || null,
      gate: A ? null : g[0], city: titleCase(o[0]), airline: col('airline')[0] }, nature));
  }
  return finish(out, tz, 'Baden-Airpark');
}
