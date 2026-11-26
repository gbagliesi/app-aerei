import { getBoard, guessBoardRegs, getFlight, getInbound, getLivePosition, getAirportInfo, isoDate, testKey, getFlightsByReg, liveByReg, testWorker, officialByReg, getRegHistory, getTrace, hexOfReg, rememberFlightReg, OFFICIAL_AIRPORTS, OFFICIAL_SOURCES, officialInfo, boardAge, boardContext } from './api.js';
import { searchAirports, airportByIata, AIRPORTS, norm, airportSearchText } from './airports.js';
import { getSettings, saveSettings, getFavorites, isFavorite, toggleFavorite, exportFavorites, importFavorites, reorderFavorites, favKey } from './store.js';
import { greatCircle, distanceKm } from './demo.js';
import { pushProblem, checkPush, watchFlight, refreshWatch, unwatch, getWatch, listWatches, testPush, EVENT_LABELS, DEFAULT_EVENTS, pendingWatches, activatePending } from './notify.js';
import { initSync, syncNow, syncAccount, isLinked, createAccount, joinAccount, pairingCode, listDevices, removeDevice, unlinkThis, wipeAccount, setCats, SYNC_CATS, sharedLink, shareLink } from './sync.js';
import { initTabs, enterTab, setTabInfo, playEnterAnim, closeAllTabs, openTabsCount } from './tabs.js';

// ---------- età dei dati: "aggiornato 3 min fa" (si aggiorna da solo ogni 5 secondi) ----------
function ago(at) {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 10) return 'adesso';
  if (s < 60) return `${s} s fa`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min fa`;
  const h = Math.floor(m / 60), mm = m % 60;
  if (h < 24) return `${h} h${mm ? ` ${mm} min` : ''} fa`;
  return `il ${new Date(at).toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
}
// warnMin: oltre questi minuti il dato è vecchio per quella fonte e l'età diventa arancione
const ageTag = (at, warnMin = 20) => {
  if (!at) return '';
  const old = Date.now() - at > warnMin * 60e3;
  const when = new Date(at).toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `<span class="age${old ? ' old' : ''}" data-at="${at}" data-warn="${warnMin}" title="Dati letti alla fonte il ${when}">${ago(at)}</span>`;
};
setInterval(() => {
  if (document.hidden) return;
  for (const e of document.querySelectorAll('.age[data-at]')) {
    const at = +e.dataset.at;
    e.textContent = ago(at);
    e.classList.toggle('old', Date.now() - at > +e.dataset.warn * 60e3);
  }
}, 5000);
// soglie: il Worker rilegge i tabelloni ufficiali ogni 90 s; AeroDataBox l'app lo richiede al massimo ogni 15 min
const OFF_WARN = 6, ADB_WARN = 20;
// età di un tabellone ufficiale, con l'avviso se è una copia di riserva
const offAgeText = a => !a ? '' : a.snap || a.stale ? `<span title="Il sito ufficiale non risponde ora: il Worker mostra la sua ultima lettura riuscita">⚠ copia di riserva, ${ageTag(a.at, 0)}</span>` : `aggiornato ${ageTag(a.at, OFF_WARN)}`;
const offAgeSide = s => s?._offAt ? offAgeText({ at: s._offAt, stale: s._offStale }) : '';

// Riga "Fonti" sotto il tabellone: da dove arrivano i dati mostrati e quanto sono recenti
// Avviso breve sopra il tabellone (i dettagli sono nel riquadro "Fonti" in fondo alla pagina)
function sourcesNote(iata, dir, list, degraded, adbAt) {
  const s = getSettings();
  const note = (txt, cls = '') => `<p class="hint sources ${cls}">${txt}</p>`;
  if (s.provider !== 'aerodatabox') return note('Fonte: dati dimostrativi.');
  const site = OFFICIAL_SOURCES[iata];
  const adb = adbAt ? ` (aggiornato ${ageTag(adbAt, ADB_WARN)})` : '';
  if (!OFFICIAL_AIRPORTS[iata] || !(s.workerUrl || '').trim()) return note(`Fonte: AeroDataBox${adb}.`);
  const i = officialInfo[`${iata}:${dir === 'dep' ? 'D' : 'A'}`] || {};
  if (i.error) return note(`Fonte: AeroDataBox${adb} · ⚠ tabellone ufficiale non disponibile ora.`);
  const oa = boardAge[`${iata}:${dir === 'dep' ? 'D' : 'A'}`];
  const off = oa ? ` (${offAgeText(oa)})` : '';
  if (degraded) return note(`Fonte: ${esc(site)}${off} · ⚠ AeroDataBox non disponibile ora.`, 'official');
  return note(`Fonti: ${esc(site)}${off} + AeroDataBox${adb}.`, 'official');
}
// riepilogo per il riquadro "Fonti": quanti voli da quale fonte
function boardCounts(list) {
  const both = list.filter(x => x._official && !x._officialOnly).length, only = list.filter(x => x._officialOnly).length, adb = list.length - both - only;
  const parts = [];
  if (both) parts.push(`${both} dal tabellone ufficiale completati da AeroDataBox`);
  if (only) parts.push(`${only} solo nel tabellone ufficiale`);
  if (adb) parts.push(`${adb} solo da AeroDataBox`);
  return parts.length ? `voli in questa vista: ${parts.join('; ')}` : '';
}
// Aeroporti senza tabellone ufficiale leggibile dal Worker (siti protetti): link alla pagina ufficiale
const SITE_BOARDS = {
  QSR: { dep: 'https://www.aeroportodisalerno.it/', name: 'aeroportodisalerno.it' },
  PSR: { dep: 'https://www.abruzzoairport.eu/index.php/voli-in-tempo-reale/', name: 'abruzzoairport.eu' },
  PNL: { dep: 'https://www.aeroportodipantelleria.it/info-voli/arrivi-partenze/', name: 'aeroportodipantelleria.it' },
  NAP: { dep: 'https://www.aeroportodinapoli.it/partenze', arr: 'https://www.aeroportodinapoli.it/arrivi', name: 'aeroportodinapoli.it' },
  BGY: { dep: 'https://www.milanbergamoairport.it/it/voli-tempo-reale/', name: 'milanbergamoairport.it' },
  OLB: { dep: 'https://www.geasar.it/voli/i-voli-di-oggi/?type=departures', arr: 'https://www.geasar.it/voli/i-voli-di-oggi/?type=arrivals', name: 'geasar.it' },
  AHO: { dep: 'https://www.aeroportodialghero.it/voli/i-voli-di-oggi/?type=departures', arr: 'https://www.aeroportodialghero.it/voli/i-voli-di-oggi/?type=arrivals', name: 'aeroportodialghero.it' },
  LHR: { dep: 'https://www.heathrow.com/departures', arr: 'https://www.heathrow.com/arrivals', name: 'heathrow.com' },
  CDG: { dep: 'https://www.parisaeroport.fr/', name: 'parisaeroport.fr' },
  ORY: { dep: 'https://www.parisaeroport.fr/', name: 'parisaeroport.fr' },
  CPH: { dep: 'https://www.cph.dk/en/flight-info/departures', arr: 'https://www.cph.dk/en/flight-info/arrivals', name: 'cph.dk' },
  HEL: { dep: 'https://www.finavia.fi/en/airports/helsinki-airport/flights?tab=dep', arr: 'https://www.finavia.fi/en/airports/helsinki-airport/flights?tab=arr', name: 'finavia.fi' },
  ATH: { dep: 'https://www.aia.gr/en/flights', name: 'aia.gr' },
  HER: { dep: 'https://www.heraklion-airport.gr/', name: 'heraklion-airport.gr' },
  BRU: { dep: 'https://www.brusselsairport.be/en/passengers/flights', name: 'brusselsairport.be' },
  STR: { dep: 'https://www.stuttgart-airport.com/', name: 'stuttgart-airport.com' },
  GLA: { dep: 'https://www.glasgowairport.com/flight-information/', name: 'glasgowairport.com' },
  SPU: { dep: 'https://www.split-airport.hr/', name: 'split-airport.hr' },
  BSL: { dep: 'https://www.euroairport.com/en/vols-au-depart', arr: 'https://www.euroairport.com/en/vols-a-l-arrivee', name: 'euroairport.com' },
  BRN: { dep: 'https://www.bernairport.ch/en/', name: 'bernairport.ch' },
  FKB: { dep: 'https://www.baden-airpark.de/passagiere-besucher/fluege/tagesaktueller-flugplan/', name: 'baden-airpark.de' },
  MST: { dep: 'https://www.maa.nl/en/flights/', name: 'maa.nl' },
};
const siteLink = (iata, dir) => {
  const b = SITE_BOARDS[iata];
  if (!b) return '';
  return `<p class="links"><a href="${esc((dir === 'arr' && b.arr) || b.dep)}" target="_blank" rel="noopener">↗ Tabellone sul sito ufficiale (${esc(b.name)})</a></p>`;
};
const srcTag = x => getSettings().provider !== 'aerodatabox' ? '' : x._officialOnly ? '<small class="src" title="Solo tabellone ufficiale">uff.</small>'
  : x._official ? '<small class="src" title="Tabellone ufficiale + AeroDataBox">uff. + ADB</small>' : '<small class="src" title="Solo AeroDataBox">ADB</small>';

const APP_VERSION = '4.25 · sul telefono le pagine aperte si vedono tutte nel pannello laterale a scomparsa (☰ in alto a sinistra)';
const $app = document.getElementById('app');
let timers = [];
let maps = [];
const clearPage = () => { timers.forEach(clearInterval); timers = []; maps.forEach(m => m.remove()); maps = []; };
// gli aggiornamenti automatici si fermano quando la scheda o l'app non sono in primo piano
const every = (sec, fn) => timers.push(setInterval(() => { if (!document.hidden) fn(); }, sec * 1000));

// ---------- utilità ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hhmm = t => t?.local ? t.local.slice(11, 16) : '—';
const minutesBetween = (a, b) => a?.utc && b?.utc ? Math.round((new Date(b.utc) - new Date(a.utc)) / 60e3) : 0;

const STATUS = {
  Unknown: ['Sconosciuto', 'muted'], Expected: ['Previsto', 'ok'], CheckIn: ['Check-in', 'ok'],
  Boarding: ['Imbarco', 'go'], GateClosed: ['Gate chiuso', 'warn'], Departed: ['Decollato', 'go'],
  EnRoute: ['In volo', 'go'], Approaching: ['In avvicinamento', 'go'], Delayed: ['In ritardo', 'warn'],
  Arrived: ['Atterrato', 'done'], Canceled: ['Cancellato', 'bad'], CanceledUncertain: ['Forse cancellato', 'bad'],
  Diverted: ['Dirottato', 'bad'], OnGround: ['Ancora a terra', 'warn'],
};
const statusBadge = s => { const [t, c] = STATUS[s] || [s, 'muted']; return `<span class="badge ${c}">${esc(t)}</span>`; };
const star = (on, attrs) => `<button class="star ${on ? 'on' : ''}" ${attrs} aria-pressed="${on}" title="${on ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti'}">${on ? '★' : '☆'}</button>`;
const flightDate = f => f.dep?.sched?.local?.slice(0, 10) || isoDate(new Date());
const flightLink = f => `#/flight/${encodeURIComponent(f.number)}/${flightDate(f)}${f.dep?.iata ? `?dep=${f.dep.iata}` : ''}`;
const apName = iata => airportByIata(iata)?.city || iata;
const regHref = (reg, date, ap) => `#/aircraft/${encodeURIComponent(reg)}/${date || isoDate(new Date())}${ap ? `?ap=${ap}` : ''}`;
// marche ipotizzate (ricostruzione delle rotazioni): segno ≈ e spiegazione al passaggio del mouse
const regGuessLink = (x, dir) => {
  const g = x.aircraft.regGuess;
  if (g.sameAs) return g.reg ? `<a class="reglink guess" href="${regHref(g.reg, flightDate(x), x.arr?.iata)}" title="Ipotesi: probabilmente è lo stesso aereo di ${esc(g.sameAs)}${g.to ? ` (andata per ${esc(g.to)} e ritorno)` : ''}">≈ ${esc(g.reg)}</a>` : '';
  if (g.next) {
    // arrivo: aereo che poi riparte con il volo indicato
    const t = `title="Ipotesi: la compagnia non ha ancora indicato l'aereo; probabilmente è quello che poi riparte con ${esc(g.next)}${g.to ? ` per ${esc(g.to)}` : ''}${g.reg ? '' : ' (marche non ancora note)'}"`;
    return g.reg ? `<a class="reglink guess" href="${regHref(g.reg, flightDate(x), x.arr?.iata)}" ${t}>≈ ${esc(g.reg)}</a>`
      : `<a class="reglink guess" href="#/flight/${encodeURIComponent(g.next)}/${g.nextDate || flightDate(x)}?dep=${esc(x.arr?.iata || '')}" ${t}>≈ poi ${esc(g.next)}</a>`;
  }
  const alt = g.alts?.length ? `; oppure ${g.alts.map(a => `quello in arrivo con ${a.via}${a.from ? ` da ${a.from}` : ''}${a.reg ? ` (${a.reg})` : ''}`).join(', ')}, arrivato quasi alla stessa ora` : '';
  const why = (g.basis === 'overnight' ? `rimasto a terra la notte dopo ${g.via}` : g.basis === 'idle' ? `fermo dopo ${g.via}` : `in arrivo con ${g.via}${g.from ? ` da ${g.from}` : ''}`) + alt;
  if (!g.reg) return `<a class="reglink guess" href="#/flight/${encodeURIComponent(g.via)}/${g.viaDate || flightDate(x)}" title="Ipotesi: la compagnia non ha ancora indicato l'aereo; probabilmente è quello ${esc(why)} (marche di quel volo non ancora note)">≈ da ${esc(g.via)}${g.viaDate && g.viaDate < flightDate(x) ? ' di ieri' : ''}</a>`;
  return `<a class="reglink guess" href="${regHref(g.reg, flightDate(x), (dir === 'dep' ? x.dep : x.arr)?.iata)}" title="Ipotesi: la compagnia non ha ancora indicato l'aereo; probabilmente è quello ${esc(why)}">≈ ${esc(g.reg)}</a>`;
};
const regLink = (reg, date, ap) => `<a class="reglink" href="${regHref(reg, date, ap)}" title="Percorso di oggi dell'aereo (si apre in un nuovo tab)">✈︎ ${esc(reg)}</a>`;
// Marche sul tabellone colorate per grado di certezza:
//  sicure (verde: compagnia, tabellone ufficiale, AeroDataBox, FlightAware), incrociate (azzurro: avvistamento ADS-B
//  abbinato all'orario del tabellone), dedotte affidabili (giallo: andata e ritorno), dedotte deboli (grigio)
const REG_LEVELS = {
  sure: ['sicure', 'indicate dalla compagnia o da un tabellone ufficiale'],
  cross: ['incrociate', 'aereo visto dalla rete ADS-B atterrare/decollare all’orario del tabellone'],
  likely: ['dedotte, probabili', 'probabilità 70% o più: di solito andata e ritorno con lo stesso aereo'],
  weak: ['dedotte, incerte', 'probabilità tra 35% e 70%'],
  faint: ['molto incerte', 'probabilità sotto il 35%: ipotesi costruite su altre ipotesi, o giri della compagnia poco prevedibili'],
};
// probabilità di un'ipotesi (calcolata in api.js e moltiplicata lungo la catena)
const guessP = g => g?.p ?? (g?.basis === 'return' ? 0.85 : 0.3);
const regLevelOf = x => x.aircraft?.reg ? (/ADS-B/.test(x.aircraft.regSrc || '') ? 'cross' : 'sure') : x.aircraft?.regGuess ? (guessP(x.aircraft.regGuess) >= 0.7 ? 'likely' : guessP(x.aircraft.regGuess) >= 0.35 ? 'weak' : 'faint') : null;
function boardReg(x, dir) {
  const lv = regLevelOf(x);
  if (!lv) return esc(x.airline?.name || '');
  const ap = (dir === 'dep' ? x.dep : x.arr)?.iata;
  if (lv === 'sure' || lv === 'cross') {
    const src = x.aircraft.regSrc ? ` · fonte: ${x.aircraft.regSrc}` : '';
    return `<a class="reglink lv-${lv}" href="${regHref(x.aircraft.reg, flightDate(x), ap)}" title="Marche ${REG_LEVELS[lv][0]}${esc(src)}">✈︎ ${esc(x.aircraft.reg)}</a>`;
  }
  const link = regGuessLink(x, dir);
  if (!link) return esc(x.airline?.name || '');
  const pct = Math.round(guessP(x.aircraft.regGuess) * 100);
  return link.replace('class="reglink guess"', `class="reglink guess lv-${lv}"`).replace('title="', `title="Marche ${REG_LEVELS[lv][0]} (probabilità circa ${pct}%). `)
    .replace(/<\/a>$/, ` <i class="pct">${pct}%</i></a>`)
    + (x.aircraft.regGuess.alts?.some(a => a.reg && a.reg !== x.aircraft.regGuess.reg) ? ` <span class="altreg" title="Altro aereo possibile, arrivato quasi alla stessa ora">o ${x.aircraft.regGuess.alts.filter(a => a.reg && a.reg !== x.aircraft.regGuess.reg).map(a => esc(a.reg)).join(' / ')}</span>` : '');
}
const regLegend = () => `<p class="hint reglegend">Marche: ${Object.entries(REG_LEVELS).map(([k, [l, d]]) => `<span class="lv-${k}" title="${esc(d)}">● ${l}</span>`).join(' ')}</p>`;
function aircraftCard(ac, date, note = '', probable = false) {
  const tag = !ac?.reg ? '' : probable ? ' · <span class="regtag guess">❔ marche ipotizzate</span>' : ' · <span class="regtag sure">✅ marche sicure</span>';
  if (ac?.reg && !probable && !note && ac.regSrc) note = `Indicate da: ${esc(ac.regSrc)}.`;
  return `<span class="eyebrow">Aeromobile${tag}</span>
    <p>${ac?.reg ? `${regLink(ac.reg, date)} · <a href="${regHref(ac.reg, date)}">segui l'aereo e i suoi voli del giorno</a>` : '<b>Non ancora assegnato</b>'}${ac?.model ? ` · ${esc(ac.model)}` : ''}${ac?.hex ? ` · ICAO24 <code>${esc(ac.hex)}</code>` : ''}</p>
    ${note ? `<p class="hint">${note}</p>` : ''}`;
}
const errorBox = e => `<div class="error">⚠️ ${esc(e.message || e)}</div>`;
// riquadro "Fonti" in fondo a ogni pagina
const isDemo = () => getSettings().provider !== 'aerodatabox';
const POS_SRC = 'posizione in tempo reale: AeroDataBox quando disponibile, altrimenti le reti ADS-B <b>adsb.lol</b> e <b>OpenSky Network</b> (la fonte usata è scritta sopra la mappa)';
const MAP_SRC = 'mappa: © OpenStreetMap';
const pageSources = items => `<footer class="pagesources"><b>Fonti dei dati di questa pagina</b><ul>${items.filter(Boolean).map(i => `<li>${i}</li>`).join('')}</ul></footer>`;
const DEMO_SRC = 'voli <b>dimostrativi</b> generati dall’app (modalità demo): nessun dato è reale. Per i dati veri vai in <a href="#/settings">Impostazioni</a>';
const fmtDur = m => m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`;

// ritardo anomalo: orario in rosso, col ritardo indicato, e riga spostata all'orario stimato nel tabellone
const LATE_RED_MIN = 60;
const fmtDelay = m => (m >= 60 ? `+${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, '0')}` : ''}` : `+${m} min`);
function timeCell(sched, revised, actual) {
  const best = actual || revised;
  const d = minutesBetween(sched, best);
  if (best && d >= LATE_RED_MIN) return `<s>${hhmm(sched)}</s> <b class="late verylate" title="Ritardo di ${d} minuti">${hhmm(best)}</b><small class="delay">${fmtDelay(d)}</small>`;
  if (best && Math.abs(d) >= 5) return `<s>${hhmm(sched)}</s> <b class="${d > 0 ? 'late' : 'early'}">${hhmm(best)}</b>`;
  return `<b>${hhmm(sched)}</b>`;
}

function bindStars(root, rerender) {
  root.querySelectorAll('[data-fav]').forEach(b => b.addEventListener('click', e => {
    e.preventDefault(); e.stopPropagation();
    toggleFavorite(b.dataset.fav, JSON.parse(b.dataset.item));
    rerender ? rerender() : route();
  }));
}
const favAttrs = (type, item) => `data-fav="${type}" data-item='${esc(JSON.stringify(item))}'`;

// ---------- ricerca ----------
function searchBox() {
  return `<form class="search" id="search" autocomplete="off">
    <input id="q" type="search" placeholder="FCO, Milano, FR1234, EI-DCL…" aria-label="Cerca aeroporto o volo">
    <button>Cerca</button>
    <ul id="suggest" class="suggest" hidden></ul>
  </form>`;
}
function bindSearch() {
  const form = document.getElementById('search'), q = document.getElementById('q'), sug = document.getElementById('suggest');
  q.addEventListener('input', () => {
    const res = searchAirports(q.value);
    sug.hidden = !res.length;
    sug.innerHTML = res.map(a => `<li><a href="#/airport/${a.iata}/dep"><b>${a.iata}</b> ${esc(a.name)} <small>${esc(a.city)}</small></a></li>`).join('');
  });
  form.addEventListener('submit', e => {
    e.preventDefault();
    const v = q.value.trim().toUpperCase().replace(/\s+/g, '');
    if (!v) return;
    if (/^[A-Z0-9]{1,2}-[A-Z0-9]{2,5}$/.test(v) || /^N\d{1,5}[A-Z]{0,2}$/.test(v)) { location.hash = `#/aircraft/${v}/${isoDate(new Date())}`; return; }
    if (/^[A-Z0-9]{2}\d{1,4}[A-Z]?$/.test(v) && !/^[A-Z]{3}$/.test(v)) location.hash = `#/flight/${v}/${isoDate(new Date())}`;
    else {
      // codice IATA noto, poi nome (anche parziale, in qualunque lingua), infine un codice IATA non in elenco
      const a = airportByIata(v) || searchAirports(q.value)[0];
      if (a) location.hash = `#/airport/${a.iata}/dep`;
      else if (/^[A-Z]{3}$/.test(v)) location.hash = `#/airport/${v}/dep`;
    }
  });
}

