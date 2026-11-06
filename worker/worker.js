// Cloudflare Worker per "Tabellone Voli": legge i tabelloni ufficiali di alcuni aeroporti
// (che il browser non può leggere direttamente) e li restituisce in un formato unico.
//
//   GET /board?airport=PSA&nature=D   (D = partenze, A = arrivi)  →  { flights: [...] }
//   GET /debug?airport=PSA&nature=D                                 →  diagnostica (URL provati, inizio risposta)
//
// Uso personale: le risposte restano in cache 90 secondi, così l'aeroporto riceve poche richieste.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const CACHE_SECONDS = 90;

const STAFF_MONITOR = {
  PSA: ['https://servizi.pisa-airport.com/staffMonitor/staffMonitor'],
  FLR: [
    'https://servizi.aeroporto.firenze.it/staffMonitor/staffMonitor',
    'https://servizi.florence-airport.com/staffMonitor/staffMonitor',
    'https://servizi.toscana-aeroporti.com/staffMonitor/staffMonitor',
  ],
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || 'https://gbagliesi.github.io,http://localhost:8000').split(',').map(s => s.trim());
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const airport = (url.searchParams.get('airport') || '').toUpperCase();
    const nature = url.searchParams.get('nature') === 'A' ? 'A' : 'D';
    const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors, ...extra } });

    if (url.pathname === '/' ) return json({ ok: true, airports: [...Object.keys(STAFF_MONITOR), 'GVA'] });
    if (!['/board', '/debug'].includes(url.pathname)) return json({ error: 'not found' }, 404);
    if (!STAFF_MONITOR[airport] && airport !== 'GVA') return json({ error: `aeroporto ${airport} non supportato` }, 400);

    const debug = url.pathname === '/debug';
    const cacheKey = new Request(`https://cache.local/board/${airport}/${nature}`);
    if (!debug) {
      const hit = await caches.default.match(cacheKey);
      if (hit) return json(await hit.json(), 200, { 'X-Cache': 'HIT' });
    }

    const log = [];
    try {
      const flights = airport === 'GVA' ? await geneva(nature, log) : await staffMonitor(airport, nature, log);
      const body = { airport, nature, fetchedAt: new Date().toISOString(), count: flights.length, flights };
      if (debug) return json({ ...body, flights: flights.slice(0, 5), log });
      if (flights.length) ctx.waitUntil(caches.default.put(cacheKey, new Response(JSON.stringify(body), { headers: { 'Cache-Control': `max-age=${CACHE_SECONDS}` } })));
      return json(body);
    } catch (e) {
      return json({ error: String(e.message || e), log: debug ? log : undefined }, 502);
    }
  },
};

// ---------- Toscana Aeroporti (Pisa, Firenze): monitor in XML o HTML ----------
async function staffMonitor(airport, nature, log) {
  for (const base of STAFF_MONITOR[airport]) {
    let cookie = '';
    // la sessione si apre con le partenze; gli arrivi la richiedono
    const get = async u => {
      const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'it-IT,it;q=0.9', 'Referer': `${base}.html`, ...(cookie ? { Cookie: cookie } : {}) } });
      const sc = r.headers.get('set-cookie') || '';
      const m = /JSESSIONID=([^;,\s]+)/i.exec(sc);
      if (m) cookie = `JSESSIONID=${m[1]}`;
      const t = await r.text();
      log.push({ url: u, status: r.status, length: t.length, start: t.slice(0, 300) });
      return r.ok && t.length > 200 ? t : '';
    };
    try {
      let body = await get(`${base}?trans=true&nature=D`);
      if (nature === 'A') body = await get(`${base}?trans=true&nature=A`) || await get(`${base}?nature=A`);
      if (!body) continue;
      const flights = /<FLIGHTS?\b/i.test(body) ? parseXml(body) : parseHtml(body);
      if (flights.length) return flights;
    } catch (e) { log.push({ url: base, error: String(e) }); }
  }
  return [];
}

const attr = (s, name) => { const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(s); return m ? m[1].trim() : ''; };
const clock = s => { const m = /(\d{1,2})[:.](\d{2})/.exec(s || ''); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null; };
const normNum = s => (s || '').trim().toUpperCase().replace(/\s+/g, '').replace(/^([A-Z][A-Z0-9]{1,2}?)0+(\d)/, '$1$2');

