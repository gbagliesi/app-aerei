import { airportByIata } from '../js/airports.js';
// FlightAware AeroAPI (piano Personal): riserva quando AeroDataBox non risponde, e aereo in arrivo.
// La chiave sta solo nel Worker (segreto AEROAPI_KEY), mai nel browser.
//
//   GET /fa?ident=FR1234&date=YYYY-MM-DD[&inbound=1]   voli con quella sigla nel giorno (data locale di partenza)
//   GET /fa?reg=EI-ABC&date=YYYY-MM-DD                 voli di un aereo (marche) nel giorno
//   GET /fa?reg=EI-ABC&days=7                          storia dell'aereo: voli degli ultimi N giorni (max 10) e di domani
//   GET /fa?airport=PSA                                marche dei voli di un aeroporto (arrivati nelle ultime 4 ore, in arrivo e in partenza
//                                                      nelle prossime): 3 pagine, in cache mezz'ora, solo sotto il 70% del limite mensile
//   GET /fa/usage                                       richieste fatte questo mese e limite
//
// Risposta: { flights: [...], inbound?: {...}, source: 'FlightAware' } nel formato usato dall'app (come i voli
// AeroDataBox normalizzati). Ogni richiesta ad AeroAPI si paga (i primi 5 $ al mese sono gratis): le risposte restano
// in cache 10 minuti e il Worker si ferma a AEROAPI_MAX_MONTH richieste al mese (predefinito 800).

const FA_BASE = 'https://aeroapi.flightaware.com/aeroapi';
const CACHE_S = 600;
const DEFAULT_MAX = 800;