// ---------- Home / preferiti ----------
let reorderType = null; // categoria di preferiti in modalità riordino

function bindReorder() {
  $app.querySelectorAll('[data-reorder]').forEach(b => b.onclick = () => {
    reorderType = reorderType === b.dataset.reorder ? null : b.dataset.reorder; viewHome();
  });
  const box = $app.querySelector('.sorting');
  if (!box) return;
  const type = box.dataset.type;
  const save = () => reorderFavorites(type, [...box.querySelectorAll('.sortable')].map(c => c.dataset.key));
  box.querySelectorAll('.mv').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const c = b.closest('.sortable');
    if (b.dataset.mv === '-1') c.previousElementSibling?.before(c); else c.nextElementSibling?.after(c);
    save(); viewHome();
  });
  // trascinamento: mouse/penna con Pointer Events, dito con Touch Events (su Safari iOS i pointer
  // vengono annullati appena la pagina prova a scorrere, i touch con preventDefault no)
  // il tile segue il dito/mouse; gli altri scivolano al nuovo posto (animazione FLIP)
  let drag = null;
  const follow = (x, y) => {
    const c = drag.c;
    c.style.transform = '';
    const r = c.getBoundingClientRect();
    c.style.transform = `translate(${x - drag.gx - r.left}px, ${y - drag.gy - r.top}px) scale(1.03)`;
  };
  const place = (x, y) => {
    const c = drag.c;
    const t = document.elementFromPoint(x, y)?.closest('.sortable'); // il tile trascinato ha pointer-events: none
    if (!t || t === c || t.parentNode !== box) return;
    const r = t.getBoundingClientRect();
    // in colonna singola (telefono) conta la metà alta/bassa, in griglia la metà sinistra/destra
    const after = r.width > box.clientWidth * 0.7 ? y > r.top + r.height / 2 : x > r.left + r.width / 2;
    if (after ? t.nextElementSibling === c : t.previousElementSibling === c) return;
    const others = [...box.querySelectorAll('.sortable')].filter(o => o !== c);
    const before = new Map(others.map(o => [o, o.getBoundingClientRect()]));
    after ? t.after(c) : t.before(c);
    drag.moved = true;
    others.forEach(o => {
      const p = before.get(o), q = o.getBoundingClientRect();
      const dx = p.left - q.left, dy = p.top - q.top;
      if (!dx && !dy) return;
      o.style.transition = 'none'; o.style.transform = `translate(${dx}px, ${dy}px)`;
      o.getBoundingClientRect();
      o.style.transition = 'transform .18s ease'; o.style.transform = '';
    });
  };
  const start = (c, x, y) => {
    const r = c.getBoundingClientRect();
    drag = { c, gx: x - r.left, gy: y - r.top, moved: false };
    c.classList.add('dragging');
    navigator.vibrate?.(10);
  };
  const moveTo = (x, y) => { if (!drag) return; place(x, y); follow(x, y); };
  const drop = () => {
    if (!drag) return;
    const { c, moved } = drag; drag = null;
    c.style.transition = 'transform .15s ease'; c.style.transform = '';
    setTimeout(() => { c.classList.remove('dragging'); c.style.transition = ''; if (moved) { save(); viewHome(); } }, 160);
  };
  box.querySelectorAll('.sortable').forEach(c => {
    // la pressione lunga di Android (vibrazione, menu, selezione) annullerebbe il trascinamento
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('touchstart', e => {
      if (e.target.closest('.mv') || e.touches.length !== 1 || drag) return;
      e.preventDefault(); // niente pressione lunga, scorrimento o click simulati: il tile resta "in mano"
      start(c, e.touches[0].clientX, e.touches[0].clientY);
      const move = ev => { ev.preventDefault(); moveTo(ev.touches[0].clientX, ev.touches[0].clientY); };
      const end = () => {
        removeEventListener('touchmove', move); removeEventListener('touchend', end); removeEventListener('touchcancel', end);
        drop();
      };
      // ascolto su window: il nodo viene spostato nel DOM durante il trascinamento
      addEventListener('touchmove', move, { passive: false }); addEventListener('touchend', end); addEventListener('touchcancel', end);
    }, { passive: false });
    c.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch' || e.target.closest('.mv') || e.button > 0 || drag) return;
      e.preventDefault();
      start(c, e.clientX, e.clientY);
      const move = ev => moveTo(ev.clientX, ev.clientY);
      const up = () => {
        removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
        drop();
      };
      addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
    });
  });
}

const POPULAR = {
  Italia: ['FCO', 'MXP', 'LIN', 'BGY', 'VCE', 'BLQ', 'PSA', 'NAP', 'CTA', 'PMO', 'TRN', 'CAG'],
  Europa: ['LHR', 'CDG', 'AMS', 'FRA', 'MUC', 'ZRH', 'MAD', 'BCN', 'LIS', 'VIE'],
};
function viewHome() {
  const fav = getFavorites();
  const hasWorker = !isDemo() && !!(getSettings().workerUrl || '').trim();
  const offDot = c => hasWorker && OFFICIAL_AIRPORTS[c] ? '<i class="dot go" title="Tabellone ufficiale dell’aeroporto collegato"></i>' : '';
  const today = isoDate(new Date());
  // un gruppo di preferiti: titolo con icona, pulsante Riordina e griglia di riquadri.
  // tile(item) → { href, code, name, links, item } (item = oggetto per la stella)
  const group = (type, icon, title, items, tile) => {
    if (!items?.length) return '';
    const on = reorderType === type;
    const btn = items.length > 1 ? `<button type="button" class="ghost reorder-btn" data-reorder="${type}">${on ? 'Fatto' : '⇅ Riordina'}</button>` : '';
    const card = (it, i) => {
      const t = tile(it);
      const head = `<b class="code">${t.code}</b><span class="name">${t.name}</span>`;
      if (on) return `<div class="tile sortable" data-key="${esc(favKey(type, it))}"><span class="grip" aria-hidden="true">⠿</span><div class="tmain">${head}</div>
        <div class="mvs"><button type="button" class="mv" data-mv="-1" ${i === 0 ? 'disabled' : ''} title="Sposta prima" aria-label="Sposta prima">◀</button><button type="button" class="mv" data-mv="1" ${i === items.length - 1 ? 'disabled' : ''} title="Sposta dopo" aria-label="Sposta dopo">▶</button></div></div>`;
      return `<div class="tile"><a class="tmain" href="${t.href}"${t.title ? ` title="${t.title}"` : ''}>${head}</a>${star(true, favAttrs(type, t.item))}
        ${t.links ? `<div class="tlinks">${t.links}</div>` : ''}</div>`;
    };
    return `<div class="favgroup" style="--n:${Math.min(items.length, 4)}">
      <h3><span class="gicon" aria-hidden="true">${icon}</span>${title} <small>${items.length}</small>${btn}</h3>
      ${on ? '<p class="hint">Trascina i riquadri (o usa le frecce) per cambiare l’ordine, poi tocca <b>Fatto</b>.</p>' : ''}
      <div class="tiles${on ? ' sorting noswipe' : ''}" data-type="${type}">${items.map(card).join('')}</div></div>`;
  };
  const favCount = fav.airports.length + fav.routes.length + fav.flights.length + (fav.aircraft?.length || 0);
  const ntabs = openTabsCount();
  $app.innerHTML = `
    <section class="homehero">
      <h1>Voli e tabelloni in tempo reale</h1>
      <p class="sub">Cerca un aeroporto per il tabellone, un volo per seguirlo, la marca di un aereo per il suo percorso di oggi.</p>
      ${searchBox()}
    </section>
    ${favCount ? `<section class="homesec">
      <h2>I tuoi preferiti</h2><div class="favgroups">
      ${group('airports', '🛫', 'Aeroporti', fav.airports, a => ({ item: { iata: a.iata }, href: `#/airport/${a.iata}/dep`,
        code: `${offDot(a.iata)}${a.iata}`, name: esc(a.name || apName(a.iata)),
        links: `<a href="#/airport/${a.iata}/dep">Partenze</a><a href="#/airport/${a.iata}/arr">Arrivi</a>` }))}
      ${group('flights', '✈️', 'Voli', fav.flights, f => ({ item: { number: f.number, dep: f.dep, arr: f.arr },
        href: `#/flight/${encodeURIComponent(f.number)}/${today}${f.dep ? `?dep=${f.dep}` : ''}`, title: 'Apre sempre il volo di oggi con questo numero',
        code: esc(f.number), name: f.dep && f.arr ? `${esc(apName(f.dep))} → ${esc(apName(f.arr))}` : 'volo',
        links: `<span>${f.dep && f.arr ? `${f.dep} → ${f.arr} · ` : ''}oggi</span>` }))}
      ${group('routes', '🔁', 'Tratte', fav.routes, r => ({ item: { from: r.from, to: r.to }, href: `#/route/${r.from}/${r.to}`,
        code: `${r.from} → ${r.to}`, name: `${esc(apName(r.from))} – ${esc(apName(r.to))}`,
        links: `<a href="#/route/${r.from}/${r.to}">Andata</a><a href="#/route/${r.to}/${r.from}">Ritorno</a>` }))}
      ${group('aircraft', '🛩️', 'Aerei', fav.aircraft, a => ({ item: { reg: a.reg }, href: regHref(a.reg),
        code: esc(a.reg), name: esc(a.model || 'aeromobile'), links: '<span>percorso di oggi</span>', title: 'Percorso di oggi dell’aereo' }))}
    </div></section>` : `<section class="homesec">
      <h2>Come si usa</h2>
      <ol class="steps">
        <li><b>Cerca</b><span>un aeroporto (FCO, Milano…), un volo (FR1234) o un aereo (EI-DCL).</span></li>
        <li><b>Apri</b><span>ogni pagina resta in un tab in alto, così passi al volo dal tabellone ai voli che segui${matchMedia('(pointer: coarse)').matches ? ' (anche scorrendo col dito); per spostare un tab tienilo premuto e trascinalo' : '; per spostare un tab trascinalo col mouse'}.</span></li>
        <li><b>Salva</b><span>tocca ☆ per ritrovare qui aeroporti, tratte, voli e aerei.</span></li>
      </ol>
    </section>`}
    <section class="homesec">
      <h2>Aeroporti principali</h2>
      ${Object.entries(POPULAR).map(([area, codes]) => `<div class="favgroup"><h3>${area}</h3>
        <div class="apgrid">${codes.map(c => `<a class="aptile" href="#/airport/${c}/dep"><b>${offDot(c)}${c}</b><span>${esc(apName(c))}</span></a>`).join('')}</div></div>`).join('')}
      ${hasWorker ? '<p class="hint"><i class="dot go"></i> tabellone ufficiale dell’aeroporto collegato</p>' : ''}
    </section>
    ${ntabs ? `<p class="hint opentabs">${ntabs} ${ntabs === 1 ? 'pagina aperta' : 'pagine aperte'} nelle schede · <button class="linkbtn" type="button" id="closetabs">chiudi tutti</button></p>` : ''}
    ${pageSources(isDemo() ? [DEMO_SRC, MAP_SRC] : [
      `tabelloni: per ${Object.keys(OFFICIAL_AIRPORTS).length} aeroporti il <b>tabellone ufficiale</b> dell’aeroporto${hasWorker ? ' (pallino verde)' : ' (si attiva con il Worker in Impostazioni)'}, che ha la priorità ed è sempre completato con <b>AeroDataBox</b>; per gli altri aeroporti solo AeroDataBox. L’elenco completo è in <a href="#/settings">Impostazioni</a>`,
      POS_SRC, MAP_SRC, 'preferiti e tab aperti: salvati solo in questo browser'])}`;
  bindSearch();
  bindStars($app, viewHome);
  bindReorder();
  const ct = document.getElementById('closetabs');
  if (ct) ct.onclick = () => { closeAllTabs(); viewHome(); };
}

