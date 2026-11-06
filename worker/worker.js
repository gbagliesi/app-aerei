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
    if (url.pathname === '/probe') return json(url.searchParams.get('page') ? await probePage(url.searchParams.get('page')) : await probeSite(url.searchParams.get('site') || 'fco'));
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
      const t0 = Date.now();
      let r;
      try {
        r = await fetch(u, { signal: AbortSignal.timeout(9000), headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'it-IT,it;q=0.9', 'Referer': `${base}.html`, ...(cookie ? { Cookie: cookie } : {}) } });
      } catch (e) { log.push({ url: u, error: String(e), ms: Date.now() - t0 }); return ''; }
      const sc = r.headers.get('set-cookie') || '';
      const m = /JSESSIONID=([^;,\s]+)/i.exec(sc);
      if (m) cookie = `JSESSIONID=${m[1]}`;
      const t = await r.text();
      log.push({ url: u, status: r.status, length: t.length, ms: Date.now() - t0, start: t.slice(0, 300) });
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

// ---------- ricognizione dei siti (Fiumicino, Bari) per trovare la fonte dei voli ----------
const PROBE_SITES = { fco: 'https://www.adr.it/', bri: 'https://www.aeroportidipuglia.it/' };
async function probeSite(site) {
  const homeUrl = PROBE_SITES[site.toLowerCase()];
  if (!homeUrl) return { error: `sito ${site} non previsto`, sites: Object.keys(PROBE_SITES) };
  const found = { pages: [], candidates: [] };
  const grab = async u => {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'it-IT,it;q=0.9' } });
      const t = await r.text();
      found.pages.push({ url: u, status: r.status, length: t.length });
      return t;
    } catch (e) { found.pages.push({ url: u, error: String(e) }); return ''; }
  };
  const abs = (h, base) => { try { return new URL(h.replace(/&amp;/g, '&'), base).href; } catch { return null; } };
  const home = await grab(homeUrl);
  const links = [...new Set([...home.matchAll(/href="([^"]*(?:partenz|departur|voli|flight)[^"]*)"/gi)].map(m => abs(m[1], homeUrl)).filter(Boolean))].slice(0, 6);
  found.links = links;
  for (const l of links.slice(0, 3)) {
    const html = await grab(l);
    for (const m of html.matchAll(/["'](https?:\/\/[^"'\s]*|\/[^"'\s]*)["']/g)) {
      const u = m[1];
      if (/api|json|ajax|flight|voli|partenz|departure|fids|resource|servlet|portlet/i.test(u) && !/\.(css|png|jpe?g|svg|woff2?|ico|gif)(\?|$)/i.test(u)) found.candidates.push(abs(u, l));
    }
  }
  found.candidates = [...new Set(found.candidates.filter(Boolean))].slice(0, 60);
  return found;
}

// Estratto di una pagina voli (solo siti degli aeroporti previsti): dove compaiono i numeri di volo e quali script/dati carica
async function probePage(page) {
  let u;
  try { u = new URL(page); } catch { return { error: 'indirizzo non valido' }; }
  if (!/(^|\.)(aeroportidipuglia\.it|adr\.it|firenze-airport\.it|pisa-airport\.com|toscana-aeroporti\.com|aeroporto\.firenze\.it)$/.test(u.hostname)) return { error: 'sito non previsto' };
  const r = await fetch(u.href, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': UA, 'Accept-Language': 'it-IT,it;q=0.9' } });
  const html = await r.text();
  const i = html.search(/\b(FR|AZ|W6|W4|U2|VY|LH|AF|KL|BA|EN|V7|DY|EW)\s?\d{2,4}\b/);
  const urls = [...new Set([...html.matchAll(/["'](https?:\/\/[^"'\s]+|\/[^"'\s]+)["']/g)].map(m => m[1]).filter(x => /ajax|api|json|wp-json|admin-ajax|flight|voli|partenz|arriv|fids|\.js(\?|$)/i.test(x) && !/\.(css|png|jpe?g|svg|woff2?|ico|gif)(\?|$)/i.test(x)))].slice(0, 60);
  const around = (re, before, after, max = 4) => { const out = []; for (const m of html.matchAll(re)) { out.push(html.slice(Math.max(0, m.index - before), m.index + after)); if (out.length >= max) break; } return out; };
  const body = html.replace(/<head[\s\S]*?<\/head>/i, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<svg[\s\S]*?<\/svg>/gi, '');
  return {
    url: u.href, status: r.status, length: html.length, flightAt: i, urls,
    ajax: around(/admin-ajax|ajaxurl|wp-json|fetch\(|\$\.(ajax|post|get)\(/g, 600, 900),
    tables: [...body.matchAll(/<table[\s\S]{0,2500}/gi)].slice(0, 2).map(m => m[0]),
    flightRows: i >= 0 ? [html.slice(Math.max(0, i - 1200), i + 1500)] : [],
    inlineScripts: [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1].trim()).filter(t => /volo|voli|flight|partenz|arriv|ajax|api/i.test(t)).map(t => t.slice(0, 1500)).slice(0, 6),
    links: [...new Set([...html.matchAll(/href="([^"]*(?:partenz|arriv|departur|voli|flight)[^"]*)"/gi)].map(m => m[1]))].slice(0, 15),
  };
}
