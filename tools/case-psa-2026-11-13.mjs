// Caso Pisa 2026-11-13 (Giuseppe): FR8868 da Marrakech (9H-QBP) e FR8232 da Praga (EI-EBK) arrivano a 5 minuti; FR6184 per Bari era EI-EBK.
// Atteso: FR6184 ≈ 9H-QBP con probabilità bassa (~17%) e alternativa EI-EBK. Uso: node tools/case-psa-2026-11-13.mjs
globalThis.localStorage = { _m: {'aerei.settings.v1': JSON.stringify({provider:'aerodatabox', workerUrl:'https://w'})}, getItem(k){return this._m[k]??null}, setItem(k,v){this._m[k]=v}, removeItem(k){delete this._m[k]} };
globalThis.window = globalThis;
globalThis.fetch = async () => ({ ok: true, json: async () => ({ events: [], flights: [] }), text: async () => '' });
const api = await import(new URL('../js/api.js', import.meta.url).href);
const D = new Date().toISOString().slice(0, 10);
const T = hm => { const [h, m] = hm.split(':').map(Number); const u = `${D}T${String(h - 1).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`; return { utc: u, local: `${D} ${hm}+01:00` }; };
const dep = (n, to, hm, reg) => ({ number: n, airline: { iata: 'FR' }, status: 'Expected', dep: { iata: 'PSA', sched: T(hm) }, arr: { iata: to }, aircraft: reg ? { reg, regSrc: 'test' } : {} });
const arr = (n, from, hm) => ({ number: n, airline: { iata: 'FR' }, status: 'Expected', dep: { iata: from }, arr: { iata: 'PSA', sched: T(hm) }, aircraft: {} });
const data = {
  departures: [dep('FR8869', 'RAK', '07:05', '9H-QBP'), dep('FR8233', 'PRG', '10:25', 'EI-EBK'), dep('FR6184', 'BRI', '15:00'), dep('FR7931', 'KRK', '15:10'), dep('FR6256', 'PMO', '15:20')],
  arrivals: [arr('FR8868', 'RAK', '14:05'), arr('FR8232', 'PRG', '14:10'), arr('FR9472', 'MAD', '14:35')],
};
await api.guessBoardRegs('PSA', data);
for (const f of [...data.departures, ...data.arrivals]) { const g = f.aircraft.regGuess; console.log(f.number, f.aircraft.reg || '', g ? `${g.reg} via ${g.via || g.sameAs} p=${g.p} alts=${JSON.stringify(g.alts || [])}` : ''); }