// ---------- Tabellone ----------
// voli già partiti/arrivati nascosti in cima al tabellone (si mostrano con un tocco); ricordato per tabellone
const showPast = new Set();
// posizione nel tabellone: l'orario mostrato (effettivo, altrimenti stimato, altrimenti programmato), così la
// linea "adesso" cade davvero all'ora attuale anche con voli in ritardo; i cancellati restano all'orario programmato
function boardMs(x, dir) {
  const s = dir === 'dep' ? x.dep : x.arr, t = Date.parse(s?.sched?.utc || '');
  if (x.status === 'Canceled') return t;
  const b = Date.parse((s?.actual || s?.revised)?.utc || '');
  return b || t;
}
// tabellone vuoto: invece del solo "Nessun volo" dico qual è stato l'ultimo volo, qual è il prossimo (se il
// tabellone ufficiale lo ha già) e perché i voli di domani possono mancare; un pulsante mostra gli ultimi voli
function emptyBoardHtml(dir, ctx, degraded) {
  const base = 'Nessun volo nella finestra da 2 ore fa a 10 ore avanti.';
  if (!ctx) return `<p class="hint">${base}</p>`;
  const dep = dir === 'dep', other = f => (dep ? f.arr : f.dep), side = f => (dep ? f.dep : f.arr);
  const dayWord = d => { const n = Math.round((Date.parse(d) - Date.parse(ctx.today)) / 86400e3); return n === 0 ? 'oggi' : n === -1 ? 'ieri' : n === 1 ? 'domani' : `il ${d.slice(8, 10)}/${d.slice(5, 7)}`; };
  const when = f => `${dayWord(side(f).sched.local.slice(0, 10))} alle ${fmtLocalLike(boardMs(f, dir), side(f).sched)}`;
  const what = f => `${esc(f.number)} ${dep ? 'per' : 'da'} ${esc(other(f)?.name || other(f)?.iata || '?')}${f.status === 'Canceled' ? ' (cancellato)' : ''}`;
  const lines = [base];
  const last = ctx.earlier.at(-1), next = ctx.later[0];
  if (last) lines.push(`${dep ? 'Ultima partenza' : 'Ultimo arrivo'}: <b>${when(last)}</b>, ${what(last)}.`);
  if (next) lines.push(`${dep ? 'Prossima partenza' : 'Prossimo arrivo'}: <b>${when(next)}</b>, ${what(next)}.`);
  else if (ctx.lastDay && ctx.lastDay <= ctx.today) lines.push(`Il tabellone ufficiale dell’aeroporto non ha ancora i voli di domani (molti aeroporti li pubblicano solo dopo mezzanotte)${degraded ? '; AeroDataBox, che di solito li aggiunge, ora non è disponibile' : ''}.`);
  const n = Math.min(6, ctx.earlier.length);
  const btn = n ? `<button class="pastbtn" type="button" data-showearlier="1">▲ Mostra ${n === 1 ? `l’ultimo volo ${dep ? 'già partito' : 'già arrivato'}` : `gli ultimi ${n} voli ${dep ? 'già partiti' : 'già arrivati'}`}</button>` : '';
  return `<p class="hint">${lines.join('<br>')}</p>${btn}`;
}
function boardTable(list, dir, filter = '', key = '', ctx = null, degraded = null) {
  const f = norm(filter);
  list = list.map((x, i) => [x, boardMs(x, dir) || 0, i]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map(a => a[0]);
  // il filtro trova anche la città in italiano, inglese o lingua locale (es. "Londra" per "London Gatwick")
  let rows = list.filter(x => !f || [x.number, ...(x.codeshares || []), x.airline?.name, x.dep?.iata, x.dep?.name, x.arr?.iata, x.arr?.name, airportSearchText(x.dep?.iata), airportSearchText(x.arr?.iata)].some(v => norm(v).includes(f)));
  if (!rows.length) return f ? '<p class="hint">Nessun volo corrisponde al filtro.</p>' : emptyBoardHtml(dir, ctx, degraded);
  const now = Date.now();
  let marked = false, pastBtn = '';
  if (!f && key && !showPast.has(key)) {
    const DONE = dir === 'dep' ? ['Departed', 'EnRoute', 'Approaching', 'Arrived', 'Canceled', 'Diverted'] : ['Arrived', 'Canceled', 'Diverted'];
    const past = rows.filter(x => { const t = boardMs(x, dir); return t && t < now && DONE.includes(x.status); });
    const hide = new Set(past.slice(0, Math.max(0, past.length - 2)));
    if (hide.size) {
      rows = rows.filter(x => !hide.has(x));
      pastBtn = `<button class="pastbtn" type="button" data-showpast="${esc(key)}">▲ Mostra ${hide.size} voli ${dir === 'dep' ? 'già partiti' : 'già arrivati'} (fino a 2 ore fa)</button>`;
    }
  }
  return `${regLegend()}<div class="board" role="table">${pastBtn}
    <div class="row head" role="row"><span>Ora</span><span>Volo</span><span>${dir === 'dep' ? 'Destinazione' : 'Provenienza'}</span><span>${dir === 'dep' ? 'Gate' : 'Nastro'}</span><span>Stato</span></div>
    ${rows.map(x => {
      const side = dir === 'dep' ? x.dep : x.arr, other = dir === 'dep' ? x.arr : x.dep;
      let nowLine = '';
      if (!marked && boardMs(x, dir) > now) { marked = true; nowLine = '<div class="nowline"><span>adesso</span></div>'; }
      return `${nowLine}<div class="row ${x.status === 'Canceled' ? 'cancel' : ''}" role="row" tabindex="0" data-href="${flightLink(x)}">
        <span class="t">${timeCell(side?.sched, side?.revised, side?.actual)}</span>
        <span class="num"><a href="${flightLink(x)}"><b>${esc(x.number)}</b></a><small>${boardReg(x, dir)}</small></span>
        <span class="dest"><b>${esc(other?.name || other?.iata || '—')}</b><small>${esc(other?.iata || '')}${side?.terminal ? ` · T${esc(side.terminal)}` : ''}${x.codeshares?.length ? ` <button class="csbtn" type="button" title="Anche: ${esc(x.codeshares.join(' '))}">+${x.codeshares.length} code sharing</button>` : ''}</small>${x.codeshares?.length ? `<small class="cslist" hidden>anche ${x.codeshares.map(esc).join(' ')}</small>` : ''}</span>
        <span class="gate">${esc((dir === 'dep' ? side?.gate : side?.belt) || '—')}</span>
        <span>${statusBadge(x.status)}${srcTag(x)}${x._seenAt ? `<small class="src stale" title="Il volo non è più nei dati ricevuti (si chiedono per orario programmato): resta qui per il forte ritardo, con l’ultimo dato">dato di ${ageTag(x._seenAt, 0)}</small>` : ''}</span>
      </div>`;
    }).join('')}
  </div>`;
}

async function viewAirport(iata, dir = 'dep', onlyTo = null) {
  iata = iata.toUpperCase();
  const info = airportByIata(iata) || await getAirportInfo(iata) || { iata, name: iata };
  let data = null, filter = '', updatedHtml = '', updatedTitle = '', emptyCtx = null;
  const isRoute = !!onlyTo;
  const bdir = isRoute ? 'dep' : dir;
  const bkey = isRoute ? `route:${iata}-${onlyTo}` : `${iata}:${dir}`;
  document.title = isRoute ? `${iata} → ${onlyTo} · Voli` : `${iata} ${dir === 'dep' ? 'Partenze' : 'Arrivi'} · Voli`;
  const sources = list => {
    if (isDemo()) return pageSources([DEMO_SRC]);
    const site = OFFICIAL_SOURCES[iata];
    return pageSources([
      OFFICIAL_AIRPORTS[iata] ? `tabellone: <b>tabellone ufficiale dell’aeroporto</b> (${esc(site)}), che ha la priorità per orari, gate, check-in, nastro e stato, completato con <b>AeroDataBox</b>${(getSettings().workerUrl || '').trim() ? '' : ' (si attiva impostando il Worker in Impostazioni; ora si usa solo AeroDataBox)'}` : `tabellone: <b>AeroDataBox</b>${SITE_BOARDS[iata] ? ` (il sito ufficiale ${esc(SITE_BOARDS[iata].name)} non è leggibile in automatico: c’è il link sopra)` : ' (per questo aeroporto non c’è un tabellone ufficiale collegato)'}`,
      (() => { const i = officialInfo[`${iata}:${bdir === 'dep' ? 'D' : 'A'}`] || {}; return i.error ? `⚠ tabellone ufficiale non disponibile: ${esc(i.error)}` : data?.degraded ? `⚠ AeroDataBox non disponibile: ${esc(data.degraded)}` : ''; })(),
      OFFICIAL_AIRPORTS[iata] && list ? boardCounts(list) : '',
      'aggiornamento (scritto sopra il tabellone): il <b>tabellone ufficiale</b> viene riletto dal Worker al massimo ogni 90 secondi; <b>AeroDataBox</b> l’app lo richiede al massimo ogni 15 minuti per risparmiare le unità del piano, quindi può avere qualche minuto in più. L’età diventa arancione quando il dato è più vecchio del solito; “copia di riserva” = il sito ufficiale non risponde e il Worker mostra l’ultima lettura riuscita',
      'sotto lo stato di ogni volo: <b>uff.</b> = solo tabellone ufficiale, <b>uff. + ADB</b> = tabellone ufficiale completato da AeroDataBox, <b>ADB</b> = solo AeroDataBox',
      'orari nell’ora locale dell’aeroporto; in arancione l’orario stimato o effettivo se diverso di almeno 5 minuti, in <b>rosso</b> con il ritardo indicato se è di un’ora o più: i voli in ritardo restano finché non sono partiti/arrivati da più di 2 ore; il tabellone è in ordine di orario stimato o effettivo, così la linea “adesso” cade all’ora attuale',
      list?.some(x => x._seenAt) ? 'voli con “dato di … min fa”: molto in ritardo e non più nei dati ricevuti, tenuti in questo browser con l’ultimo aggiornamento' : '',
      list?.some(x => x.aircraft?.reg) ? 'marche degli aerei (✈︎): tabellone ufficiale o AeroDataBox' : '',
      list?.some(x => x.aircraft?.regGuess && !x.aircraft?.reg) ? 'marche con ≈: <b>ipotesi</b> dell’app, ricostruendo i giri degli aerei della compagnia in questo aeroporto (la compagnia non le ha ancora indicate)' : '',
    ]);
  };
  const render = () => {
    const title = isRoute ? `${iata} → ${onlyTo}` : `${iata}`;
    const favBtn = isRoute ? star(isFavorite('routes', { from: iata, to: onlyTo }), favAttrs('routes', { from: iata, to: onlyTo }))
      : star(isFavorite('airports', { iata }), favAttrs('airports', { iata, name: info.name }));
    const list = data ? (dir === 'dep' ? data.departures : data.arrivals) : [];
    const filtered = isRoute ? list.filter(x => x.arr?.iata === onlyTo) : list;
    $app.innerHTML = `
      <div class="pagehead">
        <div><h1>${esc(title)} ${favBtn}</h1><p class="sub">${esc(isRoute ? `${apName(iata)} – ${apName(onlyTo)} · partenze nelle prossime 10 ore` : info.name)}</p></div>
        <div class="actions"><button class="ghost" id="refresh" title="Aggiorna adesso" aria-label="Aggiorna adesso">↻</button><span class="updated" id="updated" title="${esc(updatedTitle)}">${updatedHtml}</span></div>
      </div>
      ${isRoute ? `<p class="links"><a href="#/route/${onlyTo}/${iata}">Tratta inversa ${onlyTo} → ${iata}</a> · <a href="#/airport/${iata}/dep">Tabellone ${iata}</a></p>` : `
      <div class="tabs">
        <a href="#/airport/${iata}/dep" class="${dir === 'dep' ? 'active' : ''}">🛫 Partenze</a>
        <a href="#/airport/${iata}/arr" class="${dir === 'arr' ? 'active' : ''}">🛬 Arrivi</a>
        <input id="filter" type="search" placeholder="Filtra: città, volo, compagnia" value="${esc(filter)}">
      </div>`}
      ${siteLink(iata, bdir)}
      ${data ? sourcesNote(iata, bdir, list, data.degraded, data.adbAt) : ''}
      <div id="board">${data ? boardTable(filtered, bdir, filter, bkey, emptyCtx, data.degraded) : '<div class="loading">Caricamento tabellone…</div>'}</div>
      ${data ? sources(list) : ''}`;
    bindStars($app, render);
    document.getElementById('refresh').onclick = load;
    const board = document.getElementById('board');
    board.onclick = e => {
      if (e.target.closest('[data-showearlier]') && emptyCtx) { board.innerHTML = boardTable(emptyCtx.earlier.slice(-6), bdir, '', ''); return; }
      const b = e.target.closest('[data-showpast]'); if (b) { showPast.add(b.dataset.showpast); board.innerHTML = boardTable(filtered, bdir, filter, bkey, emptyCtx, data?.degraded); }
    };
    const fi = document.getElementById('filter');
    if (fi) fi.oninput = () => { filter = fi.value; board.innerHTML = boardTable(filtered, bdir, filter, bkey, emptyCtx, data?.degraded); };
  };
  const load = async () => {
    try {
      data = await getBoard(iata);
      // finestra vuota: ultimi e prossimi voli dal tabellone ufficiale completo (per la tratta, solo quella destinazione)
      const shown = dir === 'dep' || isRoute ? data.departures : data.arrivals;
      emptyCtx = null;
      if (OFFICIAL_AIRPORTS[iata] && !(isRoute ? shown.filter(x => x.arr?.iata === onlyTo) : shown).length) {
        emptyCtx = await boardContext(iata, bdir === 'dep' ? 'D' : 'A').catch(() => null);
        if (emptyCtx && isRoute) for (const k of ['earlier', 'later']) emptyCtx[k] = emptyCtx[k].filter(x => x.arr?.iata === onlyTo);
      }
      const mine = data;
      // marche ipotizzate per le partenze senza aereo (in sottofondo, poi ridisegno il tabellone)
      guessBoardRegs(iata, data).then(n => { if (n && data === mine && document.getElementById('board')) render(); }).catch(() => {});
      const keep = document.getElementById('filter') === document.activeElement;
      render();
      if (keep) { const fi = document.getElementById('filter'); fi.focus(); fi.setSelectionRange(fi.value.length, fi.value.length); }
      // età del dato principale: tabellone ufficiale se usato, altrimenti AeroDataBox
      const k = `${iata}:${bdir === 'dep' ? 'D' : 'A'}`, oa = !isDemo() && !officialInfo[k]?.error ? boardAge[k] : null;
      const main = oa?.at || data.adbAt;
      updatedHtml = isDemo() || !main ? '' : oa && (oa.stale || oa.snap) ? `⚠ copia di riserva di ${ageTag(oa.at, 0)}` : `aggiornato ${ageTag(main, oa ? OFF_WARN : ADB_WARN)}`;
      updatedTitle = `Ultimo controllo alle ${new Date().toLocaleTimeString('it-IT')}; nuovo controllo automatico ogni ${getSettings().refreshSec} secondi. L’età di ogni fonte è scritta sotto, accanto alle fonti.`;
      const u = document.getElementById('updated');
      if (u) { u.innerHTML = updatedHtml; u.title = updatedTitle; }
    } catch (e) {
      // aggiornamento fallito: se ho già un tabellone lo lascio e lo segnalo, altrimenti mostro l'errore
      const u = document.getElementById('updated');
      if (data?.departures?.length || data?.arrivals?.length) { updatedHtml = `${updatedHtml ? `${updatedHtml} · ` : ''}nuovo controllo non riuscito, riprovo`; if (u) { u.innerHTML = updatedHtml; u.title = e.message || String(e); } }
      else document.getElementById('board').innerHTML = errorBox(e);
    }
  };
  render();
  await load();
  every(getSettings().refreshSec, load);
}


// ---------- ritardo previsto dalla rotazione dell'aereo ----------
const LOWCOST = ['FR', 'U2', 'W6', 'VY', 'EW', 'HV', 'DY', 'V7'];
function fmtLocalLike(ms, ref) {
  const m = /([+-])(\d\d):(\d\d)$/.exec(ref?.local || '');
  const off = m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) : -new Date(ms).getTimezoneOffset();
  const d = new Date(ms + off * 60e3);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
function predictionHtml(f, inbound, etaMs, etaSource) {
  // niente previsione se l'aereo in arrivo è solo una stima dell'app: darebbe ritardi inesistenti
  if (!inbound || inboundIsGuess(inbound) || ['Departed', 'EnRoute', 'Approaching', 'Arrived', 'Canceled'].includes(f.status)) return '';
  const arrMs = etaMs ?? tms(inbound.arr.actual || inbound.arr.revised || inbound.arr.sched);
  const schedMs = tms(f.dep.sched), declMs = tms(f.dep.revised) || schedMs;
  if (!arrMs || !schedMs) return '';
  const minTurn = LOWCOST.includes(f.airline?.iata || f.number.slice(0, 2)) ? 25 : 40;
  const predMs = Math.max(schedMs, arrMs + minTurn * 60e3);
  const delay = Math.round((predMs - schedMs) / 60e3), extra = Math.round((predMs - declMs) / 60e3);
  if (delay < 5 || extra < 5) return '';
  const landed = !!inbound.arr.actual || inbound.status === 'Arrived';
  return `<div class="card predict"><span class="eyebrow">Ritardo previsto</span>
    <p><b class="late">circa ${delay} min</b>: partenza stimata non prima delle <b>${fmtLocalLike(predMs, f.dep.sched)}</b>${tms(f.dep.revised) && tms(f.dep.revised) !== schedMs ? ` (la compagnia indica ${hhmm(f.dep.revised)})` : ' (la compagnia indica ancora in orario)'}.</p>
    <p class="hint">L'aereo ${esc(inbound.aircraft?.reg || '')} ${landed ? 'è atterrato' : 'atterra'} a ${esc(f.dep.iata)} alle ${fmtLocalLike(arrMs, f.dep.sched)}${etaSource ? ` (stima da ${esc(etaSource)})` : ''} e per una rotazione servono almeno ${minTurn} minuti.</p></div>`;
}

const guessed = new WeakSet();
const inboundIsGuess = x => guessed.has(x);

// ---------- Dettaglio volo ----------
const planeIcon = track => L.divIcon({ className: 'plane', html: `<div style="transform:rotate(${(track || 0) - 45}deg)">✈︎</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
const apIcon = code => L.divIcon({ className: 'apmark', html: `<span>${esc(code)}</span>`, iconSize: [40, 18], iconAnchor: [20, 9] });

function arc(a, b) { return Array.from({ length: 65 }, (_, i) => greatCircle(a, b, i / 64)).map(p => [p.lat, p.lon]); }

function progress(f) {
  if (!['Departed', 'EnRoute', 'Approaching', 'Arrived'].includes(f.status)) return 0;
  const s = new Date((f.dep.actual || f.dep.revised || f.dep.sched)?.utc), e = new Date((f.arr.revised || f.arr.sched)?.utc);
  if (isNaN(s) || isNaN(e)) return 0;
  return Math.max(0, Math.min(1, (Date.now() - s) / (e - s)));
}

// età della posizione: oltre 2 minuti senza segnale l'aereo può essere già altrove
const posAge = pos => { const t = Date.parse(pos?.at || ''); return t ? ` · posizione di ${ageTag(t, 2)}` : ''; };
function legSources(f) {
  if (getSettings().provider !== 'aerodatabox') return 'Fonte: dati dimostrativi.';
  const bySite = new Map();
  for (const s of [f.dep, f.arr].filter(s => s?._off)) { const n = OFFICIAL_SOURCES[s._off] || s._off; if (!bySite.has(n) || (s._offAt || 0) > (bySite.get(n)._offAt || 0)) bySite.set(n, s); }
  const sites = [...bySite].map(([n, s]) => `${esc(n)}${s._offAt ? ` (${offAgeSide(s)})` : ''}`);
  const at = f._adb ? f._adbAt : f._fa ? f._faAt : null;
  const api = (f._adb ? 'AeroDataBox' : f._fa ? 'FlightAware' : '') + (at ? ` (aggiornato ${ageTag(at, ADB_WARN)})` : '');
  if (!sites.length) return api ? `Fonte: ${api}.` : 'Fonte: tabellone ufficiale dell’aeroporto.';
  return `Fonti: ${sites.join(', ')}${api ? ` + ${api}` : ''}.`;
}

// "Parte tra 40 min", "Atterra tra 1 h 05 min", "Atterrato alle 12:06"
function etaText(f) {
  if (f.status === 'Canceled') return '';
  const now = Date.now();
  const dep = tms(f.dep?.actual) || tms(f.dep?.revised) || tms(f.dep?.sched);
  const arr = tms(f.arr?.actual) || tms(f.arr?.revised) || tms(f.arr?.sched);
  if (f.arr?.actual) return `Atterrato alle <b>${hhmm(f.arr.actual)}</b>`;
  if (f.status === 'Arrived') return 'Atterrato';
  if (AIR.includes(f.status) && arr) { const m = Math.round((arr - now) / 60e3); return m > 0 ? `Atterra tra <b>${fmtDur(m)}</b>` : 'In atterraggio'; }
  if (dep && dep > now && !AIR.includes(f.status)) return `Parte tra <b>${fmtDur(Math.round((dep - now) / 60e3))}</b>`;
  return '';
}

// Affidabilità misurata col test automatico (tools/backtest.mjs) sugli aeroporti che pubblicano le marche
const guessReliability = r => {
  const pct = r.p != null ? Math.round(r.p * 100) : null, tail = pct != null ? ` Probabilità stimata: <b>circa ${pct}%</b>${r.chain ? ' (ipotesi costruita su un’altra ipotesi: le probabilità si moltiplicano)' : ''}.` : '';
  if (r.basis === 'return' && !r.chain) return `<b>Stima affidabile</b>: nel nostro test l'andata e ritorno è giusta circa 9 volte su 10.${tail}`;
  return `<b>Stima ${pct != null && pct < 35 ? 'molto incerta' : 'meno sicura'}</b>: senza un andata e ritorno evidente dipende da come la compagnia fa girare gli aerei; per le low cost nelle loro basi è spesso giusta, negli hub delle compagnie tradizionali molto meno.${tail}`;
};

/** Spiegazione della stima dell'aereo in arrivo (ricostruzione della giornata della compagnia). */
function guessText(f, inbound, r) {
  const name = esc(f.airline?.name || ''), ap = esc(f.dep.iata), from = esc(inbound.dep.iata || '?');
  const h = Math.round((r.waitMin || 0) / 60);
  switch (r.basis) {
    case 'return': return `Questo è il suo volo in arrivo da ${from} poco prima della partenza: le low cost di solito fanno andata e ritorno con lo stesso aereo.`;
    case 'overnight': return `Ricostruendo la giornata ${name} a ${ap}, questo aereo è arrivato da ${from} la sera prima, è rimasto a ${ap} per la notte e non risulta ripartito: a questo volo tocca lui.`;
    case 'idle': return `Ricostruendo la giornata ${name} a ${ap}, l'aereo arrivato da ${from} è fermo da circa ${h} ${h === 1 ? 'ora' : 'ore'} ed è il primo libero per questo volo.`;
    default: return `Ricostruendo la giornata ${name} a ${ap} (ogni partenza usa un aereo arrivato almeno 25-35 minuti prima), a questo volo tocca quello in arrivo da ${from}.`;
  }
}

function legCard(f, title, cls = '') {
  const p = progress(f);
  const dur = minutesBetween(f.dep?.sched, f.arr?.sched), eta = etaText(f);
  return `<div class="card leg ${cls}">
    <div class="leghead"><span class="eyebrow">${title}</span><span>${eta ? `<span class="eta">${eta}</span> ` : ''}${statusBadge(f.status)}</span></div>
    <div class="legrow">
      <div class="end"><div class="code">${esc(f.dep.iata || '—')}</div><div class="city">${esc(f.dep.name || '')}</div>
        <div class="time">${timeCell(f.dep.sched, f.dep.revised, f.dep.actual)}</div>
        <dl>${f.dep.terminal ? `<dt>Terminal</dt><dd>${esc(f.dep.terminal)}</dd>` : ''}<dt>Gate</dt><dd class="big">${esc(f.dep.gate || '—')}</dd>${f.dep.checkIn ? `<dt>Check-in</dt><dd>${esc(f.dep.checkIn)}</dd>` : ''}</dl></div>
      <div class="mid"><div class="track"><div class="fill" style="width:${p * 100}%"></div><div class="dot" style="left:${p * 100}%">✈︎</div></div>
        <small>${esc(f.number)}${f.aircraft?.model ? ` · ${esc(f.aircraft.model)}` : ''}</small>${dur > 0 ? `<small class="dur">durata prevista ${fmtDur(dur)}</small>` : ''}</div>
      <div class="end right"><div class="code">${esc(f.arr.iata || '—')}</div><div class="city">${esc(f.arr.name || '')}</div>
        <div class="time">${timeCell(f.arr.sched, f.arr.revised, f.arr.actual)}</div>
        <dl>${f.arr.terminal ? `<dt>Terminal</dt><dd>${esc(f.arr.terminal)}</dd>` : ''}<dt>Gate</dt><dd>${esc(f.arr.gate || '—')}</dd><dt>Nastro</dt><dd>${esc(f.arr.belt || '—')}</dd></dl></div>
    </div>
    <p class="hint sources">${legSources(f)}</p>
  </div>`;
}

// ---------- notifiche sul volo (🔔) ----------
const NOTIFY_SRC = 'notifiche 🔔: le manda il tuo Worker, che controlla il volo ogni 2 minuti sul <b>tabellone ufficiale</b> degli aeroporti di partenza e arrivo; dove non c’è usa <b>AeroDataBox</b> (con la tua chiave, al massimo 30 chiamate per volo). Ogni notifica scrive la fonte';
const flightDay = f => (f.dep?.sched?.local || '').slice(0, 10);
const bellBtn = f => { const on = !!getWatch(f.number, flightDay(f), f.dep?.iata); return `<button class="bell ${on ? 'on' : ''}" id="bellbtn" aria-pressed="${on}" title="${on ? 'Notifiche attive: modifica' : 'Attiva le notifiche su questo volo'}">${on ? '🔔' : '🔕'}</button>`; };
function bindBell(f, getInb) {
  const btn = document.getElementById('bellbtn'), box = document.getElementById('notify');
  if (!btn || !box) return;
  const paint = () => { const on = !!getWatch(f.number, flightDay(f), f.dep?.iata); btn.classList.toggle('on', on); btn.textContent = on ? '🔔' : '🔕'; btn.setAttribute('aria-pressed', on); };
  const render = (msg = '') => {
    const w = getWatch(f.number, flightDay(f), f.dep?.iata), problem = pushProblem();
    const [inb, guess] = getInb();
    const ended = ['Arrived', 'Canceled'].includes(f.status);
    const evs = w?.events || DEFAULT_EVENTS;
    const off = [f.dep?.iata, f.arr?.iata].filter(c => OFFICIAL_AIRPORTS[c]);
    const needKey = !OFFICIAL_AIRPORTS[f.dep?.iata] || !OFFICIAL_AIRPORTS[f.arr?.iata];
    box.innerHTML = `<span class="eyebrow">Notifiche su questo volo</span>
      ${problem ? `<p class="note warn">${esc(problem)}</p>` : ended && !w ? '<p class="hint">Il volo è già concluso.</p>' : `
      <p class="hint">Avvisi sul telefono o sul computer anche ad app chiusa, per ${esc(f.number)} ${esc(f.dep?.iata || '')}→${esc(f.arr?.iata || '')}${inb ? ` e per l’aereo in arrivo ${esc(inb.number)}${guess ? ' (stima)' : ''}` : ''}. Scegli gli eventi:</p>
      <div class="evlist">${Object.entries(EVENT_LABELS).map(([k, l]) => `${(() => { const na = k.startsWith('inbound') && !inb; return `<label class="check"><input type="checkbox" name="ev" value="${k}" ${evs.includes(k) && !na ? 'checked' : ''} ${na ? 'disabled' : ''}> <span>${esc(l)}${na ? ' <small class="sub">(volo precedente non ancora trovato)</small>' : ''}</span></label>`; })()}`).join('')}</div>
      <p class="hint">Fonti: ${off.length ? `tabellone ufficiale di ${off.join(' e ')}` : 'nessun tabellone ufficiale per questi aeroporti'}${needKey ? `${off.length ? '; per il resto' : ':'} AeroDataBox, al massimo 30 chiamate per volo` : ''}.</p>
      ${needKey ? `<label class="check"><input type="checkbox" id="usekey" ${w?.useKey === false ? '' : 'checked'}> Usa la mia chiave AeroDataBox dal Worker (resta salvata solo nel tuo Worker)</label>` : ''}
      ${w && !w.id ? '<p class="note">Questo volo lo segui da un altro dispositivo collegato: qui le notifiche non sono ancora attive.</p>' : ''}
      <p><button id="nwatch">${w && !w.id ? 'Attiva anche qui' : w ? 'Aggiorna' : 'Attiva le notifiche'}</button> ${w ? '<button class="ghost" id="nstop">Disattiva</button>' : ''}</p>`}
      <div id="nres">${msg}</div>`;
    const go = document.getElementById('nwatch');
    if (go) go.onclick = async () => {
      const events = [...box.querySelectorAll('[name=ev]:checked:not(:disabled)')].map(x => x.value);
      if (!events.length) { render(errorBox('Scegli almeno un evento.')); return; }
      go.disabled = true; document.getElementById('nres').innerHTML = '<p class="hint">Attivo…</p>';
      try {
        const r = await watchFlight(f, inb, guess, events, document.getElementById('usekey')?.checked !== false);
        paint();
        render(r.updated ? '<p class="okmsg">✓ Notifiche aggiornate.</p>' : r.push?.ok ? `<p class="okmsg">✓ Notifiche attive: ti ho mandato una notifica di conferma.${r.renewed ? ' L’iscrizione alle notifiche di questo dispositivo era scaduta: l’ho rinnovata e ho riattivato anche gli altri voli seguiti qui.' : ''}</p>`
          : errorBox(`Volo registrato, ma la notifica di conferma non è partita (${r.push?.status || ''} ${r.push?.error || ''}).`));
      } catch (e) { render(errorBox(e)); }
    };
    const stop = document.getElementById('nstop');
    if (stop) stop.onclick = async () => {
      try { await unwatch(f.number, flightDay(f), f.dep?.iata); paint(); render('<p class="hint">Notifiche disattivate per questo volo.</p>'); } catch (e) { render(errorBox(e)); }
    };
  };
  btn.onclick = () => { box.hidden = !box.hidden; if (!box.hidden) render(); };
}

async function viewFlight(number, date, depHint) {
  $app.innerHTML = `<div class="loading">Cerco il volo ${esc(number)}…</div>`;
  let legs;
  try { legs = await getFlight(number, date, depHint); } catch (e) { $app.innerHTML = errorBox(e); return; }
  if (!legs.length) { $app.innerHTML = `<div class="error">Nessun volo ${esc(number)} trovato il ${esc(date)}.</div><p><a href="#/">← Torna ai preferiti</a></p>`; return; }
  let f = legs.find(l => l.dep?.iata === depHint) || legs[0];
  document.title = `${f.number} ${f.dep?.iata || ''}→${f.arr?.iata || ''} · Voli`;
  const tabInfo = () => setTabInfo(`flight:${number}`, {
    sub: `${date !== isoDate(new Date()) ? `${new Date(`${date}T12:00:00`).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })} · ` : ''}${f.dep?.iata || '?'}→${f.arr?.iata || '?'} · ${hhmm(f.dep?.revised || f.dep?.sched)}`,
    dot: (STATUS[f.status] || [])[1] || 'muted',
  });
  tabInfo();

  const day = d => isoDate(new Date(new Date(`${date}T12:00:00`).getTime() + d * 86400e3));
  $app.innerHTML = `
    <div class="pagehead">
      <div><h1>${esc(f.number)} ${star(isFavorite('flights', { number: f.number }), favAttrs('flights', { number: f.number, dep: f.dep.iata, arr: f.arr.iata }))}${bellBtn(f)}</h1>
      <p class="sub">${esc(f.airline?.name || '')} · ${esc(new Date(`${date}T12:00:00`).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' }))}</p></div>
      <div class="daynav"><a class="ghost" href="#/flight/${encodeURIComponent(number)}/${day(-1)}">‹ Ieri</a><a class="ghost" href="#/flight/${encodeURIComponent(number)}/${day(1)}">Domani ›</a></div>
    </div>
    ${legs.length > 1 ? `<div class="tabs">${legs.map(l => `<a href="#/flight/${encodeURIComponent(number)}/${date}?dep=${l.dep.iata}" class="${l === f ? 'active' : ''}">${l.dep.iata} → ${l.arr.iata}</a>`).join('')}</div>` : ''}
    <p class="links">Tratta <b>${esc(f.dep.iata)} → ${esc(f.arr.iata)}</b> ${star(isFavorite('routes', { from: f.dep.iata, to: f.arr.iata }), favAttrs('routes', { from: f.dep.iata, to: f.arr.iata }))}
      · <a href="#/route/${f.dep.iata}/${f.arr.iata}">altri voli su questa tratta</a> · <a href="#/airport/${f.dep.iata}/dep">tabellone ${esc(f.dep.iata)}</a></p>
    ${f._degraded ? `<p class="hint" title="${esc(f._degraded)}">⚠ AeroDataBox non disponibile ora: ${f._fa ? 'dati da FlightAware, completati con il tabellone ufficiale dove c’è' : 'solo dati del tabellone ufficiale'}.</p>` : ''}
    <div id="notify" class="card notify" hidden></div>
    <div id="predict"></div>
    <div id="leg">${legCard(f, 'Questo volo')}</div>
    <div class="card"><div class="leghead"><span class="eyebrow">Posizione dell'aereo</span><span id="livemeta" class="sub"></span></div><div id="map" class="map"></div></div>
    <div class="card" id="aircraft">${aircraftCard(f.aircraft, date)}</div>
    <div id="inbound"><div class="card"><span class="eyebrow">Da dove arriva l'aereo</span><p class="loading">Cerco la tratta precedente…</p></div></div>
    <div class="card" id="chain"><span class="eyebrow">La giornata dell'aereo</span><p class="loading">Ricostruisco i voli precedenti dell'aereo…</p></div>
    ${pageSources(isDemo() ? [DEMO_SRC, MAP_SRC] : [
      'orari, terminal, gate, check-in, nastro e stato: indicati in fondo a ogni riquadro. Quando c’è il <b>tabellone ufficiale dell’aeroporto</b> (partenza e/o arrivo) ha la priorità per questi dati; il resto viene da <b>AeroDataBox</b> (se non risponde, da <b>FlightAware</b>)',
      f._degraded ? `⚠ AeroDataBox non disponibile: ${esc(f._degraded)}` : '',
      'aereo assegnato e volo precedente: <b>AeroDataBox</b>, poi <b>FlightAware</b>, completati con la rete ADS-B <b>adsb.lol</b>; quando è scritto “probabile” o “stima” è una deduzione dell’app',
      'giornata dell’aereo (in fondo): voli precedenti dalla giornata delle marche se note, altrimenti stimati un anello alla volta come l’aereo in arrivo; le fonti sono scritte sotto l’elenco; ogni volo può avere i suoi avvisi 🔔',
      'ritardo previsto, tempo di rotazione, durata e “parte tra / atterra tra”: calcolati dall’app con gli orari qui sopra',
      NOTIFY_SRC, POS_SRC, MAP_SRC])}`;
  bindStars($app);
  let inbound = null, inboundGuess = false;
  bindBell(f, () => [inbound, inboundGuess]);

  // mappa
  const map = L.map('map', { worldCopyJump: true, zoomControl: true });
  maps.push(map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 12, attribution: '© OpenStreetMap' }).addTo(map);
  const [A, B] = await Promise.all([f.dep.lat != null ? f.dep : getAirportInfo(f.dep.iata), f.arr.lat != null ? f.arr : getAirportInfo(f.arr.iata)]);
  const bounds = [];
  if (A?.lat != null && B?.lat != null) {
    L.polyline(arc(A, B), { color: '#f5b301', weight: 3 }).addTo(map);
    [A, B].forEach((p, i) => { L.marker([p.lat, p.lon], { icon: apIcon(i ? f.arr.iata : f.dep.iata) }).addTo(map); bounds.push([p.lat, p.lon]); });
  }
  if (bounds.length) map.fitBounds(bounds, { padding: [30, 30] }); else map.setView([45, 10], 4);

  // tratta precedente: una sola stima per tutta la pagina (riquadro, aereo assegnato, notifiche e catena dei voli),
  // ricalcolata ogni 5 minuti finché il volo non parte, così segue le informazioni nuove (aereo assegnato, ADS-B, ritardi)
  const hadReg = !!f.aircraft?.reg;
  const inbLayer = L.layerGroup().addTo(map);
  let lastR = null, inbSig = null, chainDone = false;
  const renderInbound = async r => {
    let html = `<div class="card"><span class="eyebrow">Da dove arriva l'aereo</span><p class="hint">${esc(r.reason)}</p></div>`;
    inbLayer.clearLayers();
    if (inbound) {
      const turn = minutesBetween(inbound.arr.revised || inbound.arr.sched, f.dep.revised || f.dep.sched);
      const guess = r.method === 'guess';
      html = `${legCard(inbound, `Da dove arriva l'aereo · ${guess ? 'probabile volo precedente' : 'volo precedente'} <a href="${flightLink(inbound)}">${esc(inbound.number)}</a>`, 'inbound')}
        ${guess ? `<p class="note">ℹ️ Stima: ${esc(f.airline?.name || 'la compagnia')} non ha ancora indicato quale aereo farà il volo. ${guessText(f, inbound, r)} ${guessReliability(r)}</p>` : ''}
        <p class="note ${turn < 35 ? 'warn' : ''}">${turn < 35 ? '⚠️ ' : ''}Tempo di rotazione a ${esc(f.dep.iata)}: <b>${turn} min</b> tra l'arrivo dell'aereo e la partenza prevista${turn < 35 ? ': un ritardo del volo precedente si ripercuoterà probabilmente su questo.' : '.'}</p>`;
      const P = inbound.dep.lat != null ? inbound.dep : await getAirportInfo(inbound.dep.iata);
      if (P?.lat != null && A?.lat != null) {
        L.polyline(arc(P, A), { color: '#7aa2ff', weight: 2, dashArray: '6 6' }).addTo(inbLayer);
        L.marker([P.lat, P.lon], { icon: apIcon(inbound.dep.iata) }).addTo(inbLayer);
        map.fitBounds([...bounds, [P.lat, P.lon]], { padding: [30, 30] });
      }
    }
    const box = document.getElementById('inbound');
    if (!box) return;
    box.innerHTML = html;
    document.getElementById('predict').innerHTML = predictionHtml(f, inbound);
    const card = document.getElementById('aircraft');
    if (inbound && r.method === 'guess' && !f.aircraft?.reg && inbound.aircraft?.reg) {
      card.innerHTML = aircraftCard(inbound.aircraft, date, `Ipotesi: è l'aereo del probabile volo precedente ${esc(inbound.number)} (ricostruzione della giornata della compagnia${inbound.aircraft.regSrc ? `; marche di quel volo da ${esc(inbound.aircraft.regSrc)}` : ''}). ${guessReliability(r)} Diventa sicuro quando la compagnia indica l'aereo.`, true);
    } else if (inbound && r.method === 'reg' && f.aircraft?.reg && !hadReg) {
      card.innerHTML = aircraftCard(f.aircraft, date, r.source === 'FlightAware' ? `Indicate da FlightAware (l'aereo arriva con ${esc(inbound.number)}).` : `La compagnia non lo indica su questo volo, ma la giornata di questo aereo (arrivato con ${esc(inbound.number)}) prevede proprio ${esc(f.number)}.`);
    } else card.innerHTML = aircraftCard(f.aircraft, date);
  };
  // marche ipotizzate prese dalla catena: l'aereo del volo prima del volo precedente, se le sue marche sono sicure
  const chainAircraft = c => {
    if (!c || f.aircraft?.reg || inbound?.aircraft?.reg || lastR?.method !== 'guess') return;
    const legs = c.legs.filter(l => legKey(l) < legKey(f));
    const i = legs.findIndex(l => sameLeg(l, inbound)), up = i > 0 ? legs[i - 1] : null;
    if (!up?.aircraft?.reg || up.aircraft._chain) return;
    const pct = Math.round((up._p ?? 0.3) * 100), card = document.getElementById('aircraft');
    if (card) card.innerHTML = aircraftCard(up.aircraft, date, `Ipotesi dalla catena dei voli qui sotto: l'aereo del probabile volo precedente ${esc(inbound.number)} arriva a ${esc(inbound.dep?.iata || '?')} con ${esc(up.number)}, di cui le marche sono note${up.aircraft.regSrc ? ` (${esc(up.aircraft.regSrc)})` : ''}. <b>Stima molto incerta</b>: probabilità circa ${pct}% (le probabilità della catena si moltiplicano). Diventa sicuro quando la compagnia indica l'aereo.`, true);
  };
  const runChain = async (force = false) => {
    if (!lastR || (chainDone && !force)) return;
    const res = await loadChain(f, inbound, lastR, date);
    chainDone = res?.done; chainAircraft(res?.chain);
  };
  const updateInbound = async () => {
    const r = await getInbound(f, 0, { noChain: true });
    const sig = `${r.inbound?.number || ''}|${r.method || ''}|${r.basis || ''}|${r.inbound?.aircraft?.reg || ''}|${f.aircraft?.reg || ''}|${r.p ?? ''}`;
    lastR = r; inbound = r.inbound; inboundGuess = r.method === 'guess';
    if (inbound && inboundGuess) guessed.add(inbound);
    rememberFlightReg(f, inbound, r);
    saveLink(f, r, linkRank(r, true));
    if (sig === inbSig) return false;
    const changed = inbSig != null;
    inbSig = sig;
    refreshWatch(f, inbound, inboundGuess).catch(() => {});
    await renderInbound(r);
    return changed;
  };
  showChainSnap(f);
  try { await updateInbound(); } catch (e) { document.getElementById('inbound').innerHTML = errorBox(e); }
  if (lastR) runChain(true); else { const cb = document.getElementById('chain'); if (cb) cb.hidden = true; }
  every(300, async () => {
    try {
      // finché il volo non è partito la stima del volo precedente può cambiare; la catena segue
      const gone = ['Departed', 'EnRoute', 'Approaching', 'Arrived', 'Canceled', 'Diverted'].includes(f.status);
      const changed = !gone && await updateInbound();
      await runChain(changed);
    } catch { /* riprova al giro successivo */ }
  });

  // tracking live (stesso aeromobile: se il volo non è partito, si segue sulla tratta precedente)
  let marker = null, trail = null, groundAtDep = false;
  const trailPts = [];
  const live = async () => {
    const meta = document.getElementById('livemeta');
    if (!meta) return;
    let pos = await getLivePosition(f).catch(() => null), on = 'questo volo';
    if (!pos && inbound) { pos = await getLivePosition(inbound).catch(() => null); on = `volo precedente ${inbound.number}`; }
    if (!pos) {
      const s = f.status;
      meta.textContent = s === 'Arrived' ? 'Volo concluso' : s === 'Canceled' ? 'Volo cancellato' : f.aircraft?.hex || getSettings().provider !== 'aerodatabox' ? 'Aereo a terra o fuori copertura' : 'Tracking disponibile quando l’aereo viene assegnato';
      return;
    }
    // aereo a terra: se è all'aeroporto di partenza il volo non è ancora decollato, qualunque cosa dica la compagnia
    if (pos.onGround || (pos.gs != null && pos.gs < 50 && (pos.alt ?? 0) < 1500)) {
      const P = [[f.dep, A], [f.arr, B]].find(([, X]) => X?.lat != null && distanceKm(pos, X) < 8);
      const where = P?.[0]?.iata;
      if (where && where === f.dep.iata && AIR.includes(f.status)) {
        groundAtDep = true; f.status = 'OnGround';
        document.getElementById('leg').innerHTML = legCard(f, 'Questo volo'); tabInfo();
      }
      if (!marker) marker = L.marker([pos.lat, pos.lon], { icon: planeIcon(pos.track), zIndexOffset: 1000 }).addTo(map);
      else marker.setLatLng([pos.lat, pos.lon]).setIcon(planeIcon(pos.track));
      meta.innerHTML = `Aereo a terra${where ? ` a <b>${esc(where)}</b>` : ''}${groundAtDep ? ' · il volo non è ancora decollato' : ''} · fonte ${esc(pos.source)}${posAge(pos)}`;
      return;
    }
    if (groundAtDep && AIR.includes(f.status)) groundAtDep = false;
    if (inbound && !AIR.includes(f.status) && AIR.includes(inbound.status)) {
      on = `volo precedente ${inbound.number}`;
      if (pos.gs > 80 && A?.lat != null) {
        const eta = Date.now() + distanceKm(pos, A) / (pos.gs * 1.852) * 3600e3 + 8 * 60e3;
        const pe = document.getElementById('predict');
        if (pe) pe.innerHTML = predictionHtml(f, inbound, eta, 'posizione ADS-B');
      }
    }
    trailPts.push([pos.lat, pos.lon]);
    if (!marker) { marker = L.marker([pos.lat, pos.lon], { icon: planeIcon(pos.track), zIndexOffset: 1000 }).addTo(map); trail = L.polyline(trailPts, { color: '#38d39f', weight: 3 }).addTo(map); }
    else { marker.setLatLng([pos.lat, pos.lon]).setIcon(planeIcon(pos.track)); trail.setLatLngs(trailPts); }
    meta.innerHTML = `In volo come <b>${esc(on)}</b> · ${pos.alt != null ? `${Math.round(pos.alt).toLocaleString('it-IT')} ft` : ''}${pos.gs != null ? ` · ${Math.round(pos.gs)} kt` : ''} · fonte ${esc(pos.source)}${posAge(pos)}`;
  };
  await live();
  every(15, live);
  // ricarica i dati del volo (gate, orari, stato)
  every(getSettings().refreshSec, async () => {
    try {
      const fresh = (await getFlight(number, date, depHint)).find(l => l.dep?.iata === f.dep.iata);
      if (fresh) { Object.assign(f, fresh); if (groundAtDep && AIR.includes(f.status)) f.status = 'OnGround'; document.getElementById('leg').innerHTML = legCard(f, 'Questo volo'); tabInfo(); }
    } catch { /* riprova al giro successivo */ }
  });
}


