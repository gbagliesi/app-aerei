// Stima dell'aereo che farà un volo quando la compagnia non ha ancora indicato le marche, con un
// ragionamento simile a quello dei tracker (Flightradar24 e simili): si ricostruisce la giornata della
// compagnia nell'aeroporto di partenza, in ordine di tempo, e ogni partenza "consuma" un aereo a terra.
//  - giro veloce: se un aereo della compagnia è arrivato poco prima (entro 1h30-2h), riparte con quello,
//    preferendo quello che arriva dalla stessa città (andata e ritorno) o con numero di volo accoppiato;
//  - altrimenti un aereo arrivato prima e rimasto fermo (anche dalla sera precedente: "notte in aeroporto");
//  - se nessun aereo arrivato è libero, parte con un aereo che era già a terra (rimasto dalla notte, o di
//    riserva nella base): non si abbina più un arrivo successivo o troppo a ridosso della partenza.
// Funzione pura (nessuna rete): usata da getInbound in api.js e provabile da sola.

// Varianti dell'algoritmo, scelte col test automatico (tools/backtest.mjs) sugli aeroporti che pubblicano le marche
export const DEFAULTS = { reservePairs: 'city', pairMax: 180, order: 'fifo' };

export const LOWCOST_CODES = ['FR', 'RK', 'U2', 'EC', 'DS', 'W6', 'W4', 'W9', 'VY', 'EW', 'HV', 'DY', 'V7', 'LS', 'TO', 'PC'];

const al = x => x.airline?.iata || (x.number || '').replace(/\d.*$/, '');
const ms = t => (t?.utc ? Date.parse(t.utc) : NaN);
export const arrTime = a => ms(a.arr?.actual) || ms(a.arr?.revised) || ms(a.arr?.sched);
export const depTime = d => ms(d.dep?.actual) || ms(d.dep?.revised) || ms(d.dep?.sched);
const flightNo = x => parseInt(((x.number || '').match(/(\d+)\D*$/) || [])[1], 10);
const sameFlight = (a, b) => a.number === b.number && Math.abs((ms(a.dep?.sched) || 0) - (ms(b.dep?.sched) || 0)) < 12 * 3600e3;

/**
 * @param {object} o
 *  - flight: il volo in partenza da stimare
 *  - arrivals, departures: voli (formato dell'app) dell'aeroporto di partenza, anche di più giorni
 *  - exclude: marche da non usare (aerei che la rete ADS-B mostra ripartiti o altrove)
 *  - stayed: marche che la rete ADS-B mostra ancora ferme qui: non possono aver fatto le partenze già decollate (prima di now)
 *  - coverageFrom: ms dell'inizio dei dati disponibili (per capire se un aereo "già a terra" può essere
 *    in realtà arrivato prima dei dati)
 * @returns {{ pick, basis, waitMin, overnight, ground, chain }}
 *  basis: 'return' (andata e ritorno), 'rotation' (giro veloce), 'idle' (aereo fermo da qualche ora),
 *         'overnight' (arrivato la sera prima), 'ground' (nessun arrivo libero: aereo già a terra)
 */
