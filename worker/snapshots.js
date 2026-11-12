// Copia giornaliera dei tabelloni ufficiali, tenuta nel Durable Object (istanza "snapshots").
// Molti siti degli aeroporti mostrano solo i voli di oggi (o poche ore attorno a adesso): la copia permette
// all'app di sapere quali aerei sono arrivati la sera prima e sono rimasti a terra la notte, e di ricostruire
// la giornata delle compagnie anche per i voli già spariti dal tabellone.
//
//   GET /snap?airport=PSA&nature=A&day=2026-11-10   →  { airport, nature, day, flights: [...], updatedAt }
//
// La copia si aggiorna quando il Worker legge un tabellone (al massimo ogni 15 minuti per aeroporto) e ogni
// ora con un controllo pianificato (cron) per gli aeroporti consultati negli ultimi 3 giorni.
// Si tengono 4 giorni.

const KEEP_DAYS = 4;
const THROTTLE_S = 900;
const MAX_CRON_AIRPORTS = 15;
const FIELDS = ['number', 'airline', 'schedDate', 'sched', 'est', 'estAt', 'actual', 'actualAt', 'status', 'statusCode', 'city', 'cityCode', 'reg', 'type', 'codeshare', 'terminal'];

const slim = f => Object.fromEntries(FIELDS.filter(k => f[k] != null && f[k] !== '').map(k => [k, f[k]]));
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);

const stub = env => env.WATCHER.get(env.WATCHER.idFromName('snapshots'));

/** Salva (in sottofondo) il tabellone appena letto; force = senza il limite dei 15 minuti. */
export async function saveSnap(env, airport, nature, flights, force = false) {
  if (!env.WATCHER || !flights?.length) return;
  const mark = new Request(`https://cache.local/snapmark/${airport}/${nature}`);
  if (!force && await caches.default.match(mark)) return;
  await stub(env).fetch('https://do/snap/put', { method: 'POST', body: JSON.stringify({ airport, nature, cron: force, flights: flights.map(slim) }) });
  await caches.default.put(mark, new Response('1', { headers: { 'Cache-Control': `max-age=${THROTTLE_S}` } }));
}

/** GET /snap dal Worker. */
export async function handleSnap(url, env, json) {
  if (!env.WATCHER) return json({ error: 'copie non configurate nel Worker (manca il Durable Object WATCHER)' }, 501);
  const airport = (url.searchParams.get('airport') || '').toUpperCase(), nature = url.searchParams.get('nature') === 'A' ? 'A' : 'D';
  const day = url.searchParams.get('day') || '';
  if (!/^[A-Z]{3}$/.test(airport) || !/^\d{4}-\d\d-\d\d$/.test(day)) return json({ error: 'parametri non validi (airport, nature, day=YYYY-MM-DD)' }, 400);
  const r = await stub(env).fetch(`https://do/snap/get?airport=${airport}&nature=${nature}&day=${day}`);
  return json(await r.json(), r.status, { 'Cache-Control': 'max-age=300' });
}

/** Controllo pianificato: rilegge i tabelloni degli aeroporti consultati di recente e aggiorna la copia. */
export async function cronSnap(env, readBoard) {
  if (!env.WATCHER) return;
  const r = await stub(env).fetch('https://do/snap/airports');
  const { airports = [] } = await r.json();
  for (const a of airports.slice(0, MAX_CRON_AIRPORTS)) {
    for (const n of ['D', 'A']) {
      try { await saveSnap(env, a, n, await readBoard(a, n, env), true); } catch { /* sito non raggiungibile: riprovo al prossimo giro */ }
    }
  }
}

/** Copia di un elenco fisso di aeroporti (quelli che pubblicano le marche), anche se nessuno li consulta. */
export async function cronList(env, readBoard, list) {
  if (!env.WATCHER) return;
  for (const a of list) {
    for (const n of ['D', 'A']) {
      try { await saveSnap(env, a, n, await readBoard(a, n, env), true); } catch { /* riprovo al prossimo giro */ }
    }
  }
}

/** Parte eseguita dentro il Durable Object (storage = this.storage). */
export async function snapDo(storage, url, request) {
  const now = Date.now();
  if (url.pathname === '/snap/put' && request.method === 'POST') {
    const { airport, nature, flights, cron } = await request.json();
    if (!/^[A-Z]{3}$/.test(airport || '') || !Array.isArray(flights)) return { error: 'dati non validi' };
    const byDay = new Map();
    for (const f of flights) {
      const d = (f.schedDate || '').slice(0, 10);
      if (!/^\d{4}-\d\d-\d\d$/.test(d)) continue;
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(f);
    }
    const oldest = dayOf(now - KEEP_DAYS * 86400e3), newest = dayOf(now + 2 * 86400e3);
    for (const [d, list] of byDay) {
      if (d < oldest || d > newest) continue;
      const key = `snap:${airport}:${nature}:${d}`;
      const cur = (await storage.get(key))?.flights || {};
      for (const f of list) {
        const k = `${f.number}|${f.schedDate}`;
        cur[k] = { ...cur[k], ...f, reg: f.reg || cur[k]?.reg, type: f.type || cur[k]?.type };
      }
      await storage.put(key, { flights: cur, updatedAt: new Date(now).toISOString() });
    }
    if (!cron) await storage.put(`seen:${airport}`, now); // solo le consultazioni vere tengono l'aeroporto nel controllo orario
    // pulizia dei giorni vecchi (una volta al giorno per aeroporto)
    const cleanKey = `clean:${airport}`;
    if ((await storage.get(cleanKey)) !== dayOf(now)) {
      const old = [...(await storage.list({ prefix: `snap:${airport}:` })).keys()].filter(k => k.slice(-10) < oldest);
      if (old.length) await storage.delete(old);
      await storage.put(cleanKey, dayOf(now));
    }
    return { ok: true, days: [...byDay.keys()] };
  }
  if (url.pathname === '/snap/get') {
    const airport = url.searchParams.get('airport'), nature = url.searchParams.get('nature'), day = url.searchParams.get('day');
    const v = await storage.get(`snap:${airport}:${nature}:${day}`);
    return { airport, nature, day, flights: v ? Object.values(v.flights).sort((a, b) => (a.schedDate < b.schedDate ? -1 : 1)) : [], updatedAt: v?.updatedAt || null };
  }
  if (url.pathname === '/snap/airports') {
    const seen = await storage.list({ prefix: 'seen:' });
    const airports = [...seen].filter(([, t]) => now - t < 3 * 86400e3).sort((a, b) => b[1] - a[1]).map(([k]) => k.slice(5));
    return { airports };
  }
  return { error: 'not found' };
}