// ---------- catena dei voli dell'aereo nella giornata (voli precedenti, con avvisi) ----------
// Con le marche note (sicure o ipotizzate) uso la giornata dell'aereo (AeroDataBox/FlightAware + tabelloni ufficiali
// che pubblicano le marche); altrimenti risalgo un anello alla volta con la stessa stima dell'aereo in arrivo.
const CHAIN_EVENTS = { departed: 'Decollo', landed: 'Atterraggio', delay: 'Ritardi (10 min o più)', cancel: 'Cancellazione o dirottamento' };
const CHAIN_DEFAULT = ['departed', 'landed'];
const CHAIN_MAX_STEPS = 4, CHAIN_MIN_P = 0.06;
const sameLeg = (a, b) => a && b && a.number === b.number && (a.dep?.iata === b.dep?.iata || a.arr?.iata === b.arr?.iata) && Math.abs(legKey(a) - legKey(b)) < 6 * 3600e3;
const copyLeg = l => ({ ...l, dep: { ...l.dep }, arr: { ...l.arr }, aircraft: l.aircraft ? { ...l.aircraft } : undefined });

// Anelli della catena già calcolati (volo → volo precedente), condivisi tra la pagina di un volo e le catene degli
// altri: così aprire BRI→PSA o la catena di PSA→BRI dà lo stesso volo precedente. Vince il calcolo più informato:
// 3 = tratta certa (marche), 2 = stima fatta con FlightAware (pagina del volo o primo anello), 1 = stima senza FlightAware.
const LINKS = 'aerei.chainLinks.v2', LINK_TTL = 30 * 3600e3, LINK_FRESH = 20 * 60e3;
const linkKey = l => `${l.number}|${l.dep?.iata || ''}|${flightDay(l) || (l.arr?.sched?.local || '').slice(0, 10)}`;
const loadLinks = () => { try { return JSON.parse(localStorage.getItem(LINKS)) || {}; } catch { return {}; } };
function getLink(l) {
  const x = loadLinks()[linkKey(l)];
  // le stime si ricalcolano dopo 20 minuti (nel frattempo possono essere arrivati dati nuovi), le tratte certe restano
  return x && Date.now() - x.at < (x.rank >= 3 ? LINK_TTL : LINK_FRESH) ? x : null;
}
// anello già calcolato da un altro dispositivo (condiviso dal Worker): stesso volo precedente su tutti i dispositivi
async function getLinkAny(l) {
  const x = getLink(l);
  if (x) return x;
  const k = linkKey(l), v = await sharedLink(k);
  if (!v || Date.now() - v.at >= (v.rank >= 3 ? LINK_TTL : LINK_FRESH)) return null;
  const all = loadLinks();
  all[k] = v;
  try { localStorage.setItem(LINKS, JSON.stringify(all)); } catch { /* spazio pieno */ }
  return v;
}
function saveLink(l, r, rank) {
  if (!r) return;
  const all = loadLinks(), k = linkKey(l), old = all[k];
  // una stima meno informata non sostituisce una più informata ancora valida
  if (old && old.rank > rank && Date.now() - old.at < (old.rank >= 3 ? LINK_TTL : LINK_FRESH)) return;
  const strip = f => f && { number: f.number, airline: f.airline, status: f.status, callSign: f.callSign, aircraft: f.aircraft, dep: f.dep, arr: f.arr, codeshares: f.codeshares };
  all[k] = { at: Date.now(), rank, inbound: strip(r.inbound), method: r.method || null, basis: r.basis || null, p: r.p ?? null, reason: r.reason || '' };
  // lo condivido con gli altri dispositivi (solo se cambia, per non riscrivere ogni 5 minuti la stessa stima)
  const sig = x => x && JSON.stringify([x.rank, x.inbound?.number, x.inbound?.dep?.iata, x.method, x.basis, x.p]);
  if (sig(all[k]) !== sig(old) || Date.now() - (old?.at || 0) > LINK_FRESH / 2) shareLink(k, all[k]);
  for (const [kk, v] of Object.entries(all)) if (Date.now() - v.at > LINK_TTL) delete all[kk];
  try { localStorage.setItem(LINKS, JSON.stringify(all)); } catch { /* spazio pieno: pazienza */ }
}
const linkRank = (r, withFa) => r?.method === 'reg' ? 3 : withFa ? 2 : 1;