export function simulateRotation({ flight, arrivals, departures, exclude = new Set(), stayed = new Set(), now = Infinity, coverageFrom = NaN, opts = {} }) {
  const o = { ...DEFAULTS, ...opts };
  const airline = al(flight);
  const lowcost = LOWCOST_CODES.includes(airline) || LOWCOST_CODES.includes(o.alias?.[airline]);
  const minTurn = (o.minTurn ?? (lowcost ? 25 : 35)) * 60e3;
  const quickMax = (o.quickMax ?? (lowcost ? 90 : 120)) * 60e3;
  const target = depTime(flight);
  // un aereo può fare la partenza se arriva almeno minTurn prima; se è in ritardo ma il giro era previsto dagli orari
  // programmati, la partenza slitta (tipico delle low cost: FR9472 da Madrid in ritardo → FR9471 per Madrid parte dopo)
  const fits = (a, d, t) => {
    const at = arrTime(a);
    if (at + minTurn <= t) return true;
    if (ms(d.dep?.actual)) return false; // già decollato prima che l'aereo arrivasse
    return (ms(a.arr?.sched) || at) + minTurn <= (ms(d.dep?.sched) || t) && at <= t + 90 * 60e3;
  };
  if (isNaN(target)) return null;
  const from = target - 30 * 3600e3;

  const seen = new Set();
  const arr = arrivals.filter(a => al(a) === airline && a.status !== 'Canceled' && !isNaN(arrTime(a)))
    .filter(a => arrTime(a) >= from && arrTime(a) <= target + 90 * 60e3)
    .filter(a => { const k = `${a.number}|${a.arr?.sched?.utc}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .filter(a => !a.aircraft?.reg || !exclude.has(a.aircraft.reg))
    .sort((a, b) => arrTime(a) - arrTime(b));
  const deps = departures.filter(d => al(d) === airline && d.status !== 'Canceled' && !isNaN(depTime(d)) && !sameFlight(d, flight))
    .filter(d => depTime(d) >= from && depTime(d) < target + 60e3);
  deps.push(flight);
  deps.sort((a, b) => depTime(a) - depTime(b) || (a === flight ? 1 : -1));

  // andata e ritorno evidenti: un aereo che arriva da X e riparte poco dopo per X con numero di volo
  // accoppiato (es. FR5021 da Dublino → FR5020 per Dublino) è prenotato per quel ritorno, anche se nel
  // frattempo parte un altro volo della compagnia
  const pairOf = new Map(), pairFor = new Map();
  if (o.reservePairs) {
    for (const d of deps) {
      if (d.aircraft?.reg && d !== flight) continue;
      const t = depTime(d), dest = d.arr?.iata, n = flightNo(d);
      const c = arr.filter(a => !pairFor.has(a) && dest && a.dep?.iata === dest && fits(a, d, t) && t - arrTime(a) <= o.pairMax * 60e3
        && (o.reservePairs === 'city' || Math.abs(flightNo(a) - n) === 1)).pop();
      if (c) { pairOf.set(d, c); pairFor.set(c, d); }
    }
  }
  // aerei con le marche già indicate su una partenza: sono riservati a quella partenza
  const reserved = new Map();
  for (const d of deps) if (d !== flight && d.aircraft?.reg) reserved.set(d.aircraft.reg, d);

  const used = new Set(), chain = [];
  for (const d of deps) {
    const t = depTime(d);
    const pool = arr.filter(a => !used.has(a) && fits(a, d, t) && (!pairFor.has(a) || pairFor.get(a) === d));
    let pick = null, basis;
    if (pairOf.has(d) && !used.has(pairOf.get(d))) {
      pick = pairOf.get(d); basis = 'return';
    } else if (d.aircraft?.reg && d !== flight) {
      pick = pool.filter(a => a.aircraft?.reg === d.aircraft.reg).pop() || null;
      basis = pick ? 'reg' : 'ground';
    } else {
      const gone = d !== flight && t < now;
      const free = pool.filter(a => { const r = a.aircraft?.reg && reserved.get(a.aircraft.reg); return !r || depTime(r) < arrTime(a); })
        .filter(a => !(gone && stayed.has(a.aircraft?.reg)));
      const quick = free.filter(a => t - arrTime(a) <= quickMax);
      if (quick.length) {
        const dest = d.arr?.iata, n = flightNo(d);
        pick = quick.filter(a => dest && a.dep?.iata === dest).pop()
          || quick.filter(a => Math.abs(flightNo(a) - n) === 1).pop()
          || (o.order === 'fifo' ? quick[0] : quick[quick.length - 1]);
        basis = dest && pick.dep?.iata === dest ? 'return' : 'rotation';
      } else if (free.length) {
        // l'aereo fermo da più tempo, preferendo quelli che la rete ADS-B conferma ancora qui
        pick = (d === flight && free.find(a => stayed.has(a.aircraft?.reg))) || free[0];
        const night = t - arrTime(pick) >= 5 * 3600e3 && new Date(arrTime(pick)).getUTCDate() !== new Date(t).getUTCDate();
        basis = night ? 'overnight' : 'idle';
      } else basis = 'ground';
    }
    if (pick) used.add(pick);
    chain.push({ dep: d, pick, basis });
    if (d === flight) {
      // aerei arrivati la sera prima ancora liberi: sono quelli "rimasti a terra stanotte"
      const dayStart = target - 20 * 3600e3;
      const overnight = arr.filter(a => !used.has(a) && arrTime(a) >= dayStart && arrTime(a) + 5 * 3600e3 <= target);
      return {
        pick, basis, chain, overnight,
        waitMin: pick ? Math.round((t - arrTime(pick)) / 60e3) : null,
        // "già a terra" è certo solo se i dati coprono la giornata da prima della partenza
        partialData: basis === 'ground' && !(coverageFrom <= target - 8 * 3600e3),
      };
    }
  }
  return null;
}
