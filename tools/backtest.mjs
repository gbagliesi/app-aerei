// Test automatico dell'aereo stimato (js/rotation.js) sugli aeroporti il cui tabellone ufficiale pubblica le marche.
// Per ogni partenza con marche note: si nascondono TUTTE le marche, l'algoritmo sceglie l'aereo in arrivo, e si
// controlla se è davvero lo stesso aereo (stesse marche). Nessun dato da Flightradar24: solo i tabelloni ufficiali
// copiati dal Worker (/snap).
//   node tools/backtest.mjs [AEROPORTI] [GIORNI]     es. node tools/backtest.mjs "BUD BER MXP" 3
import { simulateRotation, DEFAULTS } from '../js/rotation.js';

const W = process.env.WORKER || 'https://tabelloni-voli.giuseppe-bagliesi.workers.dev';
const TZ = { BUD: 'Europe/Budapest', BER: 'Europe/Berlin', MXP: 'Europe/Rome', LIN: 'Europe/Rome', GVA: 'Europe/Zurich', BSL: 'Europe/Paris', ZRH: 'Europe/Zurich', FRA: 'Europe/Berlin', AMS: 'Europe/Amsterdam', ARN: 'Europe/Stockholm', DBV: 'Europe/Zagreb', LCY: 'Europe/London' };
const airports = (process.argv[2] || 'BUD BER MXP GVA BSL').split(/\s+/).filter(Boolean);
const nDays = +(process.argv[3] || 3);

const offMin = (tz, ms) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return (Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute) - ms) / 60e3; };
const toUtc = (local, tz) => { if (!local) return null; const g = Date.parse(local + ':00Z'); if (isNaN(g)) return null; return { utc: new Date(g - offMin(tz, g) * 60e3).toISOString() }; };
const localDay = (ms, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ms));

function conv(r, nature, tz) {
  const date = (r.schedDate || '').slice(0, 10), sched = toUtc(r.schedDate, tz);
  const clockAt = c => { if (!c) return null; let v = toUtc(`${date}T${c}`, tz); if (v && sched && Math.abs(Date.parse(v.utc) - Date.parse(sched.utc)) > 12 * 3600e3) v = { utc: new Date(Date.parse(v.utc) + (Date.parse(v.utc) < Date.parse(sched.utc) ? 1 : -1) * 86400e3).toISOString() }; return v; };
  const actual = r.actualAt ? toUtc(r.actualAt, tz) : clockAt(r.actual);
  const revised = r.estAt ? toUtc(r.estAt, tz) : clockAt(r.est);
  const side = { sched, actual, revised }, other = { iata: r.cityCode || r.city || null };
  const cancelled = /cancel|annull|törölve|gestrichen|annul/i.test(r.status || '');
  return { number: r.number, airline: { iata: r.number.slice(0, 2) }, status: cancelled ? 'Canceled' : 'x', reg: r.reg || null,
    [nature === 'A' ? 'arr' : 'dep']: side, [nature === 'A' ? 'dep' : 'arr']: other, aircraft: {} };
}

async function snap(a, n, d) {
  try { const r = await fetch(`${W}/snap?airport=${a}&nature=${n}&day=${d}`); return r.ok ? (await r.json()).flights || [] : []; } catch { return []; }
}

const variants = {
  attuale: {},
  coppie: { reservePairs: 'pair' },
  coppie_citta: { reservePairs: 'city' },
  fifo: { order: 'fifo' },
  coppie_fifo: { reservePairs: 'pair', order: 'fifo' },
  coppie_citta_fifo: { reservePairs: 'city', order: 'fifo' },
};
const tot = Object.fromEntries(Object.keys(variants).map(k => [k, { ok: 0, n: 0, byAl: {}, byBasis: {} }]));
const ms = t => (t?.utc ? Date.parse(t.utc) : NaN);
const arrT = a => ms(a.arr.actual) || ms(a.arr.revised) || ms(a.arr.sched);
const depT = d => ms(d.dep.actual) || ms(d.dep.revised) || ms(d.dep.sched);