// orario UTC ISO → { utc, local: 'YYYY-MM-DD HH:MM+01:00' } nel fuso dell'aeroporto
function faTime(iso, tz) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const utc = d.toISOString().slice(0, 16) + 'Z';
  if (!tz) return { utc, local: null };
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' })
      .formatToParts(d).map(x => [x.type, x.value]));
    const off = p.timeZoneName === 'GMT' ? '+00:00' : p.timeZoneName.replace('GMT', '');
    return { utc, local: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}${off}` };
  } catch { return { utc, local: null }; }
}

function faStatus(f) {
  const s = (f.status || '').toLowerCase();
  if (f.cancelled || s.includes('cancel')) return 'Canceled';
  if (f.diverted || s.includes('divert')) return 'Diverted';
  if (f.actual_in || f.actual_on || s.startsWith('arrived') || s.startsWith('landed')) return 'Arrived';
  if (f.actual_off || s.startsWith('en route')) return 'EnRoute';
  if (f.actual_out || s.startsWith('taxiing') || s.startsWith('departed')) return 'Departed';
  if ((f.departure_delay || 0) >= 15 * 60) return 'Delayed';
  return f.scheduled_out || f.scheduled_off ? 'Expected' : 'Unknown';
}

function side(ap, sched, est, act, terminal, gate, belt) {
  const tz = ap?.timezone;
  return {
    iata: ap?.code_iata || undefined, icao: ap?.code_icao || undefined, name: ap?.name || ap?.city || undefined,
    sched: faTime(sched, tz), revised: est && est !== sched ? faTime(est, tz) : null, actual: faTime(act, tz),
    terminal: terminal || undefined, gate: gate || undefined, belt: belt || undefined,
  };
}

export function normFa(f) {
  return {
    number: (f.ident_iata || f.ident || '').replace(/\s+/g, ''),
    callSign: f.atc_ident || f.ident_icao || undefined,
    airline: { iata: f.operator_iata || undefined },
    status: faStatus(f),
    aircraft: { reg: f.registration || undefined, model: f.aircraft_type || undefined },
    codeshares: (f.codeshares_iata || []).map(c => c.replace(/\s+/g, '')),
    dep: side(f.origin, f.scheduled_out || f.scheduled_off, f.estimated_out || f.estimated_off, f.actual_off || f.actual_out, f.terminal_origin, f.gate_origin),
    arr: side(f.destination, f.scheduled_in || f.scheduled_on, f.estimated_in || f.estimated_on, f.actual_on || f.actual_in, f.terminal_destination, f.gate_destination, f.baggage_claim),
    location: null,
    faId: f.fa_flight_id, inboundFaId: f.inbound_fa_flight_id || null,
    _fa: true,
  };
}

const sameDay = (l, date) => (l.dep.sched?.local || l.dep.sched?.utc || '').slice(0, 10) === date;

async function faGet(path, env, ctx, ttl = CACHE_S, n = 1, cap = 1) {
  const key = new Request(`https://cache.local/fa${path}`);
  const hit = await caches.default.match(key);
  if (hit) return hit.json();
  // limite mensile (contatore nel Durable Object, così vale per tutte le sedi Cloudflare)
  const meter = env.WATCHER?.get(env.WATCHER.idFromName('main'));
  const max = +env.AEROAPI_MAX_MONTH || DEFAULT_MAX;
  if (meter) {
    const u = await (await meter.fetch('https://do/fa/spend', { method: 'POST', body: JSON.stringify({ max: Math.floor(max * cap), n }) })).json();
    if (!u.ok) throw Object.assign(new Error(`limite mensile FlightAware raggiunto (${u.count}/${max} richieste)`), { status: 429 });
  }
  const r = await fetch(FA_BASE + path, { headers: { 'x-apikey': env.AEROAPI_KEY, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (r.status === 404) return { flights: [] };
  if (!r.ok) {
    const t = (await r.text()).slice(0, 200);
    throw Object.assign(new Error(`FlightAware ha risposto ${r.status}${t ? `: ${t}` : ''}`), { status: r.status === 429 ? 429 : 502 });
  }
  const j = await r.json();
  ctx.waitUntil(caches.default.put(key, new Response(JSON.stringify(j), { headers: { 'Cache-Control': `max-age=${ttl}` } })));
  return j;
}

export async function handleFa(url, env, ctx, json) {
  if (!env.AEROAPI_KEY) return json({ error: 'FlightAware non configurato: manca il segreto AEROAPI_KEY nel Worker' }, 501);
  if (url.pathname === '/fa/usage') {
    const meter = env.WATCHER?.get(env.WATCHER.idFromName('main'));
    const u = meter ? await (await meter.fetch('https://do/fa/usage')).json() : {};
    return json({ ...u, max: +env.AEROAPI_MAX_MONTH || DEFAULT_MAX });
  }
  const apc = (url.searchParams.get('airport') || '').toUpperCase();
  if (apc) {
    const ap = airportByIata(apc);
    if (!ap) return json({ error: 'aeroporto sconosciuto' }, 400);
    const id = encodeURIComponent(ap.icao || apc);
    const b = Math.floor(Date.now() / 1800e3) * 1800e3, iso = t => new Date(t).toISOString().slice(0, 19) + 'Z';
    const parts = [
      ['A', `arrivals?start=${iso(b - 4 * 3600e3)}&end=${iso(b + 1800e3)}`],
      ['A', `scheduled_arrivals?start=${iso(b)}&end=${iso(b + 3 * 3600e3)}`],
      ['D', `scheduled_departures?start=${iso(b)}&end=${iso(b + 4 * 3600e3)}`],
    ];
    const flights = [];
    let err = null;
    for (const [dir, q] of parts) {
      try {
        const j = await faGet(`/airports/${id}/flights/${q}&max_pages=1`, env, ctx, 1800, 1, 0.7);
        for (const f of j[q.split('?')[0]] || []) {
          if (!f.registration) continue;
          const l = normFa(f);
          flights.push({ dir, number: l.number, codeshares: l.codeshares, reg: f.registration, sched: (dir === 'A' ? l.arr.sched : l.dep.sched)?.utc || null, other: (dir === 'A' ? l.dep.iata : l.arr.iata) || null });
        }
      } catch (e) { err = String(e.message || e); if (e.status === 429) break; }
    }
    return json({ flights, source: 'FlightAware', ...(err ? { error: err } : {}) }, flights.length || !err ? 200 : 502);
  }
  const date = url.searchParams.get('date') || '';
  const days = Math.min(10, Math.max(1, parseInt(url.searchParams.get('days') || '0', 10) || 0));
  const hreg = (url.searchParams.get('reg') || '').toUpperCase().replace(/\s+/g, '');
  if (url.searchParams.get('days') && /^[A-Z0-9-]{3,10}$/.test(hreg)) {
    // storia: una sola richiesta (fino a 3 pagine da 15 voli), in cache per un'ora arrotondando l'ora d'inizio
    const h = Math.floor(Date.now() / 3600e3) * 3600e3;
    const start = new Date(h - days * 86400e3).toISOString().slice(0, 19) + 'Z', end = new Date(h + 36 * 3600e3).toISOString().slice(0, 19) + 'Z';
    try {
      const j = await faGet(`/flights/${encodeURIComponent(hreg)}?ident_type=registration&start=${start}&end=${end}&max_pages=3`, env, ctx, 3600, 3);
      const flights = (j.flights || []).map(normFa).sort((a, b) => (b.dep.sched?.utc || '').localeCompare(a.dep.sched?.utc || ''));
      return json({ flights, source: 'FlightAware', from: start, to: end });
    } catch (e) {
      return json({ error: String(e.message || e) }, e.status || 502);
    }
  }
  const ident = (url.searchParams.get('ident') || '').toUpperCase().replace(/\s+/g, '');
  const reg = (url.searchParams.get('reg') || '').toUpperCase().replace(/\s+/g, '');
  if (!/^\d{4}-\d\d-\d\d$/.test(date)) return json({ error: 'data non valida' }, 400);
  if (ident ? !/^[A-Z0-9]{2,3}\d{1,5}[A-Z]?$/.test(ident) : !/^[A-Z0-9-]{3,10}$/.test(reg)) return json({ error: 'sigla o marche non valide' }, 400);
  // finestra larga un giorno e mezzo attorno alla data (il filtro sulla data locale si fa dopo)
  const d0 = Date.parse(`${date}T00:00:00Z`);
  const start = new Date(d0 - 14 * 3600e3).toISOString().slice(0, 19) + 'Z', end = new Date(d0 + 38 * 3600e3).toISOString().slice(0, 19) + 'Z';
  const q = `?ident_type=${ident ? 'designator' : 'registration'}&start=${start}&end=${end}&max_pages=1`;
  try {
    const j = await faGet(`/flights/${encodeURIComponent(ident || reg)}${q}`, env, ctx);
    const flights = (j.flights || []).map(normFa).filter(l => sameDay(l, date))
      .sort((a, b) => (a.dep.sched?.utc || '').localeCompare(b.dep.sched?.utc || ''));
    const out = { flights, source: 'FlightAware' };
    // aereo in arrivo: la tratta precedente indicata da FlightAware (una richiesta in più)
    const inId = ident && url.searchParams.get('inbound') && flights.find(l => l.inboundFaId)?.inboundFaId;
    if (inId) {
      const k = await faGet(`/flights/${encodeURIComponent(inId)}?ident_type=fa_flight_id`, env, ctx).catch(() => null);
      if (k?.flights?.[0]) out.inbound = normFa(k.flights[0]);
    }
    return json(out);
  } catch (e) {
    return json({ error: String(e.message || e) }, e.status || 502);
  }
}

// contatore mensile, chiamato dal Durable Object Watcher
export async function faMeter(storage, url, request) {
  const month = new Date().toISOString().slice(0, 7);
  const cur = (await storage.get('fa:usage')) || {};
  const u = cur.month === month ? cur : { month, count: 0 };
  if (url.pathname === '/fa/usage') return u;
  const body = await request.json(), { max } = body;
  const n = Math.max(1, +(body.n) || 1);
  if (u.count + n > max) return { ...u, ok: false };
  u.count += n;
  await storage.put('fa:usage', u);
  return { ...u, ok: true };
}
