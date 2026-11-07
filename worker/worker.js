// Cloudflare Worker per "Tabellone Voli": legge i tabelloni ufficiali di Pisa, Firenze, Ginevra, Fiumicino,
// Ciampino e degli aeroporti pugliesi (che il browser non può leggere direttamente) e li restituisce in un formato unico.
//
//   GET /board?airport=PSA&nature=D   (D = partenze, A = arrivi)  →  { flights: [...] }
//   GET /debug?airport=PSA&nature=D                                 →  diagnostica (URL provati, inizio risposta)
//
// Uso personale: le risposte restano in cache 90 secondi, così l'aeroporto riceve poche richieste.

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

    if (url.pathname === '/' ) return json({ ok: true, airports: [...Object.keys(TOSCANA), ...PUGLIA, ...Object.keys(ADR), 'GVA'] });
    if (!['/board', '/debug'].includes(url.pathname)) return json({ error: 'not found' }, 404);
    if (!TOSCANA[airport] && !PUGLIA.includes(airport) && !ADR[airport] && airport !== 'GVA') return json({ error: `aeroporto ${airport} non supportato` }, 400);

    const debug = url.pathname === '/debug';
    const cacheKey = new Request(`https://cache.local/board/${airport}/${nature}`);
    if (!debug) {
      const hit = await caches.default.match(cacheKey);
      if (hit) return json(await hit.json(), 200, { 'X-Cache': 'HIT' });
    }

    const log = [];
    try {
      const flights = airport === 'GVA' ? await geneva(nature, log) : ADR[airport] ? await adr(airport, nature, log) : PUGLIA.includes(airport) ? await puglia(airport, nature, log) : await toscana(airport, nature, log);
      const body = { airport, nature, fetchedAt: new Date().toISOString(), count: flights.length, flights };
      if (debug) return json({ ...body, flights: flights.slice(0, 5), log });
      if (flights.length) ctx.waitUntil(caches.default.put(cacheKey, new Response(JSON.stringify(body), { headers: { 'Cache-Control': `max-age=${CACHE_SECONDS}` } })));
      return json(body);
    } catch (e) {
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
const normNum = s => (s || '').trim().toUpperCase().replace(/\s+/g, '').replace(/^([A-Z][A-Z0-9]{1,2}?)0+(\d)/, '$1$2');

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