for (const ap of airports) {
  const tz = TZ[ap] || 'Europe/Rome';
  const days = [...Array(nDays + 1)].map((_, i) => localDay(Date.now() - (nDays - i) * 86400e3, tz));
  const A = [], D = [];
  for (const d of days) {
    for (const r of await snap(ap, 'A', d)) if (r.number && r.schedDate) A.push(conv(r, 'A', tz));
    for (const r of await snap(ap, 'D', d)) if (r.number && r.schedDate) D.push(conv(r, 'D', tz));
  }
  const withReg = [...A, ...D].filter(f => f.reg).length;
  console.log(`\n== ${ap}: arrivi ${A.length}, partenze ${D.length}, con marche ${withReg} (giorni ${days.join(', ')})`);
  if (!A.length || !D.length) continue;
  const from = Math.min(...A.map(arrT).filter(x => !isNaN(x)));
  // voli da provare: partenze con marche, con almeno 20h di dati prima (così gli aerei della notte ci sono)
  const tests = D.filter(d => d.reg && !isNaN(depT(d)) && depT(d) - from > 20 * 3600e3 && depT(d) < Date.now() - 1800e3);
  const hide = f => ({ ...f, aircraft: {} });
  const Ah = A.map(hide), Dh = D.map(hide);
  const idx = new Map(A.map((a, i) => [Ah[i], a]));
  const perAp = Object.fromEntries(Object.keys(variants).map(k => [k, { ok: 0, n: 0 }]));
  const fails = [];
  for (const d of tests) {
    const t = depT(d), al = d.airline.iata;
    const prev = A.filter(a => a.reg === d.reg && arrT(a) <= t && arrT(a) > t - 30 * 3600e3 && a.airline.iata === al).sort((x, y) => arrT(y) - arrT(x))[0];
    // solo le compagnie con abbastanza voli in questo aeroporto (il caso delle low cost con base)
    if (A.filter(a => a.airline.iata === al).length < 6) continue;
    const flight = Dh[D.indexOf(d)];
    for (const [k, opts] of Object.entries(variants)) {
      const s = simulateRotation({ flight, arrivals: Ah, departures: Dh, coverageFrom: from, opts });
      if (!s) continue;
      const pick = s.pick && idx.get(s.pick);
      const ok = prev ? pick?.reg === d.reg : !pick;
      const T = tot[k]; T.n++; T.ok += ok; perAp[k].n++; perAp[k].ok += ok;
      (T.byAl[al] ||= { ok: 0, n: 0 }).n++; T.byAl[al].ok += ok;
      (T.byBasis[s.basis] ||= { ok: 0, n: 0 }).n++; T.byBasis[s.basis].ok += ok;
      if (k === (process.env.SHOW || 'attuale') && !ok && fails.length < 15) fails.push(`${d.number}→${d.arr.iata} ${d.dep.sched.utc.slice(5, 16)} ${d.reg}: vero ${prev ? prev.number + ' da ' + prev.dep.iata : 'nessun arrivo (già a terra)'}, stimato ${pick ? pick.number + ' da ' + pick.dep.iata + ' (' + pick.reg + ')' : s.basis} [${s.basis}]`);
    }
  }
  for (const [k, v] of Object.entries(perAp)) console.log(`  ${k.padEnd(18)} ${v.ok}/${v.n}  ${v.n ? Math.round(100 * v.ok / v.n) : 0}%`);
  if (fails.length) console.log('  errori (' + (process.env.SHOW || 'attuale') + '):\n   ' + fails.join('\n   '));
}
console.log('\n== TOTALE');
for (const [k, v] of Object.entries(tot)) {
  console.log(`${k.padEnd(18)} ${v.ok}/${v.n}  ${v.n ? Math.round(100 * v.ok / v.n) : 0}%   ` + Object.entries(v.byAl).sort((a, b) => b[1].n - a[1].n).slice(0, 6).map(([a, x]) => `${a} ${x.ok}/${x.n}`).join('  '));
  console.log('   per tipo: ' + Object.entries(v.byBasis).map(([a, x]) => `${a} ${x.ok}/${x.n}`).join('  '));
}
