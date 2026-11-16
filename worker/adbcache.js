// Cache condivisa delle risposte AeroDataBox: l'app (telefono, Mac, …) e le notifiche chiedono ad AeroDataBox
// passando dal Worker, che tiene le risposte nella cache di Cloudflare. Così la stessa richiesta fatta da due
// dispositivi, o dall'app e dalle notifiche, consuma le unità del piano una volta sola.
//
//   GET /adb?path=/flights/...&ttl=900   intestazione X-ADB-Key: chiave RapidAPI
//     → la risposta di AeroDataBox così com'è (stesso stato e corpo), con X-Fetched-At (ms) e X-Cache: HIT|MISS
//
// La chiave non viene salvata: la cache è separata per chiave (impronta SHA-256), quindi chi non ha la chiave
// giusta non legge i dati in cache. Si tengono solo le risposte riuscite (200 e 204). La cache di Cloudflare è
// per data center: dispositivi nella stessa zona la condividono.

const ADB_HOST = 'aerodatabox.p.rapidapi.com';
const ALLOWED = /^\/(flights|airports|aircrafts)\//;

async function keyHash(key) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return [...new Uint8Array(d)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Una richiesta ad AeroDataBox passando dalla cache. Restituisce { status, body, at, hit }. */
export async function adbFetch(key, path, ttl, ctx) {
  ttl = Math.max(60, Math.min(30 * 86400, Math.round(+ttl || 300)));
  const ck = new Request(`https://cache.local/adb/${await keyHash(key)}${path}`);
  const hit = await caches.default.match(ck);
  if (hit) {
    const at = +hit.headers.get('X-Fetched-At') || 0;
    // la cache può tenere la risposta più a lungo del ttl chiesto ora (un'altra richiesta l'ha salvata con un ttl più lungo)
    if (Date.now() - at < ttl * 1000) return { status: hit.status, body: await hit.text(), at, hit: true };
  }
  const r = await fetch(`https://${ADB_HOST}${path}`, { headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': ADB_HOST }, signal: AbortSignal.timeout(20000) });
  const body = await r.text();
  const at = Date.now();
  if (r.status === 200 || r.status === 204) {
    const put = caches.default.put(ck, new Response(r.status === 204 ? null : body, { status: r.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}`, 'X-Fetched-At': String(at) } }));
    if (ctx) ctx.waitUntil(put); else await put;
  }
  return { status: r.status, body, at, hit: false };
}

/** GET /adb dal Worker. */
export async function handleAdb(request, url, ctx, cors) {
  const key = (request.headers.get('X-ADB-Key') || '').trim();
  const path = url.searchParams.get('path') || '';
  const out = (status, body, extra = {}) => new Response(status === 204 ? null : body, { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors, 'Access-Control-Expose-Headers': 'X-Fetched-At, X-Cache', ...extra } });
  if (!key) return out(400, JSON.stringify({ message: 'manca la chiave AeroDataBox (intestazione X-ADB-Key)' }));
  if (!ALLOWED.test(path) || path.length > 400) return out(400, JSON.stringify({ message: 'percorso AeroDataBox non ammesso' }));
  try {
    const r = await adbFetch(key, path, url.searchParams.get('ttl'), ctx);
    return out(r.status, r.body, { 'X-Fetched-At': String(r.at), 'X-Cache': r.hit ? 'HIT' : 'MISS' });
  } catch (e) {
    return out(504, JSON.stringify({ message: `AeroDataBox non risponde (${e.message || e})` }));
  }
}