function parseXml(xml) {
  const out = [];
  for (const m of xml.matchAll(/<FLIGHT\b([^>]*)>([\s\S]*?)(?:<\/FLIGHT>|(?=<FLIGHT\b))|<FLIGHT\b([^>]*)\/>/gi)) {
    const a = m[1] || m[3] || '';
    const code = attr(a, 'code'), num = attr(a, 'number');
    if (!code || !num) continue;
    const conveyor = /<CONVEYOR\b([^>]*)/i.exec(m[2] || '');
    out.push({
      number: normNum(code + num), sched: clock(attr(a, 'schedulate')), est: clock(attr(a, 'expect')),
      actual: clock(attr(a, 'landed')) || clock(attr(a, 'takeoff')) || clock(attr(a, 'tkoff')),
      status: attr(a, 'state') || null, gate: attr(a, 'gate') || null, checkin: attr(a, 'checkin') || null,
      stand: attr(a, 'stand') || null, belt: conveyor ? attr(conveyor[1], 'code') || null : null,
      reg: fmtReg(attr(a, 'aircraftReg')), type: attr(a, 'aircraftType') || null, city: attr(a, 'city') || null,
    });
  }
  return out;
}

function parseHtml(html) {
  const strip = s => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
  const out = [];
  let cols = null;
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [];
    for (const c of tr[1].matchAll(/<t[dh]([^>]*)>([\s\S]*?)(?=<t[dh][\s>]|<\/tr|$)/gi)) {
      const span = +(/colspan\s*=\s*["']?(\d+)/i.exec(c[1])?.[1] || 1);
      cells.push(strip(c[2])); for (let k = 1; k < span; k++) cells.push('');
    }
    if (cells.length < 3) continue;
    if (!cols) {
      const low = cells.map(c => c.toLowerCase());
      const f = n => low.findIndex(n);
      const flight = f(c => /volo|flight|flt/.test(c));
      if (flight < 0) continue;
      cols = { flight, reg: f(c => c === 'reg' || c.includes('registr') || c.includes('marche')), type: f(c => c.includes('type') || c.includes('aircraft')),
        city: f(c => /dest|from|prov|^to$|^da$/.test(c)), sched: f(c => c === 'sched' || c.includes('schedul') || c.includes('programm')),
        est: f(c => c === 'exp' || c.includes('estim') || c.includes('previst')), status: f(c => c.includes('status') || c.includes('stato')),
        gate: f(c => c === 'gate' || c.includes('uscit')), checkin: f(c => c.includes('check') || c.includes('banc')), belt: f(c => /belt|nastro|bagg/.test(c)), stand: f(c => /stand|parch|posiz/.test(c)) };
      continue;
    }
    // il numero volo può stare nella colonna del logo o in quella successiva
    const raw = [cells[cols.flight], cells[cols.flight + 1]].map(x => (x || '').split(' ')[0]).find(x => /^[A-Z0-9]{2,3}\d/i.test(x) && /[A-Z]/i.test(x));
    if (!raw) continue;
    const g = i => (i >= 0 && cells[i] && !/^[-/]+$/.test(cells[i]) ? cells[i] : null);
    out.push({ number: normNum(raw), sched: clock(g(cols.sched)), est: clock(g(cols.est)), actual: null, status: g(cols.status), gate: g(cols.gate), checkin: g(cols.checkin), stand: g(cols.stand), belt: g(cols.belt), reg: fmtReg(g(cols.reg)), type: g(cols.type), city: g(cols.city) });
  }
  return out;
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

// Marche nel formato con trattino (EI-DWS, F-HPNB, HB-JQW, N123AB)
const PREFIX2 = ['EI', 'EC', 'HB', 'OE', 'PH', 'OO', 'SE', 'LN', 'OY', 'OH', 'SX', 'YR', 'TC', 'HA', 'SP', 'OK', 'OM', 'CS', 'TF', 'ES', 'YL', 'LY', 'UR', 'LZ', 'ER', 'S5', '9A', '9H', '4X', 'A6', 'A7', 'A9', 'VP', 'VQ', 'JA', 'HL', 'VH', 'ZS', 'SU', 'CN', 'TS', '5B', 'Z3', 'E7', '4O', 'T7', 'LX', 'EW', 'RA', 'VT', 'B'];
function fmtReg(r) {
  r = (r || '').trim().toUpperCase();
  if (!r) return null;
  if (r.includes('-') || /^N\d/.test(r)) return r;
  const p2 = PREFIX2.find(p => p.length === 2 && r.startsWith(p) && r.length >= 5);
  if (p2) return `${p2}-${r.slice(2)}`;
  if (/^[DFGIMC]/.test(r) && r.length === 5) return `${r[0]}-${r.slice(1)}`;
  return r;
}
