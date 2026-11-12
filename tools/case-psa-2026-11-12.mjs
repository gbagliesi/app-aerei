// Caso di prova: Pisa, Ryanair, 11-12 novembre 2026. Marche vere dagli screenshot di Flightradar24 mandati da Giuseppe
// (controllo a mano, non raccolta automatica). node tools/case-psa-2026-11-12.mjs
import { simulateRotation } from '../js/rotation.js';
const A12 = `FR8485 07:20 06:57 PMO EI-IHV|FR6020 08:00 07:46 BDS EI-GSI|FR7932 09:05 09:05 KRK SP-RZK|FR6205 09:50 09:21 CTA EI-GXH|FR3745 10:00 09:39 CRL 9H-QBP|FR5021 10:15 09:52 DUB 9H-VUP|FR5709 10:45 10:29 CAG 9H-QDK|FR7477 11:25 10:38 TFS EI-IFT|FR8449 11:35 11:35 PMO EI-ENE|FR6937 12:50 12:50 SUF 9H-QAB|FR8868 13:00 13:00 RAK EI-EKP|FR586 13:20 13:20 STN EI-ILF|FR9472 14:40 14:40 MAD -|FR953 14:40 14:40 VLC -|FR419 16:35 16:35 BVA -|FR356 16:50 16:50 SVQ -|FR5023 18:40 18:40 BUD -|FR773 19:15 19:15 AGP -|FR6492 20:10 20:10 CTA -`;
const D12 = `FR8869 06:00 05:53 RAK|FR3746 06:10 06:03 CRL|FR6204 06:15 06:08 CTA EI-GXH|FR8486 07:45 07:34 PMO|FR5708 08:00 07:50 CAG|FR6019 08:25 08:25 BDS|FR587 08:30 08:38 STN|FR6936 09:30 09:20 SUF|FR7931 09:30 09:45 KRK|FR952 10:25 10:25 VLC EI-GXH|FR5020 10:45 10:45 DUB 9H-VUP|FR355 11:15 11:15 SVQ 9H-QDK|FR7476 11:50 11:50 TFS EI-IFT|FR8450 12:00 12:35 PMO EI-ENE|FR772 13:40 13:55 AGP 9H-QAB|FR7988 14:20 14:35 LPA EI-ILF|FR5024 15:00 15:15 BUD 9H-QBP|FR9471 15:05 15:05 MAD EI-EBG|FR9422 15:10 15:25 FUE EI-EKP|FR6491 16:35 16:35 CTA -|FR418 17:00 17:00 BVA -`;
const A11 = `FR953 07:55 07:45 VLC|FR8449 10:30 10:21 PMO|FR8868 13:15 15:10 RAK EI-GXH|FR9472 15:35 15:17 MAD|FR584 15:45 15:52 STN|FR5399 16:00 15:38 TIA|FR6205 18:30 18:45 CTA|FR6255 21:25 21:10 PMO|FR586 22:00 21:55 STN`;
const t = (d, hm) => ({ utc: new Date(`${d}T${hm}:00+01:00`).toISOString() });
const truth = {};
const mk = (s, d, side) => s.split('|').map(x => { const [n, sc, ac, c, reg] = x.split(' '); const f = { number: n, airline: { iata: 'FR' }, status: 'x', aircraft: {} };
  f[side] = { sched: t(d, sc), actual: t(d, ac) }; f[side === 'arr' ? 'dep' : 'arr'] = { iata: c }; if (reg && reg !== '-') truth[n + d + side] = reg; f._k = n + d + side; return f; });
const arrivals = [...mk(A11, '2026-11-11', 'arr'), ...mk(A12, '2026-11-12', 'arr')];
const departures = mk(D12, '2026-11-12', 'dep');
for (const v of [{ reservePairs: false, order: 'lifo' }, {}]) {
  let ok = 0, n = 0; const out = [];
  for (const flight of departures) {
    const tr = truth[flight._k]; if (!tr) continue;
    const s = simulateRotation({ flight, arrivals, departures, coverageFrom: 0, opts: v });
    const got = s.pick ? truth[s.pick._k] : null; n++; const good = got === tr; ok += good;
    out.push(`${flight.number}→${flight.arr.iata} ${tr}: ${s.pick?.number || '-'} (${got || '?'}) ${s.basis} ${good ? '✓' : '✗'}`);
  }
  console.log(JSON.stringify(v), ok + '/' + n); console.log(' ' + out.join('\n '));
}
