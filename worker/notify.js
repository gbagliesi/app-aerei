// Notifiche sui voli seguiti: Durable Object "Watcher" (uno solo, "main") che conserva gli iscritti Web Push e i voli
// da seguire, li controlla ogni 2 minuti con un alarm (solo quando c'è qualcosa da seguire) e manda le notifiche.
//
//   GET  /push/key                      → { key }  chiave pubblica VAPID (creata dal Worker al primo uso)
//   POST /push/watch   { sub, flight, events, adbKey? } → { id, push }   segue un volo (manda subito una notifica di conferma)
//   POST /push/unwatch { endpoint, id } → { ok }
//   POST /push/list    { endpoint }     → { watches: [...] }
//   POST /push/test    { endpoint }     → { push }
//
// Fonti: prima i tabelloni ufficiali degli aeroporti (gratis, letti dal Worker stesso); AeroDataBox solo per ciò che
// i tabelloni non coprono, con al massimo ADB_MAX chiamate per volo, per non consumare il piano mensile.

const TICK_MS = 2 * 60e3;          // controllo ogni 2 minuti
const ADB_EVERY_MS = 8 * 60e3;     // AeroDataBox al più ogni 8 minuti per volo...
const ADB_MAX = 30;                // ...e al massimo 30 chiamate per volo (volo + volo precedente)
const MAX_WATCHES = 40;            // voli seguiti in totale
const PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com', 'web.push.apple.com', 'notify.windows.com', 'push.apple.com'];
export const EVENTS = ['inboundDep', 'inbound', 'gate', 'boarding', 'delay', 'departed', 'landed', 'belt', 'cancel'];
const ADB_HOST = 'aerodatabox.p.rapidapi.com';
// lettura diretta dei tabelloni, se manca il collegamento SELF al Worker stesso (impostata da worker.js)
let boardFn = null;
export const setBoardFn = f => { boardFn = f; };

// ---------- utilità base64url e crittografia (Web Push, RFC 8291 + VAPID RFC 8292) ----------
const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const concat = (...a) => { const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of a) { out.set(x, o); o += x.length; } return out; };
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}

/** Cifra il contenuto per un iscritto (aes128gcm). */
export async function encryptPayload(sub, payload) {
  const uaPublic = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(enc.encode(payload), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 0x10, 0]); // 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

/** Intestazione Authorization VAPID per l'endpoint. */
export async function vapidAuth(endpoint, vapid) {
  const aud = new URL(endpoint).origin;
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://gbagliesi.github.io/app-aerei/' })));
  const key = await crypto.subtle.importKey('jwk', vapid.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${body}`));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${vapid.publicKey}`;
}

export async function makeVapid() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { publicKey: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), privateJwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
}

// ---------- stati dei tabelloni (come nell'app) ----------
function mapStatus(t) {
  t = (t || '').toLowerCase();
  if (!t) return null;
  if (/cancel|annul|soppress/.test(t)) return 'Canceled';
  if (/dirott|divert|dérout/.test(t)) return 'Diverted';
  if (/atterr|landed|arrived|arrivato|atterri/.test(t)) return 'Arrived';
  if (/in arrivo|avvicin|approach/.test(t)) return 'Approaching';
  if (/in volo|en ?route|airborne|flying|en vol/.test(t)) return 'EnRoute';
  if (/decoll|partito|departed|parti|take ?off/.test(t)) return 'Departed';
  if (/chius|closed|fermé|ferme/.test(t)) return 'GateClosed';
  if (/imbarco|boarding|embarq|ultima chiamata|gate aperto|last call/.test(t)) return 'Boarding';
  if (/ritard|delay|retard/.test(t)) return 'Delayed';
  if (/check/.test(t)) return 'CheckIn';
  return null;
}
const AIRBORNE = ['Departed', 'EnRoute', 'Approaching', 'Arrived', 'Diverted'];
const hm = s => { const m = /(\d{1,2}):(\d{2})/.exec(s || ''); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null; };
const minOf = s => { const m = hm(s); return m ? +m.slice(0, 2) * 60 + +m.slice(3) : null; };
const diffMin = (a, b) => { const x = minOf(a), y = minOf(b); return x == null || y == null ? null : ((x - y + 1440 + 720) % 1440) - 720; };
// "YYYY-MM-DD HH:MM..." o "YYYY-MM-DDTHH:MM" → minuti dall'epoca, letti come UTC (solo per confronti nello stesso fuso)
const localMs = s => { const m = /^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d)/.exec(s || ''); return m ? Date.parse(`${m[1]}T${m[2]}:00Z`) : null; };
const utcOf = s => { const t = Date.parse((s || '').replace(' ', 'T')); return isNaN(t) ? null : t; };

