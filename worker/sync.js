// Sincronizzazione fra dispositivi (preferiti, tab, voli seguiti, impostazioni) e anelli condivisi della catena dei voli.
// Tutto sta nel Durable Object "Watcher" (istanze separate): "acct:<id>" per ogni account, "syncpair" per i codici
// di collegamento, "links" per gli anelli (volo → volo precedente) calcolati da qualunque dispositivo.
//
// Niente password né email: il primo dispositivo crea l'account e riceve un codice segreto (token) che resta nel
// browser; gli altri si collegano con un codice di 8 caratteri valido 10 minuti, mostrato dal primo.
// Ogni dispositivo ha il suo token (account.segreto): si può scollegare un dispositivo senza toccare gli altri.
//
//   POST /sync/new      { name }                    → { token }            crea l'account (primo dispositivo)
//   POST /sync/pair     { token }                   → { code, exp }        codice per collegare un altro dispositivo
//   POST /sync/join     { code, name }              → { token }            collega questo dispositivo
//   POST /sync          { token, since, changes, name } → { seq, changes, devices }   scambio dei cambiamenti
//   POST /sync/devices  { token }                   → { devices, me }
//   POST /sync/remove   { token, id }               → { ok }               scollega un dispositivo (anche sé stesso)
//   POST /sync/wipe     { token }                   → { ok }               cancella l'account e i suoi dati
//   GET  /links?k=...&k=...                         → { links: { k: {...} } }   anelli condivisi (lettura libera)
//   POST /links         { token, links: { k: {...} } } → { saved }         solo dispositivi collegati
//
// Ogni dato sincronizzato è un "record" (chiave → valore); vince la modifica più recente (valore null = cancellato).

const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const rnd = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // senza 0/O e 1/I, facili da confondere
const newCode = () => [...crypto.getRandomValues(new Uint8Array(8))].map(x => ALPHA[x & 31]).join('');
const parseToken = t => { const m = /^([0-9a-f]{32})\.([0-9a-f]{48})$/.exec(String(t || '').trim()); return m ? { acct: m[1], secret: m[2] } : null; };
const devName = s => String(s || 'dispositivo').replace(/[^\p{L}\p{N} ._()·-]/gu, '').slice(0, 40) || 'dispositivo';

const PAIR_TTL = 10 * 60e3;
const MAX_RECORDS = 3000, MAX_VALUE = 32000, MAX_CHANGES = 400;
const TOMB_KEEP = 60 * 86400e3;           // le cancellazioni si ricordano 60 giorni
const LINK_TTL = 30 * 3600e3, LINK_FRESH = 20 * 60e3, MAX_LINK = 8000;
const KEY_RE = /^[a-z]{2,12}(:[^\s]{1,120})?$/;

// ---------- lato Worker ----------
const stub = (env, name) => env.WATCHER.get(env.WATCHER.idFromName(name));
async function call(env, name, op, body = {}) {
  const r = await stub(env, name).fetch(`https://do/_sync/${op}`, { method: 'POST', body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `errore ${r.status}`), { status: r.status });
  return j;
}

export async function handleSync(request, url, env, json) {
  if (!env.WATCHER) return json({ error: 'sincronizzazione non configurata nel Worker (manca il Durable Object WATCHER)' }, 501);
  try {
    if (url.pathname === '/links' && request.method === 'GET') {
      const keys = url.searchParams.getAll('k').filter(k => k.length <= 120).slice(0, 20);
      if (!keys.length) return json({ links: {} });
      return json(await call(env, 'links', 'links/get', { keys }));
    }
    if (request.method !== 'POST') return json({ error: 'usa POST' }, 405);
    const b = await request.json().catch(() => ({}));
    const p = url.pathname;
    if (p === '/sync/new') {
      // un solo account per Worker (uso personale): dopo il primo, gli altri dispositivi entrano solo con un codice
      // mostrato da un dispositivo già collegato. Se l'account viene cancellato se ne può creare uno nuovo.
      const { owner } = await call(env, 'syncpair', 'owner/get');
      if (owner) {
        const alive = await call(env, `acct:${owner}`, 'acct/exists').then(r => r.exists).catch(() => true);
        if (alive) return json({ error: 'Su questo Worker c’è già un account: per collegare questo dispositivo inserisci il codice mostrato da un dispositivo già collegato (Impostazioni → Collega un altro dispositivo).' }, 403);
      }
      const acct = rnd(16), secret = rnd(24);
      await call(env, 'syncpair', 'owner/set', { acct, prev: owner || null });
      await call(env, `acct:${acct}`, 'acct/init', { secret, name: devName(b.name) });
      return json({ token: `${acct}.${secret}` });
    }
    if (p === '/sync/join') {
      const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const { acct } = await call(env, 'syncpair', 'pair/take', { code });
      const { secret } = await call(env, `acct:${acct}`, 'acct/adddev', { name: devName(b.name) });
      return json({ token: `${acct}.${secret}` });
    }
    const tk = parseToken(b.token);
    if (!tk) return json({ error: 'codice dell’account non valido', auth: false }, 401);
    const acctName = `acct:${tk.acct}`;
    if (p === '/sync/pair') {
      await call(env, acctName, 'acct/check', { secret: tk.secret });
      return json(await call(env, 'syncpair', 'pair/put', { acct: tk.acct }));
    }
    if (p === '/sync') return json(await call(env, acctName, 'acct/sync', { secret: tk.secret, since: b.since, changes: b.changes, name: b.name }));
    if (p === '/sync/devices') return json(await call(env, acctName, 'acct/devices', { secret: tk.secret }));
    if (p === '/sync/remove') return json(await call(env, acctName, 'acct/remove', { secret: tk.secret, id: b.id }));
    if (p === '/sync/wipe') return json(await call(env, acctName, 'acct/wipe', { secret: tk.secret }));
    if (p === '/links') {
      await call(env, acctName, 'acct/check', { secret: tk.secret });
      return json(await call(env, 'links', 'links/put', { links: b.links }));
    }
    return json({ error: 'not found' }, 404);
  } catch (e) {
    const s = e.status || 500;
    return json({ error: String(e.message || e), auth: s === 401 ? false : undefined }, s);
  }
}

