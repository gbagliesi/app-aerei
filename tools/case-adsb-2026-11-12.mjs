// Caso reale 2026-11-12 (avvistamenti ADS-B a Pisa e Bari): abbinamento decolli/atterraggi ai voli del tabellone (fillRegs).
// Atteso: FR9471=EI-EBG, FR9422=EI-EKP, FR548=9H-QDT, FR7074=EI-EXD, FR1906/FR3980 senza marche (ambigui). Uso: node tools/case-adsb-2026-11-12.mjs
globalThis.localStorage = { _m: {'aerei.settings.v1': JSON.stringify({provider:'aerodatabox', workerUrl:'https://w'})}, getItem(k){return this._m[k]??null}, setItem(k,v){this._m[k]=v}, removeItem(k){delete this._m[k]} };
globalThis.window = globalThis;
const Z = (hm) => `2026-11-12T${hm}:00Z`;
const L2U = hm => { const [h,m]=hm.split(':').map(Number); const t=new Date(Date.UTC(2026,10,12,h-1,m)); return t.toISOString(); };
const ev = (s) => s.trim().split('\n').map(l => { const [ev, cs, reg, hm] = l.trim().split('|'); return { ev, cs, reg, hex: reg, t: Date.parse(Z(hm)) }; });
const SEEN = {
 PSA: ev(`dep|RYR9187|EI-EKP|14:45
dep|RYR2ZE|EI-EBG|14:53
arr|RYR88XB|EI-EBW|15:20
arr|RYR39BF|EI-EBK|16:16
dep|RYR36NL|EI-EBW|17:00
arr|RYR3GF|9H-QBP|17:39
arr|RYR10MD|9H-QAD|18:44
arr|RYR64RK|EI-IJX|18:57
arr|RYR19AM|EI-DCJ|19:42
dep|RYR6256|EI-IJX|19:47`),
 BRI: ev(`arr|RYR288E|9H-QDT|15:50
arr|RYR38WZ|EI-IHT|16:36
dep|RYR61EX|EI-EXD|16:36
dep|RYR77ZY|9H-QDT|16:38
arr|RYR6JL|9H-QBL|14:48
arr|RYR53HB|9H-QAL|14:56
dep|RYR65PM|9H-QBL|16:00
dep|RYR3BG|9H-QBM|15:27
dep|RYR4CF|EI-IHT|17:24`) };
globalThis.fetch = async (u) => { const ap = new URL(u).searchParams.get('airport'); return { ok: true, json: async () => ({ events: SEEN[ap] || [] }) }; };
const api = await import(new URL('../js/api.js', import.meta.url).href);
const fl = (num, from, to, sched, act, side) => ({ number: num, airline: { iata: 'FR' }, dep: { iata: from, ...(side==='dep'?{sched:{utc:L2U(sched)},actual:{utc:L2U(act)}}:{}) }, arr: { iata: to, ...(side==='arr'?{sched:{utc:L2U(sched)},actual:{utc:L2U(act)}}:{}) }, aircraft: {} });
// PSA: FR9472 arrived with EI-EBG known (board/Giuseppe) - test without and with
for (const known of [false, true]) {
  const arr = [fl('FR9472','MAD','PSA','14:40','14:51','arr'), fl('FR356','SVQ','PSA','16:50','17:23','arr'), fl('FR5023','BUD','PSA','18:40','18:45','arr')];
  if (known) arr[0].aircraft.reg = 'EI-EBG';
  const dep = [fl('FR9471','PSA','MAD','15:05','15:42','dep'), fl('FR9422','PSA','FUE','15:10','15:18','dep'), fl('FR418','PSA','BVA','17:00','17:52','dep')];
  await api.fillRegs('PSA', arr, dep);
  console.log('PSA known', known, [...arr, ...dep].map(f => f.number + '=' + (f.aircraft.reg||'-')).join(' '));
}
const arr = [fl('FR549','BLQ','BRI','17:10','16:49','arr'), fl('FR810','VCE','BRI','17:50','17:35','arr'), fl('FR9004','VIE','BRI','15:45','15:46','arr'), fl('FR1905','STN','BRI','16:05','15:55','arr')];
const dep = [fl('FR548','BRI','BLQ','17:35','17:35','dep'), fl('FR7074','BRI','FCO','17:35','17:37','dep'), fl('FR1906','BRI','STN','16:30','16:58','dep'), fl('FR3980','BRI','VRN','16:55','17:00','dep'), fl('FR811','BRI','VCE','18:15','18:25','dep'), fl('FR1608','BRI','BVA','16:20','16:30','dep')];
await api.fillRegs('BRI', arr, dep);
console.log('BRI', [...arr, ...dep].map(f => f.number + '=' + (f.aircraft.reg||'-')).join(' '));