/** Riga del tabellone per il volo: stesso numero (o code sharing) e orario programmato più vicino (entro 12 ore). */
function findRow(rows, number, schedLocal) {
  const target = localMs(schedLocal);
  let best = null, bestD = Infinity;
  for (const r of rows || []) {
    if (r.number !== number && !(r.codeshare || []).includes(number)) continue;
    const d = target == null ? 0 : Math.abs((localMs(r.schedDate) ?? target) - target);
    if (d < bestD) { best = r; bestD = d; }
  }
  return bestD <= 12 * 3600e3 ? best : null;
}
// Riga del tabellone → dati del lato (partenza o arrivo)
function fromRow(r, src, nature) {
  if (!r) return null;
  const est = hm(r.estAt) || hm(r.est), actual = hm(r.actualAt) || hm(r.actual), sched = hm(r.schedDate);
  let status = mapStatus(r.status);
  if (nature === 'A' && actual && status !== 'Canceled') status = 'Arrived';
  return { gate: r.gate || null, belt: r.belt || null, status, sched, est, actual, delay: est && sched ? diffMin(est, sched) : null, src };
}
// Tratta AeroDataBox → dati dei due lati
function fromAdb(leg) {
  if (!leg) return null;
  const side = (m, nature) => {
    if (!m) return null;
    const sched = hm(m.scheduledTime?.local?.slice(11)), rev = m.revisedTime || m.predictedTime;
    const est = rev ? hm(rev.local?.slice(11)) : null, actual = m.runwayTime ? hm(m.runwayTime.local?.slice(11)) : null;
    const delay = rev && m.scheduledTime ? Math.round((utcOf(rev.utc) - utcOf(m.scheduledTime.utc)) / 60e3) : null;
    return { gate: m.gate || null, belt: m.baggageBelt || null, sched, est, actual, delay, src: 'AeroDataBox', nature };
  };
  const st = leg.status || null;
  const dep = side(leg.departure, 'D'), arr = side(leg.arrival, 'A');
  if (dep) dep.status = st === 'Arrived' || st === 'Approaching' ? 'EnRoute' : st;
  if (arr) arr.status = st === 'Arrived' || (arr.actual && st !== 'Canceled') ? 'Arrived' : st;
  return { dep, arr };
}
// Completa i dati ufficiali con quelli di AeroDataBox (l'ufficiale ha la priorità)
function merge(off, adb) {
  if (!off) return adb || null;
  if (!adb) return off;
  const out = { ...off };
  for (const k of ['gate', 'belt', 'est', 'actual', 'delay', 'sched']) if (out[k] == null && adb[k] != null) out[k] = adb[k];
  if (!out.status && adb.status) out.status = adb.status;
  if (out.src !== adb.src && Object.keys(out).some(k => out[k] != null && off[k] == null)) out.src = `${off.src} + AeroDataBox`;
  return out;
}

// ---------- il Durable Object ----------
export class Watcher {
  constructor(state, env) { this.state = state; this.storage = state.storage; this.env = env; }