// ---------- lato Durable Object ----------
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

async function auth(storage, secret) {
  const meta = await storage.get('meta');
  if (!meta) throw err('account sconosciuto (cancellato?)', 401);
  const h = await sha(String(secret || ''));
  const id = h.slice(0, 12);
  const dev = await storage.get(`dev:${id}`);
  if (!dev || dev.hash !== h) throw err('questo dispositivo non è più collegato all’account', 401);
  return { id, dev };
}
async function devices(storage) {
  const all = await storage.list({ prefix: 'dev:' });
  return [...all.entries()].map(([k, d]) => ({ id: k.slice(4), name: d.name, created: d.created, last: d.last })).sort((a, b) => (b.last || 0) - (a.last || 0));
}
async function addDev(storage, name, secret = rnd(24)) {
  const h = await sha(secret);
  await storage.put(`dev:${h.slice(0, 12)}`, { hash: h, name, created: Date.now(), last: Date.now() });
  return secret;
}

export async function syncDo(storage, url, request) {
  const op = url.pathname.slice('/_sync/'.length);
  const b = await request.json().catch(() => ({}));
  const now = Date.now();

  if (op === 'acct/init') {
    if (await storage.get('meta')) throw err('account già esistente', 409);
    await storage.put('meta', { created: now, seq: 0 });
    await addDev(storage, b.name, b.secret);
    return { ok: true };
  }
  if (op === 'acct/exists') return { exists: !!(await storage.get('meta')) };
  if (op === 'owner/get') return { owner: (await storage.get('owner')) || null };
  if (op === 'owner/set') {
    // evita che due richieste contemporanee creino due account
    const cur = (await storage.get('owner')) || null;
    if (cur !== (b.prev || null)) throw err('account appena creato da un’altra richiesta', 409);
    await storage.put('owner', b.acct);
    return { ok: true };
  }
  if (op === 'acct/adddev') {
    if (!(await storage.get('meta'))) throw err('account sconosciuto (cancellato?)', 404);
    if ((await storage.list({ prefix: 'dev:' })).size >= 20) throw err('troppi dispositivi collegati (al massimo 20): scollegane qualcuno');
    return { secret: await addDev(storage, b.name) };
  }
  if (op.startsWith('acct/')) {
    const me = await auth(storage, b.secret);
    if (op === 'acct/check') return { ok: true };
    if (op === 'acct/devices') return { devices: await devices(storage), me: me.id };
    if (op === 'acct/remove') {
      const id = String(b.id || '');
      if (!/^[0-9a-f]{12}$/.test(id)) throw err('dispositivo non valido');
      await storage.delete(`dev:${id}`);
      return { ok: true };
    }
    if (op === 'acct/wipe') { await storage.deleteAll(); return { ok: true }; }
    if (op === 'acct/sync') {
      const meta = await storage.get('meta');
      const since = Number.isFinite(+b.since) ? +b.since : 0;
      const changes = b.changes && typeof b.changes === 'object' ? Object.entries(b.changes).slice(0, MAX_CHANGES) : [];
      const all = await storage.list({ prefix: 'r:' });
      const lost = {}, puts = {};
      let count = all.size;
      for (const [k, c] of changes) {
        if (!KEY_RE.test(k) || !c || typeof c !== 'object') continue;
        const v = c.v === undefined ? null : c.v;
        if (v !== null && JSON.stringify(v).length > MAX_VALUE) continue;
        const t = Math.min(Number(c.t) || now, now);
        const old = all.get(`r:${k}`);
        // vince la modifica più recente; a parità resta quella già salvata
        if (old && old.t >= t) { if (JSON.stringify(old.v) !== JSON.stringify(v)) lost[k] = { v: old.v, t: old.t }; continue; }
        if (!old && v === null) continue;
        if (!old && ++count > MAX_RECORDS) throw err(`troppi dati sincronizzati (al massimo ${MAX_RECORDS} voci)`);
        puts[`r:${k}`] = { v, t, s: ++meta.seq };
      }
      const keys = Object.keys(puts);
      for (let i = 0; i < keys.length; i += 100) await storage.put(Object.fromEntries(keys.slice(i, i + 100).map(k => [k, puts[k]])));
      // cancellazioni vecchie: non servono più
      const tomb = [...all.entries()].filter(([k, r]) => r.v === null && now - r.t > TOMB_KEEP && !puts[k]).map(([k]) => k);
      if (tomb.length) await storage.delete(tomb.slice(0, 128));
      await storage.put('meta', meta);
      await storage.put(`dev:${me.id}`, { ...me.dev, last: now, ...(b.name ? { name: devName(b.name) } : {}) });
      const out = {};
      for (const [k, r] of all) if (r.s > since && !puts[k]) out[k.slice(2)] = { v: r.v, t: r.t };
      for (const [k, r] of Object.entries(puts)) if (r.s > since) out[k.slice(2)] = { v: r.v, t: r.t };
      Object.assign(out, lost);
      return { seq: meta.seq, changes: out, devices: await devices(storage), me: me.id, reset: since > meta.seq || undefined };
    }
  }

  if (op === 'pair/put') {
    let code;
    do code = newCode(); while (await storage.get(`code:${code}`));
    const exp = now + PAIR_TTL;
    await storage.put(`code:${code}`, { acct: b.acct, exp });
    // codici scaduti
    const old = [...(await storage.list({ prefix: 'code:' })).entries()].filter(([, v]) => v.exp < now).map(([k]) => k);
    if (old.length) await storage.delete(old.slice(0, 128));
    return { code, exp };
  }
  if (op === 'pair/take') {
    // limite ai tentativi sbagliati (40 ogni 10 minuti, per tutti) contro chi prova codici a caso
    const fail = (await storage.get('fail')) || { from: now, n: 0 };
    if (now - fail.from > PAIR_TTL) Object.assign(fail, { from: now, n: 0 });
    if (fail.n >= 40) throw err('troppi tentativi: riprova fra qualche minuto', 429);
    const code = String(b.code || '');
    const rec = /^[A-Z0-9]{8}$/.test(code) ? await storage.get(`code:${code}`) : null;
    if (!rec || rec.exp < now) { fail.n++; await storage.put('fail', fail); throw err('codice non valido o scaduto: fanne mostrare uno nuovo dall’altro dispositivo', 404); }
    await storage.delete(`code:${code}`);
    return { acct: rec.acct };
  }

  if (op === 'links/get') {
    const keys = (b.keys || []).map(k => `l:${k}`);
    const got = keys.length ? await storage.get(keys) : new Map();
    const links = {};
    for (const [k, v] of got) if (v && now - v.at < (v.rank >= 3 ? LINK_TTL : LINK_FRESH)) links[k.slice(2)] = v;
    return { links };
  }
  if (op === 'links/put') {
    const entries = Object.entries(b.links || {}).slice(0, 30);
    const got = await storage.get(entries.map(([k]) => `l:${k}`));
    const puts = {};
    for (const [k, v] of entries) {
      if (k.length > 120 || !v || typeof v !== 'object' || JSON.stringify(v).length > MAX_LINK) continue;
      const rank = [1, 2, 3].includes(v.rank) ? v.rank : 1;
      const e = { ...v, rank, at: Math.min(Number(v.at) || now, now) };
      const old = got.get(`l:${k}`);
      // una stima meno informata non sostituisce una più informata ancora valida
      if (old && now - old.at < (old.rank >= 3 ? LINK_TTL : LINK_FRESH) && (old.rank > rank || (old.rank === rank && old.at >= e.at))) continue;
      puts[`l:${k}`] = e;
    }
    if (Object.keys(puts).length) await storage.put(puts);
    // pulizia ogni tanto degli anelli scaduti
    if (Math.random() < 0.05) {
      const all = await storage.list({ prefix: 'l:' });
      const old = [...all.entries()].filter(([, v]) => now - v.at > LINK_TTL).map(([k]) => k);
      for (let i = 0; i < old.length; i += 128) await storage.delete(old.slice(i, i + 128));
    }
    return { saved: Object.keys(puts).length };
  }
  throw err('not found', 404);
}