/** Completa una tratta letta da un tabellone arrivi (spesso senza orario di partenza) con i dati del volo. */
async function completeLeg(l, day) {
  const d = (l.arr?.sched?.local || l.dep?.sched?.local || '').slice(0, 10) || day;
  const legs = await getFlight(l.number, d, l.dep?.iata).catch(() => []);
  const m = legs.find(x => x.arr?.iata && x.arr.iata === l.arr?.iata) || legs.find(x => x.dep?.iata && x.dep.iata === l.dep?.iata) || (legs.length === 1 ? legs[0] : null);
  if (!m) return l;
  const out = copyLeg(m);
  // marche: solo quelle sicure (le ipotizzate, _chain, farebbero trattare l'ipotesi come certa nell'anello successivo)
  if (!m.aircraft?.reg && l.aircraft?.reg && !l.aircraft._chain) out.aircraft = { ...m.aircraft, ...l.aircraft };
  for (const k of ['_src', '_p', '_basis', '_regGuess']) if (l[k] !== undefined) out[k] = l[k];
  return out;
}

async function buildChain(f, inbound, r, date) {
  const day = flightDay(f) || date, dep0 = legStart(f);
  const out = { legs: [], reg: null, regSure: false, pReg: 1, regSrc: '', boards: [], adb: false, fa: false, steps: 0, end: null };
  const dayFrom = Date.parse(`${day}T00:00:00`) - 3 * 3600e3;
  let prev = [], after = [];
  // 1) marche: del volo (sicure) o del volo precedente (sicure se la tratta precedente è certa, altrimenti ipotesi)
  let reg = f.aircraft?.reg || null, regSure = !!reg, pReg = 1;
  if (reg && f.aircraft?.regSrc && /ipotes/i.test(f.aircraft.regSrc)) reg = null;
  // marche del volo precedente solo se la tratta precedente è certa: con marche ipotizzate la giornata di quell'aereo
  // darebbe una storia diversa da quella che mostra la pagina del volo precedente (si risale invece un anello alla volta)
  if (!reg && inbound?.aircraft?.reg && r?.method === 'reg' && !inbound.aircraft._chain && !inbound.aircraft.regGuess) {
    reg = inbound.aircraft.reg; regSure = true;
  }
  // marche solo ipotizzate ma il volo precedente ha già un suo anello ben calcolato: seguo quello (coerenza tra le pagine)
  const inbLink = inbound && !regSure ? await getLinkAny(inbound) : null;
  if (inbLink && inbLink.rank >= 2) reg = null;
  if (reg) {
    const seeds = [f.dep?.iata, f.arr?.iata, inbound?.dep?.iata].filter(Boolean);
    const [list, off] = await Promise.all([getFlightsByReg(reg, day).catch(() => []), officialByReg(reg, day, seeds, 6).catch(() => ({ legs: [], boards: [] }))]);
    const all = cleanLegs(mergeOfficialLegs(list, off.legs)).filter(l => !l._adsb && legKey(l) >= dayFrom);
    const before = all.filter(l => !sameLeg(l, f) && (legEnd(l) ?? Infinity) <= dep0 + 15 * 60e3);
    // con marche ipotizzate la giornata deve portare l'aereo proprio qui prima della partenza, altrimenti l'ipotesi non regge
    const fits = regSure || before.some(l => l.arr?.iata === f.dep?.iata && dep0 - legEnd(l) < 8 * 3600e3);
    if (fits && all.length) {
      const tag = l => Object.assign(copyLeg(l), { _src: regSure ? 'reg' : 'regGuess', _p: regSure ? 1 : pReg });
      prev = before.map(tag);
      after = all.filter(l => !sameLeg(l, f) && legKey(l) > legKey(f)).map(tag);
      Object.assign(out, { reg, regSure, pReg, boards: off.boards, adb: list.some(l => l._adbAt), fa: list.some(l => l._faAt) });
      out.regSrc = regSure ? (f.aircraft?.reg ? (f.aircraft.regSrc || 'indicate per questo volo') : `volo precedente ${inbound.number}`) : `ipotesi sull'aereo di ${inbound.number}`;
    }
  }
  // il volo precedente trovato dalla pagina deve esserci comunque
  if (inbound && !prev.some(l => sameLeg(l, inbound))) {
    prev.push(Object.assign(copyLeg(inbound), { _src: r?.method === 'guess' ? 'guess' : 'reg', _p: r?.method === 'guess' ? (r.p ?? 0.3) : 1, _basis: r?.basis }));
  }
  // 2) risalgo un anello alla volta dalla tratta più vecchia, finché resto nella stessa giornata
  prev.sort((a, b) => legKey(a) - legKey(b));
  let cur = prev[0] || null;
  if (!cur && r && !inbound) out.end = { kind: r.basis === 'ground' ? 'ground' : 'none', text: r.reason };
  while (cur && out.steps < CHAIN_MAX_STEPS) {
    const full = await completeLeg(cur, day);
    if (full !== cur) { prev[prev.indexOf(cur)] = full; cur = full; }
    if (!cur.dep?.iata || !cur.dep?.sched?.utc) { out.end = { kind: 'unknown', at: cur.dep?.iata }; break; }
    if ((cur.dep.sched.local || '').slice(0, 10) < day || legStart(cur) < dayFrom) { out.end = { kind: 'night', at: cur.dep.iata }; break; }
    if ((cur._p ?? 1) < CHAIN_MIN_P) { out.end = { kind: 'weak', at: cur.dep.iata }; break; }
    out.steps++;
    // anello già calcolato (anche dalla pagina di quel volo) o, se manca, calcolato ora come farebbe quella pagina:
    // FlightAware solo sul primo anello, per risparmiare richieste
    let r2 = await getLinkAny(cur);
    if (!r2) {
      const withFa = out.steps === 1;
      const probe = copyLeg(cur);
      if (probe.aircraft?._chain) probe.aircraft = { model: probe.aircraft.model };
      r2 = await getInbound(probe, withFa ? 0 : 1, { noFa: !withFa }).catch(() => null);
      if (r2) saveLink(cur, r2, linkRank(r2, withFa));
    }
    if (!r2?.inbound) { out.end = { kind: r2?.basis === 'ground' ? 'ground' : 'none', at: cur.dep.iata, text: r2?.reason || '' }; break; }
    if (prev.some(l => sameLeg(l, r2.inbound)) || legKey(r2.inbound) >= legKey(cur)) break;
    const guess = r2.method === 'guess';
    const nx = Object.assign(copyLeg(r2.inbound), { _src: guess || cur._src !== 'reg' ? 'guess' : 'reg', _basis: r2.basis, _p: +((cur._p ?? 1) * (guess ? (r2.p ?? 0.3) : 1)).toFixed(3) });
    prev.unshift(nx);
    cur = nx;
  }
  if (cur && out.steps >= CHAIN_MAX_STEPS && !out.end) out.end = { kind: 'max', at: cur.dep?.iata };
  const me = Object.assign(copyLeg(f), { _this: true, _src: 'this', _p: 1 });
  out.legs = cleanLegs([...prev, me, ...after]);
  return out;
}

const pctTag = l => l._src === 'guess' || l._src === 'regGuess' ? `<i class="uff est" title="Tratta stimata dall'app: probabilità circa ${Math.round((l._p ?? 0.3) * 100)}%">stima ~${Math.round((l._p ?? 0.3) * 100)}%</i>` : '';
function chainRows(legs) {
  return legs.map((l, i) => {
    const on = !!getWatch(l.number, flightDay(l), l.dep?.iata);
    const me = legs.find(x => x._this), dl = flightDay(l), dm = flightDay(me);
    const rel = l._this ? '<small class="sub">questo volo</small>' : legKey(l) > legKey(me) ? '<small class="sub">dopo</small>' : dl && dm && dl < dm ? `<small class="sub">${dl === isoDate(new Date(Date.parse(`${dm}T12:00:00`) - 86400e3)) ? 'il giorno prima' : esc(dl)}</small>` : '';
    const canWatch = !l._this && !['Arrived', 'Canceled'].includes(l.status) && l.dep?.iata && flightDay(l);
    return `<div class="row rot ${l._this ? 'me' : ''} ${AIR.includes(l.status) ? 'live' : ''}" role="row" tabindex="0" data-href="${flightLink(l)}">
      <span class="t">${timeCell(l.dep?.sched, l.dep?.revised, l.dep?.actual)}</span>
      <span class="num"><b>${esc(l.number)}</b><small>${esc(l.airline?.name || '')}${l._official ? ` <i class="uff" title="Dal tabellone ufficiale di ${esc([l.dep?._off, l.arr?._off].filter(Boolean).join(' e '))}">uff.</i>` : ''} ${pctTag(l)}</small></span>
      <span class="dest"><b>${esc(l.dep?.iata || '—')} → ${esc(l.arr?.iata || '—')}</b><small>${esc(l.dep?.iata ? apName(l.dep.iata) : '')} – ${esc(l.arr?.iata ? apName(l.arr.iata) : '')}</small>${rel}</span>
      <span class="t">${timeCell(l.arr?.sched, l.arr?.revised, l.arr?.actual)}</span>
      <span>${statusBadge(l.status)}${l._inferred ? '<small title="Stato dedotto: una tratta successiva è già partita">dedotto</small>' : ''}${canWatch ? ` <button class="bell chainbell ${on ? 'on' : ''}" data-i="${i}" title="${on ? 'Avvisi attivi: modifica' : 'Avvisami per decollo e atterraggio di questo volo'}">${on ? '🔔' : '🔕'}</button>` : ''}</span></div>`;
  }).join('');
}

function chainEndText(c) {
  const e = c.end, ap = e?.at ? `${/^[AEIOU]/i.test(apName(e.at)) ? 'ad' : 'a'} ${esc(apName(e.at))}` : '';
  if (!e) return '';
  switch (e.kind) {
    case 'night': return `Primo volo della giornata: l'aereo ha passato la notte ${ap} o è arrivato lì la sera prima.`;
    case 'ground': return `Prima di così probabilmente l'aereo era già fermo ${ap} (dalla notte o di riserva nella base).`;
    case 'weak': return `Oltre questo punto la stima diventa troppo incerta: mi fermo qui.`;
    case 'max': return `Mostro al massimo ${CHAIN_MAX_STEPS + 1} voli precedenti.`;
    case 'unknown': return 'Orario di partenza del volo più vecchio non disponibile: non riesco a risalire oltre.';
    default: return e.text ? esc(e.text) : `Non trovo il volo che ha portato l'aereo ${ap}.`;
  }
}

function chainSources(c) {
  if (isDemo()) return 'Fonte: dati dimostrativi.';
  const parts = [];
  if (c.reg) parts.push(`giornata dell'aereo <b>${esc(c.reg)}</b> (${c.regSure ? `marche sicure: ${esc(c.regSrc)}` : `<b>marche ipotizzate</b>, ${esc(c.regSrc)}, circa ${Math.round(c.pReg * 100)}%`}) da ${[c.adb && '<b>AeroDataBox</b>', c.fa && '<b>FlightAware</b>'].filter(Boolean).join(' e ') || 'tabelloni ufficiali'}${c.boards.length ? ` + tabelloni ufficiali con le marche (${c.boards.map(esc).join(', ')})` : ''}`);
  if (c.legs.some(l => l._src === 'guess')) parts.push('tratte “stima”: ricostruzione della giornata della compagnia in ogni aeroporto (tabellone ufficiale dove c’è, completato con <b>AeroDataBox</b>), le probabilità si moltiplicano risalendo la catena');
  if (c.legs.some(l => l._official)) parts.push('“uff.”: orari e stato dal tabellone ufficiale dell’aeroporto');
  return parts.length ? `Fonti: ${parts.join('; ')}.` : '';
}