  async vapid() {
    let v = await this.storage.get('vapid');
    if (!v) { v = await makeVapid(); await this.storage.put('vapid', v); }
    return v;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    try {
      if (url.pathname === '/push/key') return json({ key: (await this.vapid()).publicKey });
      if (request.method !== 'POST') return json({ error: 'usa POST' }, 405);
      const b = await request.json();
      const subId = await this.subIdOf(b.sub?.endpoint || b.endpoint);
      if (!subId) return json({ error: 'iscrizione push non valida' }, 400);

      const sub = b.sub;
      if (sub && (!PUSH_HOSTS.some(h => new URL(sub.endpoint).hostname === h || new URL(sub.endpoint).hostname.endsWith('.' + h)) || !sub.keys?.p256dh || !sub.keys?.auth)) return json({ error: 'servizio push non riconosciuto' }, 400);
      if (url.pathname === '/push/watch') {
        if (!sub) return json({ error: 'manca l’iscrizione push' }, 400);
        const f = b.flight || {};
        if (!/^[A-Z0-9]{2,3}\d{1,5}[A-Z]?$/.test(f.number || '') || !/^\d{4}-\d\d-\d\d$/.test(f.date || '') || !f.dep) return json({ error: 'volo non valido' }, 400);
        const old = await this.storage.get(`sub:${subId}`);
        await this.storage.put(`sub:${subId}`, { sub, adbKey: (b.adbKey || '').trim() || old?.adbKey || null, at: Date.now() });
        const id = `${subId}:${f.number}:${f.date}:${f.dep}`;
        const prev = await this.storage.get(`watch:${id}`);
        if (!prev && (await this.storage.list({ prefix: 'watch:' })).size >= MAX_WATCHES) return json({ error: `al massimo ${MAX_WATCHES} voli seguiti` }, 400);
        const events = (b.events || []).filter(e => EVENTS.includes(e));
        const s = v => (typeof v === 'string' ? v.slice(0, 40) : null);
        const w = {
          ...(prev || { state: {}, log: [], adbCalls: 0, created: Date.now() }), id, subId, events,
          number: f.number, date: f.date, dep: f.dep, arr: f.arr || null, depSched: s(f.depSched), arrSched: s(f.arrSched), depLocal: s(f.depLocal), arrLocal: s(f.arrLocal),
          offDep: !!f.offDep, offArr: !!f.offArr,
          inbound: f.inbound?.number ? { number: f.inbound.number, dep: f.inbound.dep || null, date: f.inbound.date || f.date, depSched: s(f.inbound.depSched), arrSched: s(f.inbound.arrSched), depLocal: s(f.inbound.depLocal), arrLocal: s(f.inbound.arrLocal), offDep: !!f.inbound.offDep, guess: !!f.inbound.guess } : null,
        };
        // stato attuale visto dall'app: è il punto di partenza (si notificano solo i cambiamenti successivi)
        if (!prev && f.known && typeof f.known === 'object') {
          const k = f.known, str = v => (typeof v === 'string' && v ? v.slice(0, 12) : undefined);
          Object.assign(w.state, { base: true, gate: str(k.gate), belt: str(k.belt), boarding: !!k.boarding, departed: !!k.departed, inboundLanded: !!k.inboundLanded, inboundDeparted: !!k.inboundDeparted,
            depDelay: Number.isFinite(k.depDelay) ? k.depDelay : undefined, landedAt: k.landed ? Date.now() : undefined, canceled: !!k.canceled || undefined, canceledAt: k.canceled ? Date.now() : undefined });
        }
        // il volo precedente è cambiato (es. stima per le low cost): riparto dai suoi stati
        if (prev && prev.inbound?.number !== w.inbound?.number) { delete w.state.inboundLanded; delete w.state.inboundDeparted; w.state.base = false; }
        await this.storage.put(`watch:${id}`, w);
        let push = null;
        if (!prev) push = await this.send(subId, { title: `🔔 ${f.number}: notifiche attive`, body: `${f.dep}→${f.arr || '?'} del ${f.date.slice(8)}/${f.date.slice(5, 7)}. Ti avviso per: ${events.map(e => LABELS[e]).join(', ') || 'nessun evento'}.`, tag: `${id}:on`, url: flightUrl(w) });
        await this.schedule(Date.now() + 5e3);
        return json({ id, push, updated: !!prev });
      }
      if (url.pathname === '/push/unwatch') {
        const id = String(b.id || '');
        if (!id.startsWith(`${subId}:`)) return json({ error: 'non tuo' }, 403);
        await this.storage.delete(`watch:${id}`);
        return json({ ok: true });
      }
      if (url.pathname === '/push/list') {
        const all = await this.storage.list({ prefix: `watch:${subId}:` });
        return json({ watches: [...all.values()].map(w => ({ id: w.id, number: w.number, date: w.date, dep: w.dep, arr: w.arr, events: w.events, log: w.log, lastCheck: w.lastCheck, adbCalls: w.adbCalls, inbound: w.inbound?.number || null })) });
      }
      if (url.pathname === '/push/test') {
        if (sub) { const old = await this.storage.get(`sub:${subId}`); await this.storage.put(`sub:${subId}`, { sub, adbKey: old?.adbKey || null, at: Date.now() }); }
        return json({ push: await this.send(subId, { title: '🔔 Prova notifiche', body: 'Le notifiche dei voli funzionano su questo dispositivo.', tag: 'test', url: './#/settings' }) });
      }
      return json({ error: 'not found' }, 404);
    } catch (e) { return json({ error: String(e.message || e) }, 500); }
  }

