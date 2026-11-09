// Cloudflare Worker per "Tabellone Voli": legge i tabelloni ufficiali di Pisa, Firenze, Ginevra, Fiumicino,
// Ciampino, degli aeroporti pugliesi, di Milano (MXP, LIN), Bologna, Catania, Palermo, Zurigo, Francoforte e Monaco
// (che il browser non può leggere direttamente) e li restituisce in un formato unico.
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
// Altri aeroporti: funzione che legge il tabellone (definite più sotto)
const OTHER = {
  MXP: (n, log, env) => sea('mxp', n, log, env), LIN: (n, log, env) => sea('lin', n, log, env),
  ZRH: zurich, FRA: frankfurt, CTA: catania, MUC: munich, PMO: palermo, BLQ: bologna,
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

    if (url.pathname === '/' ) return json({ ok: true, airports: [...Object.keys(TOSCANA), ...PUGLIA, ...Object.keys(ADR), 'GVA', ...Object.keys(OTHER)] });
    if (!['/board', '/debug'].includes(url.pathname)) return json({ error: 'not found' }, 404);
    if (!TOSCANA[airport] && !PUGLIA.includes(airport) && !ADR[airport] && !OTHER[airport] && airport !== 'GVA') return json({ error: `aeroporto ${airport} non supportato` }, 400);

    const debug = url.pathname === '/debug';
    const cacheKey = new Request(`https://cache.local/board/${airport}/${nature}`);
    if (!debug) {
      const hit = await caches.default.match(cacheKey);
      if (hit) return json(await hit.json(), 200, { 'X-Cache': 'HIT' });
    }

    const log = [];
    try {
      const flights = OTHER[airport] ? await OTHER[airport](nature, log, env) : airport === 'GVA' ? await geneva(nature, log) : ADR[airport] ? await adr(airport, nature, log) : PUGLIA.includes(airport) ? await puglia(airport, nature, log) : await toscana(airport, nature, log);
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
const trimOrNull = v => { const t = (v == null ? '' : String(v)).trim(); return t && t !== '--' ? t : null; };
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
  const map = [
    [/annul|cancel/, 'Cancellato'], [/umgeleitet|divert/, 'Dirottato'],
    [/gelandet|landed|auf position|gepäck|baggage|arrived/, 'Atterrato'],
    [/anflug|approach/, 'In arrivo'],
    [/gestartet|departed|airborne|en route|unterwegs/, nature === 'A' ? 'In volo' : 'Decollato'],
    [/rolling|rollt/, 'In rullaggio'],
    [/letzter aufruf|last call|final call/, 'Ultima chiamata'],
    [/boarding|einsteigen/, 'Imbarco'],
    [/gate geschlossen|closed|geschlossen/, 'Gate chiuso'],
    [/gate offen|gate open/, 'Gate aperto'],
    [/zum gate|go to gate/, 'Al gate'],
    [/verspät|delay/, 'Ritardato'],
    [/check-?in/, 'Check-in'],
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
    const r = await fetch(u, { signal: AbortSignal.timeout(15000), headers: { 'keyId': key, 'Accept': 'application/json', 'User-Agent': UA } });
    const t = await r.text();
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
async function catania(nature, log) {
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
        body: JSON.stringify({ query: CTA_QUERY, variables: { offset: 0, size: 200, airport: 'CTA', date: day, locale: 'IT', type: A ? 'ARRIVALS' : 'DEPARTURES', timeRange: '00:00 - 23:59', keyword: '' } }),
      });
      const t = await r.text();
      log.push({ url: u, day, status: r.status, length: t.length, ms: Date.now() - t0, start: t.slice(0, 200) });
      if (!r.ok) { if (day === 'TODAY') throw new Error(`Catania: errore ${r.status}`); continue; }
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