function bindChain(box, c) {
  box.onclick = e => {
    const b = e.target.closest('.chainbell');
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const l = c.legs[+b.dataset.i], panel = box.querySelector('#chainnotify');
    if (!l || !panel) return;
    if (!panel.hidden && panel.dataset.i === b.dataset.i) { panel.hidden = true; return; }
    panel.dataset.i = b.dataset.i; panel.hidden = false;
    const paint = () => { const on = !!getWatch(l.number, flightDay(l), l.dep?.iata); b.classList.toggle('on', on); b.textContent = on ? '🔔' : '🔕'; };
    const render = (msg = '') => {
      const w = getWatch(l.number, flightDay(l), l.dep?.iata), problem = pushProblem();
      const evs = w?.events || CHAIN_DEFAULT;
      const needKey = !OFFICIAL_AIRPORTS[l.dep?.iata] || !OFFICIAL_AIRPORTS[l.arr?.iata];
      const est = l._src === 'guess' || l._src === 'regGuess';
      panel.innerHTML = `<span class="eyebrow">Avvisi per ${esc(l.number)} ${esc(l.dep?.iata || '')}→${esc(l.arr?.iata || '')}${est ? ' (stima)' : ''}</span>
        ${problem ? `<p class="note warn">${esc(problem)}</p>` : `
        <div class="evlist">${Object.entries(CHAIN_EVENTS).map(([k, t]) => `<label class="check"><input type="checkbox" name="cev" value="${k}" ${evs.includes(k) ? 'checked' : ''}> <span>${esc(t)}</span></label>`).join('')}</div>
        ${est ? '<p class="hint">È una tratta stimata: l’avviso segue proprio questo volo, anche se poi risultasse fatto da un altro aereo.</p>' : ''}
        <p class="hint">Fonti: ${[l.dep?.iata, l.arr?.iata].filter(x => OFFICIAL_AIRPORTS[x]).map(x => `tabellone ufficiale di ${esc(x)}`).join(' e ') || 'nessun tabellone ufficiale'}${needKey ? '; per il resto AeroDataBox, al massimo 30 chiamate per volo' : ''}.</p>
        ${needKey ? `<label class="check"><input type="checkbox" id="cusekey" ${w?.useKey === false ? '' : 'checked'}> Usa la mia chiave AeroDataBox dal Worker</label>` : ''}
        <p><button id="cwatch">${w ? 'Aggiorna' : 'Attiva gli avvisi'}</button> ${w ? '<button class="ghost" id="cstop">Disattiva</button>' : ''} <button class="ghost" id="cclose">Chiudi</button></p>`}
        <div>${msg}</div>`;
      const go = panel.querySelector('#cwatch');
      if (go) go.onclick = async () => {
        const events = [...panel.querySelectorAll('[name=cev]:checked')].map(x => x.value);
        if (!events.length) { render(errorBox('Scegli almeno un evento.')); return; }
        go.disabled = true;
        try {
          const res = await watchFlight(l, null, false, events, panel.querySelector('#cusekey')?.checked !== false);
          paint();
          render(res.updated ? '<p class="okmsg">✓ Avvisi aggiornati.</p>' : res.push?.ok ? `<p class="okmsg">✓ Avvisi attivi: ti ho mandato una notifica di conferma.${res.renewed ? ' L’iscrizione alle notifiche era scaduta: l’ho rinnovata.' : ''}</p>` : errorBox(`Volo registrato, ma la notifica di conferma non è partita (${res.push?.status || ''} ${res.push?.error || ''}).`));
        } catch (err) { render(errorBox(err)); }
      };
      const stop = panel.querySelector('#cstop');
      if (stop) stop.onclick = async () => { try { await unwatch(l.number, flightDay(l), l.dep?.iata); paint(); render('<p class="hint">Avvisi disattivati per questo volo.</p>'); } catch (err) { render(errorBox(err)); } };
      const close = panel.querySelector('#cclose');
      if (close) close.onclick = () => { panel.hidden = true; };
    };
    render();
  };
}

// Copia della catena già calcolata (qui o su un altro dispositivo collegato, tramite il Worker): si mostra subito
// aprendo il volo, mentre il ricalcolo parte in sottofondo e poi la sostituisce. Si usa per al massimo 6 ore.
// Sul Worker sta tra gli anelli condivisi con chiave "chain:…" (rank 3 = tenuta 30 ore, vince la più recente).
const SNAPS = 'aerei.chainSnap.v1', SNAP_TTL = 6 * 3600e3;
const snapKey = f => `chain:${linkKey(f)}`;
const slimSide = x => x && Object.fromEntries(['iata', 'sched', 'revised', 'actual', '_off', 'terminal', 'gate'].filter(k => x[k] != null).map(k => [k, x[k]]));
const slimLeg = l => Object.fromEntries(Object.entries({ number: l.number, airline: l.airline?.name ? { name: l.airline.name } : undefined, status: l.status, callSign: l.callSign,
  aircraft: l.aircraft?.reg || l.aircraft?.model ? { reg: l.aircraft.reg, model: l.aircraft.model, _chain: l.aircraft._chain } : undefined, dep: slimSide(l.dep), arr: slimSide(l.arr),
  _src: l._src, _p: l._p, _basis: l._basis, _this: l._this, _official: l._official, _inferred: l._inferred }).filter(([, v]) => v !== undefined));
function saveChainSnap(f, c) {
  const snap = { kind: 'chain', rank: 3, at: Date.now(), c: { ...c, legs: c.legs.map(slimLeg) } };
  let all = {};
  try { all = JSON.parse(localStorage.getItem(SNAPS)) || {}; } catch { /* nuovo */ }
  for (const [k, v] of Object.entries(all)) if (Date.now() - v.at > SNAP_TTL) delete all[k];
  all[snapKey(f)] = snap;
  try { localStorage.setItem(SNAPS, JSON.stringify(all)); } catch { /* spazio pieno */ }
  if (JSON.stringify(snap).length < 7800) shareLink(snapKey(f), snap);
}
async function chainSnap(f) {
  let x = null;
  try { x = (JSON.parse(localStorage.getItem(SNAPS)) || {})[snapKey(f)] || null; } catch { /* niente */ }
  if (!x || Date.now() - x.at > 10 * 60e3) {
    const remote = await sharedLink(snapKey(f));
    if (remote?.c?.legs && (!x || remote.at > x.at)) x = remote;
  }
  return x && Date.now() - x.at < SNAP_TTL && x.c?.legs?.length ? x : null;
}
/** Mostra subito l'ultima catena calcolata, se c'è, in attesa del ricalcolo. */
async function showChainSnap(f) {
  const box = document.getElementById('chain');
  const x = box && await chainSnap(f).catch(() => null);
  if (!x || !document.body.contains(box) || !box.querySelector('.loading')) return;
  renderChain(box, f, x.c, `Calcolata alle ${new Date(x.at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}: la aggiorno…`);
}

async function loadChain(f, inbound, r, date) {
  const box = document.getElementById('chain');
  if (!box) return;
  let c;
  try { c = await buildChain(f, inbound, r, date); } catch (e) { if (document.body.contains(box)) box.innerHTML = `<span class="eyebrow">La giornata dell'aereo</span>${errorBox(e)}`; return null; }
  if (!document.body.contains(box)) return;
  saveChainSnap(f, c);
  renderChain(box, f, c, '', date);
  // true = i voli precedenti sono tutti conclusi: non serve ricalcolare
  return { chain: c, done: c.legs.filter(l => legKey(l) < legKey(f)).every(l => ['Arrived', 'Canceled'].includes(l.status)) };
}

function renderChain(box, f, c, note = '', date = flightDay(f)) {
  const n = c.legs.filter(l => !l._this && legKey(l) < legKey(f)).length;
  const openI = box.querySelector('#chainnotify:not([hidden])')?.dataset.i;
  box.innerHTML = `<div class="leghead"><span class="eyebrow">La giornata dell'aereo · ${n ? `${n} ${n === 1 ? 'volo precedente' : 'voli precedenti'}` : 'nessun volo precedente trovato'}</span>${c.reg ? `<a class="sub" href="#/aircraft/${encodeURIComponent(c.reg)}/${flightDay(f) || date}${f.dep?.iata ? `?ap=${f.dep.iata}` : ''}">${esc(c.reg)}${c.regSure ? '' : ' (ipotesi)'} ›</a>` : ''}</div>
    ${c.legs.length > 1 ? `<div class="board"><div class="row head rot"><span>Partenza</span><span>Volo</span><span>Tratta</span><span>Arrivo</span><span>Stato</span></div>${chainRows(c.legs)}</div>` : ''}
    <div id="chainnotify" class="notify" hidden></div>
    ${note ? `<p class="hint"><i>${esc(note)}</i></p>` : ''}
    <p class="hint">${chainEndText(c)} Tocca 🔕 su un volo per gli avvisi di decollo e atterraggio, tocca la riga per i dettagli.</p>
    <p class="hint sources">${chainSources(c)}</p>`;
  bindChain(box, c);
  if (openI != null) box.querySelector(`.chainbell[data-i="${openI}"]`)?.click();
}


// ---------- Aeromobile: tutti i voli del giorno ----------
const RANK = { Unknown: 0, Expected: 1, CheckIn: 2, Boarding: 3, GateClosed: 4, Delayed: 1, Departed: 5, EnRoute: 6, Approaching: 7, Arrived: 8, Diverted: 8, Canceled: 0 };
const tms = t => t?.utc ? new Date(t.utc).getTime() : null;
const legKey = f => tms(f.dep?.sched) ?? (tms(f.arr?.sched) != null ? tms(f.arr.sched) - 2 * 3600e3 : 0);

/** Pulisce i dati per marche: unisce i doppioni della stessa tratta e corregge stati rimasti indietro. */
function cleanLegs(list) {
  const out = [];
  for (const f of [...list].sort((a, b) => legKey(a) - legKey(b))) {
    const g = out.find(o => o.dep?.iata === f.dep?.iata && o.arr?.iata === f.arr?.iata && (() => {
      const d1 = tms(o.dep?.sched), d2 = tms(f.dep?.sched), a1 = tms(o.arr?.sched), a2 = tms(f.arr?.sched);
      if (d1 && d2) return Math.abs(d1 - d2) < 90 * 60e3;
      if (a1 && a2) return Math.abs(a1 - a2) < 90 * 60e3;
      const d = d1 || d2, a = a1 || a2;
      return d && a && a > d && a - d < 8 * 3600e3;
    })());
    if (!g) { out.push({ ...f, dep: { ...f.dep }, arr: { ...f.arr } }); continue; }
    for (const side of ['dep', 'arr']) for (const k of Object.keys(f[side] || {})) if (g[side][k] == null && f[side][k] != null) g[side][k] = f[side][k];
    if ((RANK[f.status] || 0) > (RANK[g.status] || 0)) g.status = f.status;
  }
  out.sort((a, b) => legKey(a) - legKey(b));
  // se una tratta successiva è già partita, le precedenti sono per forza atterrate
  let laterDeparted = false;
  for (let k = out.length - 1; k >= 0; k--) {
    if (laterDeparted && (RANK[out[k].status] || 0) >= 5 && out[k].status !== 'Arrived') { out[k].status = 'Arrived'; out[k]._inferred = true; }
    if ((RANK[out[k].status] || 0) >= 5) laterDeparted = true;
  }
  return out;
}

function rotRows(list) {
  return list.map(f => {
    if (f._adsb) return `<div class="row rot live adsb"><span class="t"><b>ora</b></span>
      <span class="num"><b>${esc(f.number)}</b><small>dalla rete ADS-B</small></span>
      <span class="dest"><b>${esc(f.dep?.iata || '?')} → ${esc(f.arr?.iata || '?')}</b><small>${f.dep?.iata ? `${esc(apName(f.dep.iata))} – ${esc(apName(f.arr.iata))}` : 'rotta non nota'}</small></span>
      <span class="t">—</span><span>${statusBadge('EnRoute')}</span></div>`;
    return `<a class="row rot ${AIR.includes(f.status) ? 'live' : ''}" href="${flightLink(f)}">
      <span class="t">${timeCell(f.dep?.sched, f.dep?.revised, f.dep?.actual)}</span>
      <span class="num"><b>${esc(f.number)}</b><small>${esc(f.airline?.name || '')}${f._official ? ` <i class="uff" title="Dal tabellone ufficiale di ${esc([f.dep?._off, f.arr?._off].filter(Boolean).join(' e '))}">uff.</i>` : ''}</small></span>
      <span class="dest"><b>${esc(f.dep?.iata || shortCity(f.dep?.name) || '—')} → ${esc(f.arr?.iata || shortCity(f.arr?.name) || '—')}</b><small>${esc(f.dep?.iata ? apName(f.dep.iata) : f.dep?.name || '')} – ${esc(f.arr?.iata ? apName(f.arr.iata) : f.arr?.name || '')}${f.dep?._guess || f.arr?._guess ? ' <i class="uff" title="Aeroporto ricavato dalla traccia ADS-B">ADS-B</i>' : ''}</small></span>
      <span class="t">${timeCell(f.arr?.sched, f.arr?.revised, f.arr?.actual)}</span>
      <span>${statusBadge(f.status)}${f._inferred ? '<small title="Stato dedotto: una tratta successiva è già partita">dedotto</small>' : ''}</span></a>`;
  }).join('');
}

// storia dei voli di un aereo (come la pagina “history” dei siti di tracciamento): giorni dal più recente
async function loadHistory(reg, date) {
  const box = document.getElementById('achist');
  if (!box) return;
  const h = await getRegHistory(reg, 2).catch(() => null);
  if (!document.body.contains(box)) return;
  const head = '<div class="leghead"><span class="eyebrow">Storia dei voli · altri giorni (ultimi 2)</span></div>';
  if (!h) { box.innerHTML = `${head}<p class="hint">Storia non disponibile ora (serve FlightAware nel Worker, o il limite mensile è stato raggiunto).</p>`; return; }
  if (!h.flights.length) { box.innerHTML = `${head}<p class="hint">FlightAware non ha voli di ${esc(reg)} negli ultimi 2 giorni.</p>`; return; }
  const days = new Map();
  for (const f of h.flights) {
    const d = (f.dep?.sched?.local || f.dep?.sched?.utc || f.arr?.sched?.local || '').slice(0, 10);
    if (!d) continue;
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(f);
  }
  const label = d => new Date(`${d}T12:00:00`).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
  // il giorno aperto è già nella tabella sopra: qui solo gli altri giorni
  days.delete(date);
  if (!days.size) { box.innerHTML = `${head}<p class="hint">Negli altri giorni FlightAware non ha voli di ${esc(reg)}.</p>`; return; }
  // stesso ordine della tabella del giorno: dal più vecchio al più recente
  const rows = [...days].sort((a, b) => a[0].localeCompare(b[0])).map(([d, fl]) => {
    fl.sort((a, b) => legKey(a) - legKey(b));
    return `<div class="histday"><a href="#/aircraft/${encodeURIComponent(reg)}/${d}"${d === date ? ' class="cur"' : ''}>${esc(label(d))}</a><span class="sub">${fl.length} ${fl.length === 1 ? 'volo' : 'voli'}</span></div>
      <div class="board"><div class="row head rot"><span>Partenza</span><span>Volo</span><span>Tratta</span><span>Arrivo</span><span>Stato</span></div>${rotRows(fl)}</div>`;
  }).join('');
  box.innerHTML = `${head}${rows}<p class="hint">Fonte: <b>${esc(h.source)}</b> (voli con queste marche; orari locali di ciascun aeroporto). Tocca un giorno per la mappa di quel giorno, un volo per i dettagli.</p>`;
}