  async subIdOf(endpoint) {
    if (typeof endpoint !== 'string' || !endpoint.startsWith('https://')) return null;
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(endpoint)));
    return [...h.slice(0, 8)].map(x => x.toString(16).padStart(2, '0')).join('');
  }

  async schedule(at) {
    const cur = await this.storage.getAlarm();
    if (cur == null || cur > at || cur < Date.now() - 60e3) await this.storage.setAlarm(at);
  }

  /** Manda una notifica a un iscritto. Restituisce lo stato HTTP del servizio push. */
  async send(subId, msg) {
    const rec = await this.storage.get(`sub:${subId}`);
    if (!rec) return { ok: false, error: 'iscritto sconosciuto' };
    const vapid = await this.vapid();
    try {
      const body = await encryptPayload(rec.sub, JSON.stringify(msg));
      const r = await fetch(rec.sub.endpoint, { method: 'POST', body, headers: {
        Authorization: await vapidAuth(rec.sub.endpoint, vapid), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Urgency: 'high' } });
      if (r.status === 404 || r.status === 410) { // iscrizione scaduta: tolgo l'iscritto e i suoi voli
        await this.storage.delete(`sub:${subId}`);
        const ws = await this.storage.list({ prefix: `watch:${subId}:` });
        await this.storage.delete([...ws.keys()]);
      }
      return { ok: r.ok, status: r.status, error: r.ok ? undefined : (await r.text()).slice(0, 200) };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  }

  async alarm() {
    const now = Date.now();
    const all = await this.storage.list({ prefix: 'watch:' });
    const boards = new Map(), adbCache = new Map();
    let next = Infinity;
    for (const w of all.values()) {
      try {
        const n = await this.check(w, now, boards, adbCache);
        if (n == null) await this.storage.delete(`watch:${w.id}`);
        else { await this.storage.put(`watch:${w.id}`, w); next = Math.min(next, n); }
      } catch (e) { w.lastError = String(e.message || e); await this.storage.put(`watch:${w.id}`, w); next = Math.min(next, now + TICK_MS); }
    }
    if (next < Infinity) await this.storage.setAlarm(Math.max(next, now + 30e3));
  }

  async board(airport, nature, boards) {
    const k = `${airport}:${nature}`;
    if (!boards.has(k)) boards.set(k, (async () => {
      try {
        const u = `https://self/board?airport=${airport}&nature=${nature}`;
        if (!this.env.SELF) return boardFn ? await boardFn(airport, nature, this.env) : null;
        const r = await this.env.SELF.fetch(u);
        if (!r.ok) return null;
        return (await r.json()).flights || null;
      } catch { return null; }
    })());
    return boards.get(k);
  }

  async adb(w, number, date, adbCache) {
    const key = this.env.ADB_KEY || (await this.storage.get(`sub:${w.subId}`))?.adbKey;
    if (!key || w.adbCalls >= ADB_MAX) return null;
    const k = `${number}:${date}`;
    if (!adbCache.has(k)) adbCache.set(k, (async () => {
      w.adbCalls++;
      const r = await fetch(`https://${ADB_HOST}/flights/number/${encodeURIComponent(number)}/${date}?withAircraftImage=false&withLocation=false`, { headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': ADB_HOST }, signal: AbortSignal.timeout(15000) });
      if (r.status === 204) return [];
      if (!r.ok) { w.lastError = `AeroDataBox ${r.status}`; if (r.status === 429 || r.status === 403) w.adbCalls = ADB_MAX; return null; }
      return r.json();
    })().catch(() => null));
    return adbCache.get(k);
  }

  /** Controlla un volo; restituisce quando ricontrollarlo (null = finito, da togliere). */
  async check(w, now, boards, adbCache) {
    const depT = utcOf(w.depSched) ?? Date.parse(`${w.date}T12:00:00Z`);
    const arrT = utcOf(w.arrSched) ?? depT + 3 * 3600e3;
    const st = w.state;
    // fine: 3 ore dopo l'arrivo previsto (o atterrato da 45 min, o cancellato), oppure 2 giorni dopo la data
    if (now > arrT + 3 * 3600e3 + Math.max(0, (st.depDelay || 0)) * 60e3 || (st.landedAt && now > st.landedAt + 45 * 60e3) || (st.canceled && now > (st.canceledAt || 0) + 3600e3) || now > Date.parse(`${w.date}T00:00:00Z`) + 3 * 86400e3) return null;
    const start = Math.min(depT - 4 * 3600e3, utcOf(w.inbound?.depSched) ?? Infinity) - 30 * 60e3;
    if (now < start) return start;
    const want = e => w.events.includes(e);
    w.lastCheck = now;

    // 1) tabelloni ufficiali
    let dep = null, arr = null, inArr = null, inDep = null;
    const needInbound = w.inbound && ((want('inbound') && !st.inboundLanded) || (want('inboundDep') && !st.inboundDeparted));
    if (w.offDep) dep = fromRow(findRow(await this.board(w.dep, 'D', boards), w.number, w.depLocal), `tabellone ${w.dep}`, 'D');
    if (w.offArr && w.arr && now > depT - 90 * 60e3) arr = fromRow(findRow(await this.board(w.arr, 'A', boards), w.number, w.arrLocal), `tabellone ${w.arr}`, 'A');
    if (needInbound && w.offDep) inArr = fromRow(findRow(await this.board(w.dep, 'A', boards), w.inbound.number, w.inbound.arrLocal), `tabellone ${w.dep}`, 'A');
    if (needInbound && want('inboundDep') && !st.inboundDeparted && w.inbound.offDep && w.inbound.dep) inDep = fromRow(findRow(await this.board(w.inbound.dep, 'D', boards), w.inbound.number, w.inbound.depLocal), `tabellone ${w.inbound.dep}`, 'D');

    // 2) AeroDataBox solo per quello che manca, vicino agli orari che contano
    const pendDep = ['gate', 'boarding', 'delay', 'departed', 'cancel'].some(e => want(e)) && !st.departed && !st.canceled;
    const pendArr = (want('landed') && !st.landedAt) || (want('belt') && !st.belt);
    const lastAdb = w.lastAdb || 0;
    const adbDue = now - lastAdb >= ADB_EVERY_MS;
    const near = (t, before, after) => t != null && now > t - before && now < t + after;
    const flightNeedsAdb = adbDue && ((pendDep && !dep && near(depT, 90 * 60e3, 60 * 60e3 + (st.depDelay || 0) * 60e3)) ||
      (pendArr && !arr && near(arrT + (st.depDelay || 0) * 60e3, 30 * 60e3, 90 * 60e3)));
    const inT = utcOf(w.inbound?.arrSched);
    const inboundNeedsAdb = adbDue && needInbound && ((want('inbound') && !st.inboundLanded && !inArr && near(inT, 45 * 60e3, 90 * 60e3)) ||
      (want('inboundDep') && !st.inboundDeparted && !inDep && near(utcOf(w.inbound.depSched), 30 * 60e3, 90 * 60e3)));
    if (flightNeedsAdb) {
      const legs = await this.adb(w, w.number, w.date, adbCache);
      const leg = (legs || []).find(l => l.departure?.airport?.iata === w.dep) || (legs?.length === 1 ? legs[0] : null);
      const a = fromAdb(leg);
      if (a) { dep = merge(dep, a.dep); arr = merge(arr, a.arr); }
      w.lastAdb = now;
    }
    if (inboundNeedsAdb) {
      const legs = await this.adb(w, w.inbound.number, w.inbound.date, adbCache);
      const leg = (legs || []).find(l => l.arrival?.airport?.iata === w.dep);
      const a = fromAdb(leg);
      if (a) { inArr = merge(inArr, a.arr); inDep = merge(inDep, a.dep); }
      w.lastAdb = now;
    }

    // 3) eventi: alla prima lettura registro lo stato senza notificare (quello che c'è già lo vedi nell'app)
    const silent = !st.base;
    const out = [];
    const note = (ev, title, body, src) => { if (!silent && want(ev)) out.push({ ev, title: `${w.number} · ${title}`, body: `${body}${src ? ` (fonte: ${src})` : ''}` }); };
    const route = `${w.dep}→${w.arr || '?'}`;
    if (inDep && !st.inboundDeparted && (inDep.actual || AIRBORNE.includes(inDep.status))) {
      st.inboundDeparted = true;
      note('inboundDep', `decollato l'aereo in arrivo`, `${w.inbound.guess ? 'Il probabile volo precedente' : 'Il volo precedente'} ${w.inbound.number} è decollato da ${w.inbound.dep}${inDep.actual ? ` alle ${inDep.actual}` : ''}.`, inDep.src);
    }
    if (inArr && !st.inboundLanded && (inArr.actual || inArr.status === 'Arrived')) {
      st.inboundLanded = true;
      note('inbound', `atterrato l'aereo in arrivo`, `${w.inbound.guess ? 'Il probabile volo precedente' : 'Il volo precedente'} ${w.inbound.number} è atterrato a ${w.dep}${inArr.actual ? ` alle ${inArr.actual}` : ''}. Partenza ${dep?.est && dep.est !== dep.sched ? `stimata ${dep.est}` : `prevista ${dep?.sched || hm(w.depLocal?.slice(11)) || ''}`}.`, inArr.src);
    }
    if (dep) {
      if (dep.status === 'Canceled' || arr?.status === 'Canceled') {
        if (!st.canceled) { st.canceled = true; st.canceledAt = now; note('cancel', 'volo cancellato', `Il volo ${route} risulta cancellato.`, dep.src); }
      }
      if (dep.gate && dep.gate !== st.gate) {
        if (st.gate) note('gate', `cambio gate: ${dep.gate}`, `Il gate è cambiato da ${st.gate} a ${dep.gate}.`, dep.src);
        else note('gate', `gate ${dep.gate}`, `Gate assegnato: ${dep.gate}${dep.est || dep.sched ? `, partenza ${dep.est || dep.sched}` : ''}.`, dep.src);
        st.gate = dep.gate;
      }
      if (!st.boarding && ['Boarding', 'GateClosed'].includes(dep.status)) {
        st.boarding = true;
        note('boarding', dep.status === 'Boarding' ? 'imbarco iniziato' : 'gate chiuso', `${dep.status === 'Boarding' ? 'Imbarco in corso' : 'Imbarco concluso, gate chiuso'}${dep.gate || st.gate ? ` al gate ${dep.gate || st.gate}` : ''}.`, dep.src);
      }
      if (dep.delay != null && !st.departed) {
        const last = st.depDelay ?? 0;
        if (Math.abs(dep.delay - last) >= 10 && (dep.delay >= 15 || last >= 15)) note('delay', dep.delay >= 15 ? `ritardo ${dep.delay} min` : 'di nuovo in orario', `Partenza stimata alle ${dep.est} (prevista ${dep.sched}).`, dep.src);
        if (Math.abs(dep.delay - last) >= 10 || st.depDelay == null) st.depDelay = dep.delay;
      }
      if (!st.departed && (dep.actual || AIRBORNE.includes(dep.status) || arr?.actual)) {
        st.departed = true;
        if (!(arr?.actual || arr?.status === 'Arrived')) note('departed', 'decollato', `Partito da ${w.dep}${dep.actual ? ` alle ${dep.actual}` : ''}${arr?.est ? `, arrivo stimato a ${w.arr} alle ${arr.est}` : ''}.`, dep.src);
      }
    }
    if (arr) {
      if (arr.status === 'Diverted' && !st.diverted) { st.diverted = true; note('cancel', 'volo dirottato', `Il volo non atterra a ${w.arr}: dirottato.`, arr.src); }
      if (!st.landedAt && (arr.actual || arr.status === 'Arrived')) {
        st.landedAt = now; st.departed = true;
        note('landed', `atterrato a ${w.arr}`, `Atterrato${arr.actual ? ` alle ${arr.actual}` : ''}${arr.belt ? `, bagagli al nastro ${arr.belt}` : ''}.`, arr.src);
        if (arr.belt) st.belt = arr.belt;
      }
      if (arr.belt && arr.belt !== st.belt) {
        if (!(st.landedAt === now && want('landed'))) note('belt', `nastro bagagli ${arr.belt}`, `Bagagli a ${w.arr} al nastro ${arr.belt}.`, arr.src);
        st.belt = arr.belt;
      }
    }
    if (dep || arr || inArr || inDep) st.base = true;
    for (const m of out.slice(0, 4)) {
      const r = await this.send(w.subId, { title: m.title, body: m.body, tag: `${w.id}:${m.ev}`, url: flightUrl(w) });
      w.log = [...(w.log || []), { at: now, ev: m.ev, text: `${m.title}: ${m.body}`, ok: !!r.ok }].slice(-12);
    }
    return now + TICK_MS;
  }
}

const LABELS = { inboundDep: 'decollo dell’aereo in arrivo', inbound: 'atterraggio dell’aereo in arrivo', gate: 'gate e cambi gate', boarding: 'imbarco', delay: 'ritardi', departed: 'decollo', landed: 'atterraggio', belt: 'nastro bagagli', cancel: 'cancellazione o dirottamento' };
const flightUrl = w => `./#/flight/${encodeURIComponent(w.number)}/${w.date}?dep=${w.dep}`;
