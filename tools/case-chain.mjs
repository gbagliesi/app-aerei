// Propagazione delle ipotesi sul tabellone (andata e ritorno → giro → ritorno…) con probabilità moltiplicate.
// Atteso: FR8232 ≈EI-EBK 0.85, FR6184 0.34, FR6185 0.289, FR8000 0.116. Uso: node tools/case-chain.mjs
globalThis.localStorage = { _m: {'aerei.settings.v1': JSON.stringify({provider:'aerodatabox', workerUrl:'https://w'})}, getItem(k){return this._m[k]??null}, setItem(k,v){this._m[k]=v}, removeItem(k){delete this._m[k]} };
globalThis.window = globalThis;
globalThis.fetch = async () => ({ ok: true, json: async () => ({ events: [], flights: [] }), text: async () => '' });
const api = await import(new URL('../js/api.js', import.meta.url).href);
const D = new Date().toISOString().slice(0, 10);
const T = hm => ({ utc: `${D}T${hm}:00.000Z`, local: `${D} ${hm}+00:00` });
const dep = (n, to, hm, reg) => ({ number: n, airline: { iata: 'FR' }, status: 'Expected', dep: { iata: 'PSA', sched: T(hm) }, arr: { iata: to }, aircraft: reg ? { reg, regSrc: 'test' } : {} });
const arr = (n, from, hm) => ({ number: n, airline: { iata: 'FR' }, status: 'Expected', dep: { iata: from }, arr: { iata: 'PSA', sched: T(hm) }, aircraft: {} });
const data = {
  departures: [dep('FR8233', 'PRG', '07:00', 'EI-EBK'), dep('FR6184', 'BRI', '14:00'), dep('FR8000', 'STN', '18:40')],
  arrivals: [arr('FR8232', 'PRG', '13:10'), arr('FR6185', 'BRI', '17:40')],
};
console.log('changed', await api.guessBoardRegs('PSA', data));
for (const f of [...data.departures, ...data.arrivals]) console.log(f.number, f.aircraft.reg || '', JSON.stringify(f.aircraft.regGuess || null));