// unisce alle tratte di AeroDataBox quelle lette dai tabelloni ufficiali che riportano le marche
const OFF_SIDE = ['gate', 'belt', 'terminal', 'checkIn', 'revised', 'actual', 'officialStatus', '_off'];
function mergeOfficialLegs(list, off) {
  const out = list.map(f => ({ ...f, dep: { ...f.dep }, arr: { ...f.arr } }));
  for (const o of off) {
    const t = legKey(o);
    const l = out.find(f => (f.number === o.number || f.codeshares?.includes(o.number) || o._mkt?.includes(f.number))
      && (f.dep?.iata === o.dep.iata || f.arr?.iata === o.arr.iata) && Math.abs(legKey(f) - t) < 6 * 3600e3);
    if (!l) { out.push({ ...o, dep: { ...o.dep }, arr: { ...o.arr } }); continue; }
    for (const k of ['dep', 'arr']) if (o[k]?._off) for (const x of OFF_SIDE) if (o[k][x] != null) l[k][x] = o[k][x];
    if ((RANK[o.status] || 0) > (RANK[l.status] || 0) || o.status === 'Canceled') l.status = o.status;
    l._official = true;
  }
  return out;
}
const legEnd = f => tms(f.arr?.actual) ?? tms(f.arr?.revised) ?? tms(f.arr?.sched);
const legStart = f => tms(f.dep?.actual) ?? tms(f.dep?.revised) ?? tms(f.dep?.sched);
const legId = f => `${f.number}|${(f.dep?.sched || f.arr?.sched)?.utc || ''}`;
const shortCity = n => n ? String(n).split(/[\s,(/-]+/)[0].slice(0, 10) : '';
function nearestAirport(p) {
  let best = null, bd = 25;
  for (const a of AIRPORTS) { const d = distanceKm(a, p); if (d < bd) { bd = d; best = a; } }
  return best;
}
const legColor = f => f._adsb || AIR.includes(f.status) ? '#f5b301' : f.status === 'Arrived' ? '#8e9ab0' : f.status === 'Canceled' ? '#e5484d' : '#6ea8fe';

async function viewAircraft(reg, date, apHint) {
  reg = reg.toUpperCase();
  const day = d => isoDate(new Date(new Date(`${date}T12:00:00`).getTime() + d * 86400e3));
  const isToday = date === isoDate(new Date());
  const recent = Date.now() - new Date(`${date}T00:00:00`).getTime() < 36 * 3600e3 && new Date(`${date}T00:00:00`).getTime() <= Date.now();
  $app.innerHTML = `<div class="loading">Cerco i voli di ${esc(reg)}…</div>`;
  let list, adsb = null, adbErr = null, off = { legs: [], boards: [] }, trace = null, hex = null;
  [list, adsb] = await Promise.all([getFlightsByReg(reg, date).catch(e => { adbErr = e; return []; }), isToday ? liveByReg(reg) : null]);
  const guess = new Map(); // tratta → aeroporti ricavati dalla traccia ADS-B
  const build = () => {
    let legs = cleanLegs(mergeOfficialLegs(list, off.legs));
    for (const f of legs) {
      const g = guess.get(legId(f));
      if (!g) continue;
      for (const k of ['dep', 'arr']) if (g[k] && !f[k]?.iata) {
        f[k] = { ...f[k], lat: g[k].lat, lon: g[k].lon, ...(g[k].iata ? { iata: g[k].iata, name: f[k]?.name || g[k].name } : {}), _guess: true };
      }
    }
    // l'aereo sta volando con un nominativo che non corrisponde a nessuna tratta nota: la aggiungo
    if (adsb?.pos && !adsb.onGround) {
      const cs = adsb.callsign.replace(/\s+/g, '');
      const match = legs.find(f => AIR.includes(f.status) && (!adsb.route || (f.dep?.iata === adsb.route.from && f.arr?.iata === adsb.route.to)));
      if (!match) {
        legs.forEach(f => { if (AIR.includes(f.status)) { f.status = 'Unknown'; f._inferred = true; } });
        const synth = { _adsb: true, number: cs || 'In volo', status: 'EnRoute', dep: { iata: adsb.route?.from }, arr: { iata: adsb.route?.to }, aircraft: { reg, hex: adsb.hex } };
        const idx = legs.findIndex(f => legKey(f) > Date.now());
        legs.splice(idx < 0 ? legs.length : idx, 0, synth);
      }
    }
    return legs;
  };
  let legs = build();
  const model = () => [...list, ...off.legs].find(f => f.aircraft?.model)?.aircraft.model || adsb?.model || '';
  const boardHtml = () => legs.length ? `<div class="board"><div class="row head rot"><span>Partenza</span><span>Volo</span><span>Tratta</span><span>Arrivo</span><span>Stato</span></div>${rotRows(legs)}</div>`
    : adbErr ? errorBox(adbErr) + '<p class="hint" id="rothint">Cerco l’aereo nei tabelloni ufficiali…</p>'
    : `<p class="hint">Nessun volo trovato per ${esc(reg)} in questa data. Controlla le marche (es. EI-DCL) o prova il giorno prima/dopo.</p>`;
  const sources = () => pageSources(isDemo() ? [DEMO_SRC, MAP_SRC] : [
    adbErr ? `voli dell’aereo: ⚠ <b>AeroDataBox</b> non disponibile ora (${esc(adbErr.message || adbErr)})` : 'voli dell’aereo: <b>AeroDataBox</b>, che conosce una tratta solo quando la compagnia ha assegnato l’aereo (per le low cost le tratte future spesso mancano); “dedotto” = stato corretto dall’app perché una tratta successiva è già partita',
    off.boards.length ? `tabelloni ufficiali consultati cercando le marche ${esc(reg)}: ${off.boards.map(c => `${esc(OFFICIAL_SOURCES[c] || c)} (${c})`).join(', ')}${off.legs.length ? ` · ${off.legs.length} tratte trovate, segnate “uff.”; gate, orari e stati ufficiali hanno la precedenza` : ' · nessuna tratta con queste marche'}` : '',
    legs.some(f => f._adsb) && 'riga “dalla rete ADS-B”: il volo che l’aereo sta facendo adesso secondo i ricevitori amatoriali di <b>adsb.lol</b> (nominativo e rotta)',
    trace?.points?.length ? `percorso realmente volato (linea verde sulla mappa): tracce ADS-B di <b>${esc(trace.source)}</b>, ${trace.points.length} punti${hex ? ` · ICAO24 <code>${esc(hex)}</code>` : ''}` : recent ? 'percorso realmente volato: tracce ADS-B di <b>adsb.lol</b> (non disponibili ora per questo aereo; le tratte sono disegnate come archi)' : '',
    'archi sulla mappa: tratte del giorno in linea d’aria (grigio = concluse, giallo = in volo, azzurro tratteggiato = previste)',
    POS_SRC, MAP_SRC]);
  // quando sono stati letti i dati di ogni fonte usata in questa pagina
  const ageLine = () => {
    if (isDemo()) return '';
    const parts = [];
    const newest = k => Math.max(0, ...list.map(f => f[k] || 0));
    if (newest('_adbAt')) parts.push(`AeroDataBox ${ageTag(newest('_adbAt'), ADB_WARN)}`);
    if (newest('_faAt')) parts.push(`FlightAware ${ageTag(newest('_faAt'), ADB_WARN)}`);
    const boards = off.boards.map(c => {
      const a = [boardAge[`${c}:D`], boardAge[`${c}:A`]].filter(Boolean).sort((x, y) => y.at - x.at)[0];
      return a ? `${esc(c)} ${a.stale ? `⚠ copia di riserva ${ageTag(a.at, 0)}` : ageTag(a.at, OFF_WARN)}` : '';
    }).filter(Boolean);
    if (boards.length) parts.push(`tabelloni ufficiali: ${boards.join(', ')}`);
    const last = trace?.points?.length ? trace.points[trace.points.length - 1].t : null;
    if (last) parts.push(`ultimo punto della traccia ADS-B ${ageTag(last, 30)}`);
    return parts.length ? `Aggiornato: ${parts.join(' · ')}.` : '';
  };
  const render = () => {
    const sum = summary(legs);
    const head = document.getElementById('acsum');
    if (head) head.innerHTML = sum;
    const r = document.getElementById('rot');
    if (r) r.innerHTML = boardHtml();
    const f = document.getElementById('acsrc');
    if (f) f.innerHTML = sources();
    const ag = document.getElementById('acage');
    if (ag) ag.innerHTML = ageLine();
    const m = document.getElementById('acmodel');
    if (m) m.textContent = [model(), new Date(`${date}T12:00:00`).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })].filter(Boolean).join(' · ');
  };
  $app.innerHTML = `
    <div class="pagehead">
      <div><h1>✈︎ ${esc(reg)} ${star(isFavorite('aircraft', { reg }), favAttrs('aircraft', { reg, model: model() }))}</h1><p class="sub" id="acmodel"></p></div>
      <div class="daynav"><a class="ghost" href="#/aircraft/${encodeURIComponent(reg)}/${day(-1)}">‹ Ieri</a><a class="ghost" href="#/aircraft/${encodeURIComponent(reg)}/${day(1)}">Domani ›</a></div>
    </div>
    <p class="acsum" id="acsum"></p>
    <div class="card"><div class="leghead"><span class="eyebrow">Percorso del giorno</span><span id="acpos" class="sub"></span></div><div id="map" class="map tall"></div>
      <p class="maplegend"><span><i class="lg flown"></i>percorso volato (ADS-B)</span><span><i class="lg done"></i>tratta conclusa</span><span><i class="lg air"></i>in volo</span><span><i class="lg next"></i>prevista</span></p></div>
    <div id="rot"></div>
    <p class="hint sources" id="acage"></p>
    <div class="card" id="achist"><div class="leghead"><span class="eyebrow">Storia dei voli · altri giorni (ultimi 2)</span></div><p class="hint">Carico la storia dei voli…</p></div>
    <div id="acsrc"></div>`;
  render();
  bindStars($app);
  document.title = `✈︎ ${reg} · Voli`;
  const map = L.map('map', { worldCopyJump: true });
  maps.push(map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 12, attribution: '© OpenStreetMap' }).addTo(map);
  map.setView([45, 10], 4);
  let marker = null, dayLayer = null, traceLayer = null, fitKey = null;
  const trail = [];
  const trailLine = L.polyline(trail, { color: '#38d39f', weight: 3 }).addTo(map);
  const coords = async side => side?.lat != null ? side : side?.iata ? getAirportInfo(side.iata).catch(() => null) : null;

  // tutte le tratte del giorno: archi + aeroporti numerati nell'ordine in cui l'aereo li tocca
  const drawDay = async () => {
    const drawn = await Promise.all(legs.map(async f => ({ f, A: await coords(f.dep), B: await coords(f.arr) })));
    if (dayLayer) dayLayer.remove();
    dayLayer = L.layerGroup().addTo(map);
    const pts = [], aps = new Map();
    drawn.forEach(({ f, A, B }) => {
      for (const [P, side] of [[A, f.dep], [B, f.arr]]) {
        const code = side?.iata || shortCity(side?.name);
        if (P?.lat != null && code) { pts.push([P.lat, P.lon]); if (!aps.has(code)) aps.set(code, P); }
      }
      if (A?.lat == null || B?.lat == null) return;
      const future = !f._adsb && !AIR.includes(f.status) && f.status !== 'Arrived';
      const line = L.polyline(arc(A, B), { color: legColor(f), weight: AIR.includes(f.status) || f._adsb ? 3 : 2, opacity: trace?.points?.length && f.status === 'Arrived' ? 0.45 : 0.9, dashArray: future ? '6 6' : null })
        .bindTooltip(`<b>${esc(f.number)}</b> ${esc(f.dep.iata || f.dep.name || '?')} → ${esc(f.arr.iata || f.arr.name || '?')}${f.dep?.sched ? ` · ${hhmm(f.dep.sched)}` : ''}`, { sticky: true });
      if (!f._adsb) line.on('click', () => { location.hash = flightLink(f); });
      line.addTo(dayLayer);
    });
    [...aps].forEach(([code, P]) => L.marker([P.lat, P.lon], { icon: apIcon(code) }).addTo(dayLayer));
    if (traceLayer) traceLayer.bringToFront();
    const key = [...aps.keys()].join(',');
    if (pts.length && key !== fitKey) { fitKey = key; map.fitBounds(pts, { padding: [30, 30], maxZoom: 8 }); }
  };

  // percorso realmente volato secondo la rete ADS-B (solo oggi e ieri: i file coprono le ultime ~24 ore)
  const drawTrace = async () => {
    if (!recent || isDemo()) return;
    hex = hex || [...list, ...off.legs].find(f => f.aircraft?.hex)?.aircraft.hex || adsb?.hex || await hexOfReg(reg);
    if (!hex) return;
    const t = await getTrace(hex);
    if (!t) return;
    const from = legs.length ? Math.min(...legs.map(f => legStart(f) ?? Infinity)) - 3600e3 : new Date(`${date}T00:00:00`).getTime();
    const to = legs.length ? Math.max(...legs.map(f => legEnd(f) ?? -Infinity)) + 3600e3 : from + 86400e3;
    const inDay = t.points.filter(p => p.t >= (isFinite(from) ? from : 0) && p.t <= (isFinite(to) ? to : Infinity));
    trace = { ...t, points: inDay };
    // spezzo in tratte: inizio di una nuova tratta, aereo a terra, o buco di copertura con l'aereo a bassa quota (atterrato e ripartito)
    const segs = []; let cur = [];
    inDay.forEach((p, i) => {
      const prev = inDay[i - 1];
      const landedGap = prev && p.t - prev.t > 20 * 60e3 && (prev.alt < 10000 || p.alt < 10000);
      if (p.ground || p.newLeg || landedGap) { if (cur.length > 1) segs.push(cur); cur = []; }
      if (!p.ground) cur.push(p);
    });
    if (cur.length > 1) segs.push(cur);
    // aeroporti che il tabellone non indica (es. Ginevra dà solo il nome della città): li ricavo dagli estremi della traccia
    guess.clear();
    for (const f of legs) {
      if (f._adsb || (f.dep?.iata && f.arr?.iata)) continue;
      const s0 = legStart(f), e0 = legEnd(f);
      let best = null, bd = 75 * 60e3;
      for (const sg of segs) {
        const d = Math.min(s0 ? Math.abs(sg[0].t - s0) : Infinity, e0 ? Math.abs(sg[sg.length - 1].t - e0) : Infinity);
        if (d < bd) { bd = d; best = sg; }
      }
      if (!best) continue;
      const end = p => p.alt < 12000 ? (nearestAirport(p) || { lat: p.lat, lon: p.lon }) : null;
      guess.set(legId(f), { dep: !f.dep?.iata ? end(best[0]) : null, arr: !f.arr?.iata ? end(best[best.length - 1]) : null });
    }
    legs = build();
    if (traceLayer) traceLayer.remove();
    traceLayer = L.layerGroup(segs.map(s => L.polyline(s.map(p => [p.lat, p.lon]), { color: '#38d39f', weight: 3, opacity: 0.95 }))).addTo(map);
    if (segs.length) trail.length = 0, trailLine.setLatLngs([]);
    render();
  };

  // tratte dai tabelloni ufficiali che pubblicano le marche, partendo dagli aeroporti già noti
  const findOfficial = async () => {
    if (isDemo()) return;
    const seed = [apHint, ...legs.flatMap(f => [f.dep?.iata, f.arr?.iata])].filter(Boolean);
    off = await officialByReg(reg, date, seed).catch(() => off);
    legs = build();
    render();
  };

  const live = async () => {
    const el = document.getElementById('acpos');
    if (!el) return;
    if (isToday) { adsb = await liveByReg(reg) || adsb; }
    const flying = legs.find(f => f._adsb) || legs.find(f => AIR.includes(f.status));
    setTabInfo(`aircraft:${reg}`, { sub: flying ? `in volo · ${flying.number}` : (model() || 'aereo'), dot: flying ? 'go' : null });
    let pos = adsb?.pos && !adsb.onGround ? adsb.pos : null;
    if (!pos && flying && !flying._adsb) pos = await getLivePosition(flying).catch(() => null);
    if (!pos) {
      el.innerHTML = adsb?.onGround ? 'A terra in questo momento (rete ADS-B)' : flying ? `In volo come <b>${esc(flying.number)}</b>, posizione non disponibile` : isToday ? 'A terra o fuori copertura in questo momento' : '';
      return;
    }
    if (!traceLayer) { trail.push([pos.lat, pos.lon]); trailLine.setLatLngs(trail); }
    if (!marker) { marker = L.marker([pos.lat, pos.lon], { icon: planeIcon(pos.track), zIndexOffset: 1000 }).addTo(map); if (!fitKey) map.setView([pos.lat, pos.lon], 6); }
    else marker.setLatLng([pos.lat, pos.lon]).setIcon(planeIcon(pos.track));
    const label = flying ? (flying._adsb ? `<b>${esc(flying.number)}</b>${flying.dep?.iata ? ` ${esc(flying.dep.iata)} → ${esc(flying.arr.iata)}` : ''}` : `<a href="${flightLink(flying)}"><b>${esc(flying.number)}</b></a> ${esc(flying.dep?.iata || '')} → ${esc(flying.arr?.iata || '')}`) : '';
    el.innerHTML = `In volo${label ? ` come ${label}` : ''}${pos.alt != null ? ` · ${Math.round(pos.alt).toLocaleString('it-IT')} ft` : ''}${pos.gs != null ? ` · ${Math.round(pos.gs)} kt` : ''} · fonte ${esc(pos.source)}${posAge(pos)}`;
  };
  await drawDay();
  await live();
  findOfficial().then(drawDay).then(drawTrace).then(drawDay).catch(() => {});
  loadHistory(reg, date);
  every(15, live);
  every(60, () => drawTrace().then(drawDay).catch(() => {}));
  let ticks = 0;
  every(Math.max(getSettings().refreshSec, 60), async () => {
    try {
      list = await getFlightsByReg(reg, date); adbErr = null;
      // i tabelloni ufficiali li rileggo ogni 5 aggiornamenti (il Worker li tiene comunque in cache)
      if (++ticks % 5 === 0) await findOfficial(); else { legs = build(); render(); }
      await drawDay();
    } catch { /* riprova */ }
  });
}

// riepilogo del giorno: tratte, aeroporti nell'ordine, distanza e ore di volo
function summary(legs) {
  const real = legs.filter(f => !f._adsb && f.status !== 'Canceled');
  if (!real.length) return '';
  const chain = [];
  for (const f of real) for (const side of [f.dep, f.arr]) {
    const c = side?.iata || shortCity(side?.name);
    if (c && chain[chain.length - 1]?.c !== c) chain.push({ c, iata: side?.iata });
  }
  let km = 0, min = 0;
  for (const f of real) {
    const pos = side => side?.lat != null ? side : airportByIata(side?.iata);
    const A = pos(f.dep), B = pos(f.arr);
    if (A && B) km += distanceKm(A, B);
    const s = legStart(f), e = legEnd(f);
    if (s && e && e > s) min += Math.round((e - s) / 60e3);
  }
  const done = real.filter(f => f.status === 'Arrived').length;
  return `<b>${real.length} ${real.length === 1 ? 'tratta' : 'tratte'}</b>${done ? ` (${done} concluse)` : ''} · ${chain.map(x => x.iata ? `<a href="#/airport/${x.iata}/dep">${esc(x.c)}</a>` : esc(x.c)).join(' → ')}${km ? ` · ${Math.round(km).toLocaleString('it-IT')} km` : ''}${min ? ` · ${fmtDur(min)} di volo` : ''}`;
}
const AIR = ['Departed', 'EnRoute', 'Approaching'];

// ---------- Impostazioni ----------
function viewSettings() {
  const s = getSettings();
  $app.innerHTML = `
    <h1>Impostazioni</h1>
    <p class="sub">Versione app: ${APP_VERSION}</p>
    <form class="card settings" id="sf">
      <span class="eyebrow">Fonte dati voli</span>
      <label class="radio"><input type="radio" name="provider" value="demo" ${s.provider !== 'aerodatabox' ? 'checked' : ''}> <span><b>Demo</b> · voli simulati, nessuna chiave richiesta</span></label>
      <label class="radio"><input type="radio" name="provider" value="aerodatabox" ${s.provider === 'aerodatabox' ? 'checked' : ''}> <span><b>AeroDataBox</b> · dati reali (tabelloni con gate, voli per numero e per aeromobile)</span></label>
      <label>Chiave API RapidAPI per AeroDataBox<input name="apiKey" type="password" value="${esc(s.apiKey)}" placeholder="incolla qui la X-RapidAPI-Key"></label>
      <p class="hint">Come ottenerla: crea un account su RapidAPI, abbonati ad <a href="https://rapidapi.com/aedbx-aedbx/api/aerodatabox" target="_blank" rel="noopener">AeroDataBox</a> (c'è un piano gratuito con poche centinaia di chiamate al mese, quelli a pagamento partono da pochi euro), poi copia la chiave. La chiave resta solo in questo browser.</p>
      <label>Indirizzo del tuo Cloudflare Worker (tabelloni ufficiali degli aeroporti)<input name="workerUrl" type="url" value="${esc(s.workerUrl || '')}" placeholder="https://tabellone-voli.tuonome.workers.dev"></label>
      <p class="hint">Facoltativo. Con il Worker, per questi aeroporti gate, orari stimati e stato arrivano dal tabellone dell'aeroporto (per Milano, Ginevra, Zurigo e Francoforte anche le marche dell'aereo). Istruzioni: <a href="https://github.com/gbagliesi/app-aerei/blob/main/worker/README.md" target="_blank" rel="noopener">worker/README.md</a>. <button type="button" class="ghost" id="testw">Prova il Worker</button></p>
      <div id="testwres"></div>
      <label>Aggiornamento automatico tabelloni (secondi)<input name="refreshSec" type="number" min="30" max="600" value="${s.refreshSec}"></label>
      <p class="hint">Ogni aggiornamento consuma una chiamata API: con il piano gratuito conviene 120–300 secondi.</p>
      <button>Salva</button> <button type="button" class="ghost" id="test">Prova la chiave</button> <span id="saved" class="sub"></span>
      <div id="testres"></div>
    </form>
    <div class="card" id="synccard"></div>
    <div class="card">
      <span class="eyebrow">Tracking in tempo reale</span>
      <p class="hint">La posizione dell'aereo arriva da AeroDataBox quando disponibile, altrimenti dalle reti ADS-B gratuite <b>adsb.lol</b> e <b>OpenSky Network</b>, cercando l'aereo per codice ICAO24. Nessuna chiave richiesta.</p>
    </div>
    <div class="card">
      <span class="eyebrow">Tabelloni ufficiali collegati</span>
      <p class="hint">Con il Worker impostato, per questi aeroporti orari, gate, check-in, nastro e stato arrivano dal tabellone dell’aeroporto (hanno la priorità) e sono completati con AeroDataBox. Per tutti gli altri si usa solo AeroDataBox.</p>
      <ul class="srclist">${Object.keys(OFFICIAL_SOURCES).filter(k => OFFICIAL_AIRPORTS[k]).sort().map(k => `<li><a href="#/airport/${k}/dep"><b>${k}</b></a> ${esc(apName(k))} · <small>${esc(OFFICIAL_SOURCES[k])}</small></li>`).join('')}</ul>
      <p class="hint">Solo AeroDataBox, con il link al tabellone sul sito ufficiale: ${Object.entries(SITE_BOARDS).map(([k, b]) => `<b>${k}</b> (${esc(b.name)})`).join(', ')}.</p>
    </div>
    <div class="card">
      <span class="eyebrow">Notifiche sui voli</span>
      <p class="hint">Apri un volo e tocca 🔕 accanto al numero per scegliere gli avvisi (atterraggio dell’aereo in arrivo, gate, imbarco, ritardi, decollo, atterraggio…). Le manda il tuo Worker, anche ad app chiusa; su iPhone/iPad solo dall’app aggiunta alla schermata Home.</p>
      <div id="nlist"><p class="hint">…</p></div>
      <button type="button" class="ghost" id="ntest">Manda una notifica di prova</button> <span id="ntestres" class="sub"></span>
    </div>
    <div class="card">
      <span class="eyebrow">Preferiti e tab</span>
      <p class="hint">I preferiti e i tab aperti sono salvati in questo browser${isLinked() ? ' e sincronizzati con gli altri dispositivi collegati' : ''}. Puoi anche esportare i preferiti in un file.</p>
      <button id="exp" class="ghost">Esporta</button> <label class="ghost filebtn">Importa<input id="imp" type="file" accept="application/json" hidden></label>
    </div>`;
  document.getElementById('sf').addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    saveSettings({ provider: fd.get('provider'), apiKey: fd.get('apiKey').trim(), workerUrl: (fd.get('workerUrl') || '').trim(), refreshSec: Math.max(30, +fd.get('refreshSec') || 60) });
    document.getElementById('saved').textContent = 'Salvato ✓';
    updateBanner();
  });
  document.getElementById('test').onclick = async () => {
    const out = document.getElementById('testres');
    out.innerHTML = '<p class="hint">Verifico la chiave…</p>';
    try {
      const n = await testKey(document.querySelector('[name=apiKey]').value);
      out.innerHTML = `<p class="okmsg">✓ Chiave valida: trovate ${n} partenze da Fiumicino nella prossima ora. Ricordati di selezionare AeroDataBox e premere Salva.</p>`;
    } catch (e) { out.innerHTML = errorBox(e); }
  };
  document.getElementById('testw').onclick = async () => {
    const out = document.getElementById('testwres');
    out.innerHTML = '<p class="hint">Verifico il Worker…</p>';
    try {
      const n = await testWorker(document.querySelector('[name=workerUrl]').value);
      out.innerHTML = n ? `<p class="okmsg">✓ Worker funzionante: ${n} partenze lette dal tabellone di Pisa. Premi Salva.</p>` : errorBox('Il Worker risponde ma non ha trovato voli: apri l’indirizzo del Worker seguito da /debug?airport=PSA&nature=D e mandami cosa compare.');
    } catch (e) { out.innerHTML = errorBox(`Worker non raggiungibile (${e.message}). Controlla l’indirizzo.`); }
  };
  notifySettings();
  syncSettings();
  document.getElementById('exp').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([exportFavorites()], { type: 'application/json' }));
    a.download = 'preferiti-voli.json'; a.click();
  };
  document.getElementById('imp').onchange = async e => {
    try { importFavorites(await e.target.files[0].text()); alert('Preferiti importati'); } catch { alert('File non valido'); }
  };
}

async function notifySettings() {
  const list = document.getElementById('nlist'), problem = pushProblem();
  const t = document.getElementById('ntest');
  if (!list) return;
  const pend = pendingWatches();
  const pendHtml = pend.length ? `<p class="note">${pend.length === 1 ? 'Un volo seguito' : `${pend.length} voli seguiti`} su un altro dispositivo collegato (${pend.map(w => esc(w.k.split('|')[0])).join(', ')}) qui non ${pend.length === 1 ? 'è' : 'sono'} ancora ${pend.length === 1 ? 'attivo' : 'attivi'}. ${problem ? '' : '<button type="button" class="small" id="npend">Attiva qui</button>'}</p>` : '';
  if (problem) { list.innerHTML = `${pendHtml}<p class="note warn">${esc(problem)}</p>`; t.hidden = true; return; }
  const bindPend = () => { const b = document.getElementById('npend'); if (b) b.onclick = async () => { b.disabled = true; try { await activatePending(); notifySettings(); } catch (e) { b.disabled = false; alert(e.message); } }; };
  t.onclick = async () => {
    const out = document.getElementById('ntestres');
    out.textContent = 'Invio…';
    try { const r = await testPush(); out.textContent = r.push?.ok ? (r.renewed ? 'Inviata ✓ (iscrizione scaduta, rinnovata)' : 'Inviata ✓') : `Non partita: ${r.push?.status || ''} ${r.push?.error || ''}`; } catch (e) { out.textContent = e.message; }
  };
  try {
    const ws = await listWatches();
    if (!ws.length) { list.innerHTML = `${pendHtml}<p class="hint">Nessun volo seguito con le notifiche su questo dispositivo.</p>`; bindPend(); return; }
    const when = ms => new Date(ms).toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    list.innerHTML = `${pendHtml}<ul class="srclist">${ws.map(w => `<li><a href="#/flight/${encodeURIComponent(w.number)}/${w.date}?dep=${w.dep}"><b>${esc(w.number)}</b> ${esc(w.dep)}→${esc(w.arr || '?')}</a> · ${esc(w.date.slice(8))}/${esc(w.date.slice(5, 7))}
      ${w.inbound ? `· aereo in arrivo ${esc(w.inbound)}` : ''} · <small>${w.lastCheck ? `ultimo controllo ${esc(when(w.lastCheck))}` : 'controlli a partire da 4 ore prima'}${w.adbCalls ? ` · ${w.adbCalls} chiamate AeroDataBox` : ''}</small>
      <button type="button" class="ghost small" data-unwatch="${esc(w.id)}" data-k="${esc(`${w.number}|${w.date}|${w.dep}`)}">Togli</button>
      ${(w.log || []).length ? `<ul class="nlog">${w.log.slice(-5).reverse().map(l => `<li><small>${esc(when(l.at))}</small> ${esc(l.text)}${l.ok ? '' : ' <small>(non consegnata)</small>'}</li>`).join('')}</ul>` : ''}</li>`).join('')}</ul>`;
    bindPend();
    list.querySelectorAll('[data-unwatch]').forEach(b => b.onclick = async () => {
      const [n, d, dep] = b.dataset.k.split('|');
      try { await unwatch(n, d, dep, b.dataset.unwatch); notifySettings(); } catch (e) { alert(e.message); }
    });
  } catch (e) { list.innerHTML = errorBox(e); }
}


// ---------- sincronizzazione fra dispositivi (sync.js) ----------
const whenSync = ms => new Date(ms).toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function syncSettings(msg = '') {
  const box = document.getElementById('synccard');
  if (!box) return;
  const a = syncAccount(), hasW = !!(getSettings().workerUrl || '').trim();
  const intro = '<span class="eyebrow">Sincronizzazione fra dispositivi</span>';
  if (!a) {
    box.innerHTML = `${intro}
      <p class="hint">Collega telefono, computer e altri dispositivi: preferiti, tab, voli seguiti con le notifiche e impostazioni (compresa la chiave AeroDataBox) restano uguali su tutti, e la catena dei voli calcolata su uno la vedono anche gli altri. Non servono password né email: i dati restano nel tuo Worker. Senza collegamento l’app funziona come prima, con i dati solo qui.</p>
      ${hasW ? '' : '<p class="note warn">Serve prima l’indirizzo del Worker qui sopra (premi Salva).</p>'}
      <p><button type="button" id="snew" ${hasW ? '' : 'disabled'}>Inizia da questo dispositivo</button></p>
      <label>Hai già collegato un altro dispositivo? Inserisci il codice che compare lì (Impostazioni → Collega un altro dispositivo)<input id="scode" placeholder="ABCD-EFGH" autocomplete="off" autocapitalize="characters" spellcheck="false"></label>
      <p><button type="button" class="ghost" id="sjoin" ${hasW ? '' : 'disabled'}>Collega questo dispositivo</button></p>
      <div id="sres">${msg}</div>`;
    const busy = async (b, fn) => { b.disabled = true; document.getElementById('sres').innerHTML = '<p class="hint">Un momento…</p>'; try { await fn(); syncSettings('<p class="okmsg">✓ Collegato. I dati si aggiornano da soli.</p>'); notifySettings(); } catch (e) { b.disabled = false; document.getElementById('sres').innerHTML = errorBox(e); } };
    document.getElementById('snew').onclick = e => busy(e.target, createAccount);
    document.getElementById('sjoin').onclick = e => busy(e.target, () => joinAccount(document.getElementById('scode').value));
    return;
  }
  const c = { fav: true, tabs: true, watch: true, settings: true, ...(a.cats || {}) };
  const devs = a.devices || [];
  box.innerHTML = `${intro}
    ${a.lastError && (a.lastErrorAt || 0) > (a.lastOk || 0) ? `<p class="note warn">Ultimo tentativo non riuscito: ${esc(a.lastError)}</p>` : `<p class="okmsg">✓ Collegato${a.lastOk ? ` · aggiornato ${esc(whenSync(a.lastOk))}` : ''}</p>`}
    ${devs.length ? `<p class="hint">Dispositivi collegati:</p><ul class="srclist">${devs.map(d => `<li><b>${esc(d.name)}</b>${d.id === a.me ? ' (questo)' : ''} · <small>ultimo accesso ${esc(whenSync(d.last))}</small> ${d.id === a.me ? '' : `<button type="button" class="ghost small" data-sdev="${esc(d.id)}">Scollega</button>`}</li>`).join('')}</ul>` : ''}
    <p class="hint">Cosa sincronizzare da questo dispositivo:</p>
    <div class="evlist">${Object.entries(SYNC_CATS).map(([k, l]) => `<label class="check"><input type="checkbox" name="scat" value="${k}" ${c[k] ? 'checked' : ''}> <span>${esc(l)}</span></label>`).join('')}</div>
    <p><button type="button" id="spair">Collega un altro dispositivo</button> <button type="button" class="ghost" id="snow">Sincronizza ora</button></p>
    <div id="spaircode"></div>
    <div id="sres">${msg}</div>
    <details><summary class="hint">Codice di recupero e altre opzioni</summary>
      <p class="hint">Il codice di recupero ricollega un dispositivo anche se li hai persi tutti: conservalo in un posto sicuro (per esempio nel gestore delle password). Chi lo conosce vede i tuoi preferiti e la chiave AeroDataBox.</p>
      <p><code class="token">${esc(a.token)}</code> <button type="button" class="ghost small" id="scopytk">Copia</button></p>
      <p><button type="button" class="ghost" id="sunlink">Scollega questo dispositivo</button> <button type="button" class="ghost" id="swipe">Cancella l’account dal Worker</button></p>
      <p class="hint">Scollegando, i dati restano in questo browser. Cancellando l’account si scollegano tutti i dispositivi e il Worker dimentica i dati (nei browser restano).</p>
    </details>`;
  const res = h => { document.getElementById('sres').innerHTML = h; };
  document.getElementById('snow').onclick = async () => { res('<p class="hint">Sincronizzo…</p>'); try { await syncNow(); syncSettings('<p class="okmsg">✓ Fatto.</p>'); notifySettings(); } catch (e) { syncSettings(errorBox(e)); } };
  document.getElementById('spair').onclick = async () => {
    const out = document.getElementById('spaircode');
    out.innerHTML = '<p class="hint">Creo il codice…</p>';
    try {
      const p = await pairingCode();
      out.innerHTML = `<div class="paircode"><p class="hint">Sull’altro dispositivo apri l’app, vai in Impostazioni e inserisci questo codice (vale fino alle ${esc(new Date(p.exp).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }))}, una sola volta):</p>
        <p class="bigcode">${esc(p.code.slice(0, 4))}-${esc(p.code.slice(4))}</p>
        <p class="hint">Oppure apri lì questo link (imposta anche il Worker): <a href="${esc(p.link)}">${esc(p.link)}</a> <button type="button" class="ghost small" id="scopy">Copia link</button></p></div>`;
      document.getElementById('scopy').onclick = e => navigator.clipboard?.writeText(p.link).then(() => { e.target.textContent = 'Copiato ✓'; });
    } catch (e) { out.innerHTML = errorBox(e); }
  };
  box.querySelectorAll('[name=scat]').forEach(x => x.onchange = async () => {
    const nc = Object.fromEntries([...box.querySelectorAll('[name=scat]')].map(i => [i.value, i.checked]));
    try { await setCats(nc); syncSettings('<p class="okmsg">✓ Salvato.</p>'); } catch (e) { syncSettings(errorBox(e)); }
  });
  box.querySelectorAll('[data-sdev]').forEach(b => b.onclick = async () => {
    try { await removeDevice(b.dataset.sdev); await listDevices(); syncSettings('<p class="okmsg">✓ Dispositivo scollegato.</p>'); } catch (e) { res(errorBox(e)); }
  });
  document.getElementById('scopytk').onclick = e => navigator.clipboard?.writeText(a.token).then(() => { e.target.textContent = 'Copiato ✓'; });
  document.getElementById('sunlink').onclick = async () => { await unlinkThis(); syncSettings('<p class="hint">Dispositivo scollegato: i dati restano qui.</p>'); };
  document.getElementById('swipe').onclick = async () => {
    if (!confirm('Cancellare l’account di sincronizzazione dal Worker? Tutti i dispositivi verranno scollegati (i dati restano nei browser).')) return;
    try { await wipeAccount(); syncSettings('<p class="hint">Account cancellato.</p>'); } catch (e) { res(errorBox(e)); }
  };
  // elenco dei dispositivi aggiornato (in sottofondo)
  if (!msg && Date.now() - Math.max(a.lastOk || 0, a.devAt || 0) > 60e3) listDevices().then(() => { if (document.getElementById('spair') && !document.getElementById('spaircode').innerHTML) syncSettings(); }).catch(() => {});
}

// link "Collega" aperto dal codice mostrato su un altro dispositivo: #/collega?c=CODICE&w=indirizzo-del-Worker
function viewCollega(params) {
  const code = (params.get('c') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const w = params.get('w') || '';
  const s = getSettings();
  if (w && /^https:\/\/[^/]+/.test(w) && !(s.workerUrl || '').trim()) saveSettings({ ...s, workerUrl: w, provider: 'aerodatabox' });
  $app.innerHTML = `<h1>Collega questo dispositivo</h1>
    <div class="card">${isLinked() ? '<p class="okmsg">Questo dispositivo è già collegato.</p><p><a href="#/settings">Vai alle impostazioni</a></p>' : `
      <p class="hint">Preferiti, tab, voli seguiti e impostazioni arriveranno dall’altro dispositivo; quello che hai già qui si aggiunge, non si perde.</p>
      <p class="bigcode">${esc(code.slice(0, 4))}-${esc(code.slice(4))}</p>
      <p><button id="cgo">Collega</button></p><div id="cres"></div>`}</div>`;
  const go = document.getElementById('cgo');
  if (go) go.onclick = async () => {
    go.disabled = true; document.getElementById('cres').innerHTML = '<p class="hint">Collego…</p>';
    try { await joinAccount(code); updateBanner(); location.hash = '#/settings'; }
    catch (e) { go.disabled = false; document.getElementById('cres').innerHTML = errorBox(e); }
  };
}

// ---------- router ----------
function updateBanner() { document.getElementById('demo-banner').hidden = getSettings().provider === 'aerodatabox'; }

// ---------- posizione di scroll: tornando indietro (es. dal volo al tabellone) si riparte da dove si era ----------
// ogni voce della cronologia riceve un id; la posizione si salva per id, così un link nuovo apre in cima
// e il tasto Indietro ripristina la posizione salvata.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
const SCROLL_KEY = 'scrollPos';
const scrollPos = (() => { try { return JSON.parse(sessionStorage.getItem(SCROLL_KEY)) || {}; } catch { return {}; } })();
let restoring = false, userScrolled = false, scrollSaveT = 0;
const entryId = () => history.state?.sid;
window.addEventListener('scroll', () => {
  if (restoring || !entryId()) return;
  scrollPos[entryId()] = Math.round(window.scrollY);
  clearTimeout(scrollSaveT);
  scrollSaveT = setTimeout(() => saveScroll(), 300);
}, { passive: true });
// solo rotella/tastiera: su iPhone il gesto "indietro" genera eventi touch e bloccava il ripristino
['wheel', 'keydown'].forEach(ev => window.addEventListener(ev, () => { if (restoring) userScrolled = true; }, { passive: true }));
const saveScroll = () => { try { sessionStorage.setItem(SCROLL_KEY, JSON.stringify(scrollPos)); } catch {} };
// ricorda quale riga del tabellone è stata aperta, per tornarci sopra
const rememberRow = href => { if (entryId()) { scrollPos[entryId()] = Math.round(window.scrollY); scrollPos[`${entryId()}:row`] = href; saveScroll(); } };
let routeSeq = 0;
function restoreScroll(seq, y, href) {
  if (seq !== routeSeq) return;
  // aspetta che la pagina sia disegnata (tabellone caricato), poi torna sulla riga aperta o alla posizione salvata
  requestAnimationFrame(() => {
    if (seq === routeSeq && !userScrolled) {
      const row = href && [...document.querySelectorAll('.row[data-href]')].find(r => r.dataset.href === href);
      if (row) {
        row.scrollIntoView({ block: 'center' });
        row.classList.add('lastseen');
        setTimeout(() => row.classList.remove('lastseen'), 2500);
      } else window.scrollTo(0, y);
    }
    restoring = false;
  });
}
// tasto Indietro: visibile quando c'è una pagina precedente dentro l'app
let curDepth = 0;
const $back = document.getElementById('back');
if ($back) $back.onclick = () => history.back();

function route() {
  clearPage();
  const seq = ++routeSeq;
  let saved = 0, savedRow = null;
  const isNew = !entryId();
  if (!isNew) { saved = scrollPos[entryId()] || 0; savedRow = scrollPos[`${entryId()}:row`] || null; }
  else history.replaceState({ ...(history.state || {}), sid: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, depth: curDepth + 1 }, '');
  curDepth = history.state?.depth || 1;
  if ($back) $back.hidden = curDepth <= 1;
  document.title = 'Tabellone Voli';
  const [path, qs] = location.hash.slice(1).split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(qs || '');
  // tab: apre/aggiorna il tab di questa pagina; tornando su un tab già aperto si ritrova la posizione
  const tabY = enterTab(parts, location.hash || '#/', isNew);
  if (isNew && tabY) saved = tabY;
  restoring = saved > 0 || !!savedRow; userScrolled = false;
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === (parts[0] || 'home')));
  window.scrollTo(0, 0);
  const p = renderView(parts, params);
  playEnterAnim($app);
  if (restoring) Promise.resolve(p).catch(() => {}).finally(() => restoreScroll(seq, saved, savedRow));
}

function renderView(parts, params) {
  if (parts[0] === 'airport' && parts[1]) return viewAirport(parts[1], parts[2] === 'arr' ? 'arr' : 'dep');
  if (parts[0] === 'route' && parts[1] && parts[2]) return viewAirport(parts[1], 'dep', parts[2].toUpperCase());
  if (parts[0] === 'flight' && parts[1]) return viewFlight(parts[1].toUpperCase(), parts[2] || isoDate(new Date()), params.get('dep'));
  if (parts[0] === 'aircraft' && parts[1]) return viewAircraft(parts[1], parts[2] || isoDate(new Date()), (params.get('ap') || '').toUpperCase() || null);
  if (parts[0] === 'settings') return viewSettings();
  if (parts[0] === 'collega') return viewCollega(params);
  return viewHome();
}

document.addEventListener('click', e => {
  // "+N code sharing": mostra/nasconde l'elenco delle altre sigle senza aprire il volo
  const cs = e.target.closest('.csbtn');
  if (cs) { const l = cs.closest('.dest')?.querySelector('.cslist'); if (l) { l.hidden = !l.hidden; cs.classList.toggle('open', !l.hidden); } return; }
  const row = e.target.closest('.row[data-href]');
  if (!row || e.target.closest('a, button')) return;
  if (e.metaKey || e.ctrlKey) window.open(row.dataset.href, '_blank'); else { rememberRow(row.dataset.href); location.hash = row.dataset.href; }
});
document.addEventListener('keydown', e => { const row = e.target.closest?.('.row[data-href]'); if (row && e.key === 'Enter') { rememberRow(row.dataset.href); location.hash = row.dataset.href; } });
window.addEventListener('hashchange', route);
initTabs($app);
updateBanner();
route();
// sincronizzazione: impostazioni arrivate da un altro dispositivo, stato del collegamento nella pagina Impostazioni
window.addEventListener('settings-changed', updateBanner);
window.addEventListener('sync-changed', () => { if (document.getElementById('synccard') && !document.getElementById('spaircode')?.innerHTML && !document.getElementById('sres')?.innerHTML) syncSettings(); });
initSync();
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // iscrizione push scaduta o cambiata dal browser: la rinnovo e riregistro i voli seguiti (senza chiedere nulla)
  setTimeout(() => checkPush().catch(() => {}), 4000);
}
