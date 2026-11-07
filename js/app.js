import { getBoard, getFlight, getInbound, getLivePosition, getAirportInfo, isoDate, testKey, getFlightsByReg, liveByReg, testWorker, OFFICIAL_AIRPORTS, officialInfo } from './api.js';
import { searchAirports, airportByIata } from './airports.js';
import { getSettings, saveSettings, getFavorites, isFavorite, toggleFavorite, exportFavorites, importFavorites } from './store.js';
import { greatCircle, distanceKm } from './demo.js';

function officialNote(iata, dir, list) {
  if (!OFFICIAL_AIRPORTS[iata] || getSettings().provider !== 'aerodatabox') return '';
  const i = officialInfo[`${iata}:${dir === 'dep' ? 'D' : 'A'}`];
  if (!i) return '';
  if (i.error) return `<p class="hint">⚠ Tabellone ufficiale non disponibile: ${esc(i.error)}</p>`;
  const n = list.filter(x => x._official).length;
  if (!n) return `<p class="hint">⚠ Tabellone ufficiale letto (${i.count} voli) ma nessun volo abbinato a quelli di AeroDataBox</p>`;
  return `<p class="hint official">✓ Gate, orari stimati e stato dal tabellone ufficiale dell’aeroporto (abbinati ${n} su ${list.length})</p>`;
}

const APP_VERSION = '2.5 · tabelloni ufficiali anche per Fiumicino e Ciampino';
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
const regHref = (reg, date) => `#/aircraft/${encodeURIComponent(reg)}/${date || isoDate(new Date())}`;
const regLink = (reg, date, small) => `<a class="reglink" href="${regHref(reg, date)}" target="_blank" rel="noopener" title="Segui l'aereo in una nuova scheda">✈︎ ${esc(reg)}${small ? '' : ' ↗'}</a>`;
function aircraftCard(ac, date, note = '', probable = false) {
  return `<span class="eyebrow">Aeromobile${probable ? ' (probabile)' : ''}</span>
    <p>${ac?.reg ? `${regLink(ac.reg, date)} · <a href="${regHref(ac.reg, date)}" target="_blank" rel="noopener">segui l'aereo e i suoi voli di oggi in una nuova scheda</a>` : '<b>Non ancora assegnato</b>'}${ac?.model ? ` · ${esc(ac.model)}` : ''}${ac?.hex ? ` · ICAO24 <code>${esc(ac.hex)}</code>` : ''}</p>
    ${note ? `<p class="hint">${note}</p>` : ''}`;
}
const errorBox = e => `<div class="error">⚠️ ${esc(e.message || e)}</div>`;

function timeCell(sched, revised, actual) {
  const best = actual || revised;
  const d = minutesBetween(sched, best);
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
    <input id="q" type="search" placeholder="Aeroporto (FCO, Milano…), volo (FR1234) o aereo (EI-DCL)" aria-label="Cerca aeroporto o volo">
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
    else if (/^[A-Z]{3}$/.test(v)) location.hash = `#/airport/${v}/dep`;
    else { const a = searchAirports(v)[0]; if (a) location.hash = `#/airport/${a.iata}/dep`; }
  });
}

// ---------- Home / preferiti ----------
function viewHome() {
  const fav = getFavorites();
  const popular = ['FCO', 'MXP', 'LIN', 'BGY', 'VCE', 'NAP', 'CTA', 'LHR', 'CDG', 'FRA'];
  $app.innerHTML = `
    <section class="hero">${searchBox()}</section>
    <section><h2>Aeroporti preferiti</h2>
      ${fav.airports.length ? `<div class="chips">${fav.airports.map(a => `<a class="chip" href="#/airport/${a.iata}/dep"><b>${a.iata}</b> ${esc(a.name || apName(a.iata))}${star(true, favAttrs('airports', { iata: a.iata }))}</a>`).join('')}</div>`
        : `<p class="hint">Nessun aeroporto salvato. Apri un tabellone e tocca ☆.</p>`}
    </section>
    <section><h2>Tratte preferite</h2>
      ${fav.routes.length ? `<div class="chips">${fav.routes.map(r => `<a class="chip" href="#/route/${r.from}/${r.to}"><b>${r.from} → ${r.to}</b> ${esc(apName(r.from))} – ${esc(apName(r.to))}${star(true, favAttrs('routes', { from: r.from, to: r.to }))}</a>`).join('')}</div>`
        : `<p class="hint">Nessuna tratta salvata. Dalla pagina di un volo tocca ☆ accanto alla tratta.</p>`}
    </section>
    <section><h2>Voli preferiti</h2>
      ${fav.flights.length ? `<div class="chips">${fav.flights.map(f => `<a class="chip" href="#/flight/${encodeURIComponent(f.number)}/${isoDate(new Date())}${f.dep ? `?dep=${f.dep}` : ''}"><b>${esc(f.number)}</b> ${f.dep && f.arr ? `${f.dep} → ${f.arr}` : ''}${star(true, favAttrs('flights', { number: f.number, dep: f.dep, arr: f.arr }))}</a>`).join('')}</div>`
        : `<p class="hint">Nessun volo salvato. Si apre sempre il volo di oggi con quel numero.</p>`}
    </section>
    <section><h2>Aerei preferiti</h2>
      ${fav.aircraft?.length ? `<div class="chips">${fav.aircraft.map(a => `<a class="chip" href="${regHref(a.reg)}"><b>${esc(a.reg)}</b> ${esc(a.model || '')}${star(true, favAttrs('aircraft', { reg: a.reg }))}</a>`).join('')}</div>`
        : `<p class="hint">Nessun aereo salvato. Dalla pagina di un aereo tocca ☆.</p>`}
    </section>
    <section><h2>Aeroporti principali</h2>
      <div class="chips">${popular.map(c => `<a class="chip small" href="#/airport/${c}/dep"><b>${c}</b> ${esc(apName(c))}</a>`).join('')}</div>
    </section>`;
  bindSearch();
  bindStars($app, viewHome);
}

// ---------- Tabellone ----------
function boardTable(list, dir, filter = '') {
  const f = filter.trim().toLowerCase();
  const rows = list.filter(x => !f || [x.number, x.airline?.name, x.dep?.iata, x.dep?.name, x.arr?.iata, x.arr?.name].some(v => String(v || '').toLowerCase().includes(f)));
  if (!rows.length) return `<p class="hint">Nessun volo${f ? ' corrisponde al filtro' : ' nella finestra da 2 ore fa a 10 ore avanti'}.</p>`;
  const now = Date.now();
  let marked = false;
  return `<div class="board" role="table">
    <div class="row head" role="row"><span>Ora</span><span>Volo</span><span>${dir === 'dep' ? 'Destinazione' : 'Provenienza'}</span><span>${dir === 'dep' ? 'Gate' : 'Nastro'}</span><span>Stato</span></div>
    ${rows.map(x => {
      const side = dir === 'dep' ? x.dep : x.arr, other = dir === 'dep' ? x.arr : x.dep;
      let nowLine = '';
      if (!marked && side?.sched?.utc && new Date(side.sched.utc) > now) { marked = true; nowLine = '<div class="nowline"><span>adesso</span></div>'; }
      return `${nowLine}<div class="row ${x.status === 'Canceled' ? 'cancel' : ''}" role="row" tabindex="0" data-href="${flightLink(x)}">
        <span class="t">${timeCell(side?.sched, side?.revised, side?.actual)}</span>
        <span class="num"><a href="${flightLink(x)}"><b>${esc(x.number)}</b></a><small>${x.aircraft?.reg ? regLink(x.aircraft.reg, flightDate(x), true) : esc(x.airline?.name || '')}</small></span>
        <span class="dest"><b>${esc(other?.name || other?.iata || '—')}</b><small>${esc(other?.iata || '')}${side?.terminal ? ` · T${esc(side.terminal)}` : ''}</small></span>
        <span class="gate">${esc((dir === 'dep' ? side?.gate : side?.belt) || '—')}</span>
        <span>${statusBadge(x.status)}</span>
      </div>`;
    }).join('')}
  </div>`;
}

async function viewAirport(iata, dir = 'dep', onlyTo = null) {
  iata = iata.toUpperCase();
  const info = airportByIata(iata) || await getAirportInfo(iata) || { iata, name: iata };
  let data = null, filter = '';
  const isRoute = !!onlyTo;
  document.title = isRoute ? `${iata} → ${onlyTo} · Voli` : `${iata} ${dir === 'dep' ? 'Partenze' : 'Arrivi'} · Voli`;
  const render = () => {
    const title = isRoute ? `${iata} → ${onlyTo}` : `${iata}`;
    const favBtn = isRoute ? star(isFavorite('routes', { from: iata, to: onlyTo }), favAttrs('routes', { from: iata, to: onlyTo }))
      : star(isFavorite('airports', { iata }), favAttrs('airports', { iata, name: info.name }));
    const list = data ? (dir === 'dep' ? data.departures : data.arrivals) : [];
    const filtered = isRoute ? list.filter(x => x.arr?.iata === onlyTo) : list;
    $app.innerHTML = `
      <div class="pagehead">
        <div><h1>${esc(title)} ${favBtn}</h1><p class="sub">${esc(isRoute ? `${apName(iata)} – ${apName(onlyTo)} · partenze nelle prossime 10 ore` : info.name)}</p></div>
        <button class="ghost" id="refresh" title="Aggiorna">↻</button>
      </div>
      ${isRoute ? `<p class="links"><a href="#/route/${onlyTo}/${iata}">Tratta inversa ${onlyTo} → ${iata}</a> · <a href="#/airport/${iata}/dep">Tabellone ${iata}</a></p>` : `
      <div class="tabs">
        <a href="#/airport/${iata}/dep" class="${dir === 'dep' ? 'active' : ''}">🛫 Partenze</a>
        <a href="#/airport/${iata}/arr" class="${dir === 'arr' ? 'active' : ''}">🛬 Arrivi</a>
        <input id="filter" type="search" placeholder="Filtra: città, volo, compagnia" value="${esc(filter)}">
      </div>`}
      ${data?.degraded ? `<p class="hint">⚠ AeroDataBox non disponibile, mostro solo il tabellone ufficiale dell’aeroporto. ${esc(data.degraded)}</p>` : data ? officialNote(iata, isRoute ? 'dep' : dir, list) : ''}
      <div id="board">${data ? boardTable(filtered, isRoute ? 'dep' : dir, filter) : '<div class="loading">Caricamento tabellone…</div>'}</div>
      <p class="updated" id="updated"></p>`;
    bindStars($app, render);
    document.getElementById('refresh').onclick = load;
    const fi = document.getElementById('filter');
    if (fi) fi.oninput = () => { filter = fi.value; document.getElementById('board').innerHTML = boardTable(filtered, dir, filter); };
  };
  const load = async () => {
    try {
      data = await getBoard(iata);
      const keep = document.getElementById('filter') === document.activeElement;
      render();
      if (keep) { const fi = document.getElementById('filter'); fi.focus(); fi.setSelectionRange(fi.value.length, fi.value.length); }
      document.getElementById('updated').textContent = `Aggiornato alle ${new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })} · aggiornamento automatico ogni ${getSettings().refreshSec}s`;
    } catch (e) { document.getElementById('board').innerHTML = errorBox(e); }
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
  if (!inbound || ['Departed', 'EnRoute', 'Approaching', 'Arrived', 'Canceled'].includes(f.status)) return '';
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

function legCard(f, title, cls = '') {
  const p = progress(f);
  return `<div class="card leg ${cls}">
    <div class="leghead"><span class="eyebrow">${title}</span>${statusBadge(f.status)}</div>
    <div class="legrow">
      <div class="end"><div class="code">${esc(f.dep.iata || '—')}</div><div class="city">${esc(f.dep.name || '')}</div>
        <div class="time">${timeCell(f.dep.sched, f.dep.revised, f.dep.actual)}</div>
        <dl>${f.dep.terminal ? `<dt>Terminal</dt><dd>${esc(f.dep.terminal)}</dd>` : ''}<dt>Gate</dt><dd class="big">${esc(f.dep.gate || '—')}</dd>${f.dep.checkIn ? `<dt>Check-in</dt><dd>${esc(f.dep.checkIn)}</dd>` : ''}</dl></div>
      <div class="mid"><div class="track"><div class="fill" style="width:${p * 100}%"></div><div class="dot" style="left:${p * 100}%">✈︎</div></div>
        <small>${esc(f.number)}${f.aircraft?.model ? ` · ${esc(f.aircraft.model)}` : ''}</small></div>
      <div class="end right"><div class="code">${esc(f.arr.iata || '—')}</div><div class="city">${esc(f.arr.name || '')}</div>
        <div class="time">${timeCell(f.arr.sched, f.arr.revised, f.arr.actual)}</div>
        <dl>${f.arr.terminal ? `<dt>Terminal</dt><dd>${esc(f.arr.terminal)}</dd>` : ''}<dt>Gate</dt><dd>${esc(f.arr.gate || '—')}</dd><dt>Nastro</dt><dd>${esc(f.arr.belt || '—')}</dd></dl></div>
    </div>
  </div>`;
}

async function viewFlight(number, date, depHint) {
  $app.innerHTML = `<div class="loading">Cerco il volo ${esc(number)}…</div>`;
  let legs;
  try { legs = await getFlight(number, date, depHint); } catch (e) { $app.innerHTML = errorBox(e); return; }
  if (!legs.length) { $app.innerHTML = `<div class="error">Nessun volo ${esc(number)} trovato il ${esc(date)}.</div><p><a href="#/">← Torna ai preferiti</a></p>`; return; }
  let f = legs.find(l => l.dep?.iata === depHint) || legs[0];
  document.title = `${f.number} ${f.dep?.iata || ''}→${f.arr?.iata || ''} · Voli`;

  const day = d => isoDate(new Date(new Date(`${date}T12:00:00`).getTime() + d * 86400e3));
  $app.innerHTML = `
    <div class="pagehead">
      <div><h1>${esc(f.number)} ${star(isFavorite('flights', { number: f.number }), favAttrs('flights', { number: f.number, dep: f.dep.iata, arr: f.arr.iata }))}</h1>
      <p class="sub">${esc(f.airline?.name || '')} · ${esc(new Date(`${date}T12:00:00`).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' }))}</p></div>
      <div class="daynav"><a class="ghost" href="#/flight/${encodeURIComponent(number)}/${day(-1)}">‹ Ieri</a><a class="ghost" href="#/flight/${encodeURIComponent(number)}/${day(1)}">Domani ›</a></div>
    </div>
    ${legs.length > 1 ? `<div class="tabs">${legs.map(l => `<a href="#/flight/${encodeURIComponent(number)}/${date}?dep=${l.dep.iata}" class="${l === f ? 'active' : ''}">${l.dep.iata} → ${l.arr.iata}</a>`).join('')}</div>` : ''}
    <p class="links">Tratta <b>${esc(f.dep.iata)} → ${esc(f.arr.iata)}</b> ${star(isFavorite('routes', { from: f.dep.iata, to: f.arr.iata }), favAttrs('routes', { from: f.dep.iata, to: f.arr.iata }))}
      · <a href="#/route/${f.dep.iata}/${f.arr.iata}">altri voli su questa tratta</a> · <a href="#/airport/${f.dep.iata}/dep">tabellone ${esc(f.dep.iata)}</a></p>
    ${f._degraded ? `<p class="hint">⚠ AeroDataBox non disponibile: dati dal tabellone ufficiale dell’aeroporto. ${esc(f._degraded)}</p>` : ''}
    <div id="predict"></div>
    <div id="leg">${legCard(f, 'Questo volo')}</div>
    <div class="card"><div class="leghead"><span class="eyebrow">Posizione dell'aereo</span><span id="livemeta" class="sub"></span></div><div id="map" class="map"></div></div>
    <div class="card" id="aircraft">${aircraftCard(f.aircraft, date)}</div>
    <div id="inbound"><div class="card"><span class="eyebrow">Da dove arriva l'aereo</span><p class="loading">Cerco la tratta precedente…</p></div></div>`;
  bindStars($app);

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

  // tratta precedente
  let inbound = null;
  try {
    const hadReg = !!f.aircraft?.reg;
    const r = await getInbound(f);
    inbound = r.inbound;
    let html = `<div class="card"><span class="eyebrow">Da dove arriva l'aereo</span><p class="hint">${esc(r.reason)}</p></div>`;
    if (inbound) {
      const turn = minutesBetween(inbound.arr.revised || inbound.arr.sched, f.dep.revised || f.dep.sched);
      const guess = r.method === 'guess';
      html = `${legCard(inbound, `Da dove arriva l'aereo · ${guess ? 'probabile volo precedente' : 'volo precedente'} <a href="${flightLink(inbound)}">${esc(inbound.number)}</a>`, 'inbound')}
        ${guess ? `<p class="note">ℹ️ Stima: ${esc(f.airline?.name || 'la compagnia')} non ha ancora indicato quale aereo farà il volo. ${r.basis === 'rotation'
          ? `Abbinando in ordine di tempo gli aerei ${esc(f.airline?.name || '')} arrivati a ${esc(f.dep.iata)} con le sue partenze ancora senza aereo, a questo volo tocca quello in arrivo da ${esc(inbound.dep.iata)}.`
          : `Questo è il suo volo in arrivo da ${esc(inbound.dep.iata)} poco prima della partenza: le low cost di solito fanno andata e ritorno con lo stesso aereo.`}</p>` : ''}
        <p class="note ${turn < 35 ? 'warn' : ''}">${turn < 35 ? '⚠️ ' : ''}Tempo di rotazione a ${esc(f.dep.iata)}: <b>${turn} min</b> tra l'arrivo dell'aereo e la partenza prevista${turn < 35 ? ': un ritardo del volo precedente si ripercuoterà probabilmente su questo.' : '.'}</p>`;
      const P = inbound.dep.lat != null ? inbound.dep : await getAirportInfo(inbound.dep.iata);
      if (P?.lat != null && A?.lat != null) {
        L.polyline(arc(P, A), { color: '#7aa2ff', weight: 2, dashArray: '6 6' }).addTo(map);
        L.marker([P.lat, P.lon], { icon: apIcon(inbound.dep.iata) }).addTo(map);
        bounds.push([P.lat, P.lon]); map.fitBounds(bounds, { padding: [30, 30] });
      }
    }
    document.getElementById('inbound').innerHTML = html;
    document.getElementById('predict').innerHTML = predictionHtml(f, inbound);
    const card = document.getElementById('aircraft');
    if (inbound && r.method === 'guess' && !f.aircraft?.reg && inbound.aircraft?.reg) {
      card.innerHTML = aircraftCard(inbound.aircraft, date, `Stima basata sul volo precedente ${esc(inbound.number)}: la compagnia non ha ancora confermato l'aereo.`, true);
    } else if (inbound && r.method === 'reg' && f.aircraft?.reg && !hadReg) {
      card.innerHTML = aircraftCard(f.aircraft, date, `La compagnia non lo indica sul volo, ma la giornata di questo aereo (arrivato con ${esc(inbound.number)}) prevede proprio ${esc(f.number)}.`);
    }
  } catch (e) { document.getElementById('inbound').innerHTML = errorBox(e); }

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
        document.getElementById('leg').innerHTML = legCard(f, 'Questo volo');
      }
      if (!marker) marker = L.marker([pos.lat, pos.lon], { icon: planeIcon(pos.track), zIndexOffset: 1000 }).addTo(map);
      else marker.setLatLng([pos.lat, pos.lon]).setIcon(planeIcon(pos.track));
      meta.innerHTML = `Aereo a terra${where ? ` a <b>${esc(where)}</b>` : ''}${groundAtDep ? ' · il volo non è ancora decollato' : ''} · fonte ${esc(pos.source)}`;
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
    meta.innerHTML = `In volo come <b>${esc(on)}</b> · ${pos.alt != null ? `${Math.round(pos.alt).toLocaleString('it-IT')} ft` : ''}${pos.gs != null ? ` · ${Math.round(pos.gs)} kt` : ''} · fonte ${esc(pos.source)}`;
  };
  await live();
  every(15, live);
  // ricarica i dati del volo (gate, orari, stato)
  every(getSettings().refreshSec, async () => {
    try {
      const fresh = (await getFlight(number, date, depHint)).find(l => l.dep?.iata === f.dep.iata);
      if (fresh) { Object.assign(f, fresh); if (groundAtDep && AIR.includes(f.status)) f.status = 'OnGround'; document.getElementById('leg').innerHTML = legCard(f, 'Questo volo'); }
    } catch { /* riprova al giro successivo */ }
  });
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
      <span class="num"><b>${esc(f.number)}</b><small>${esc(f.airline?.name || '')}</small></span>
      <span class="dest"><b>${esc(f.dep?.iata || '—')} → ${esc(f.arr?.iata || '—')}</b><small>${esc(apName(f.dep?.iata))} – ${esc(apName(f.arr?.iata))}</small></span>
      <span class="t">${timeCell(f.arr?.sched, f.arr?.revised, f.arr?.actual)}</span>
      <span>${statusBadge(f.status)}${f._inferred ? '<small title="Stato dedotto: una tratta successiva è già partita">dedotto</small>' : ''}</span></a>`;
  }).join('');
}

async function viewAircraft(reg, date) {
  reg = reg.toUpperCase();
  const day = d => isoDate(new Date(new Date(`${date}T12:00:00`).getTime() + d * 86400e3));
  const isToday = date === isoDate(new Date());
  $app.innerHTML = `<div class="loading">Cerco i voli di ${esc(reg)}…</div>`;
  let list, adsb = null;
  try {
    [list, adsb] = await Promise.all([getFlightsByReg(reg, date), isToday ? liveByReg(reg) : null]);
  } catch (e) { $app.innerHTML = errorBox(e); return; }
  const build = () => {
    let legs = cleanLegs(list);
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
  const model = list.find(f => f.aircraft?.model)?.aircraft.model || adsb?.model || '';
  $app.innerHTML = `
    <div class="pagehead">
      <div><h1>✈︎ ${esc(reg)} ${star(isFavorite('aircraft', { reg }), favAttrs('aircraft', { reg, model }))}</h1><p class="sub">${esc(model)}${model ? ' · ' : ''}${esc(new Date(`${date}T12:00:00`).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' }))}</p></div>
      <div class="daynav"><a class="ghost" href="#/aircraft/${encodeURIComponent(reg)}/${day(-1)}">‹ Ieri</a><a class="ghost" href="#/aircraft/${encodeURIComponent(reg)}/${day(1)}">Domani ›</a></div>
    </div>
    <div class="card"><div class="leghead"><span class="eyebrow">Posizione dell'aereo</span><span id="acpos" class="sub"></span></div><div id="map" class="map"></div></div>
    <div id="rot">${legs.length ? `<div class="board"><div class="row head rot"><span>Partenza</span><span>Volo</span><span>Tratta</span><span>Arrivo</span><span>Stato</span></div>${rotRows(legs)}</div>`
      : `<p class="hint">Nessun volo trovato per ${esc(reg)} in questa data. Controlla le marche (es. EI-DCL) o prova il giorno prima/dopo.</p>`}</div>
    <p class="hint">I voli vengono da AeroDataBox, che conosce una tratta solo quando la compagnia ha assegnato l'aereo: per le low cost le tratte future spesso mancano. La riga "dalla rete ADS-B" è il volo che l'aereo sta facendo adesso secondo i ricevitori radar amatoriali.</p>`;
  bindStars($app);
  document.title = `✈︎ ${reg} · Voli`;
  const map = L.map('map', { worldCopyJump: true });
  maps.push(map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 12, attribution: '© OpenStreetMap' }).addTo(map);
  map.setView([45, 10], 4);
  let marker = null, routeLayer = null, drawnKey = null;
  const trail = [];
  const trailLine = L.polyline(trail, { color: '#38d39f', weight: 3 }).addTo(map);
  const live = async () => {
    const el = document.getElementById('acpos');
    if (!el) return;
    if (isToday) { adsb = await liveByReg(reg) || adsb; }
    const flying = legs.find(f => f._adsb) || legs.find(f => AIR.includes(f.status));
    const focus = flying || legs.filter(f => f.dep?.actual).pop() || legs[0];
    const key = focus && `${focus.dep?.iata}-${focus.arr?.iata}`;
    if (focus && key !== drawnKey && focus.dep?.iata && focus.arr?.iata) {
      drawnKey = key;
      const [A, B] = await Promise.all([focus.dep.lat != null ? focus.dep : getAirportInfo(focus.dep.iata), focus.arr.lat != null ? focus.arr : getAirportInfo(focus.arr.iata)]);
      if (routeLayer) routeLayer.remove();
      if (A?.lat != null && B?.lat != null) {
        routeLayer = L.layerGroup([L.polyline(arc(A, B), { color: '#f5b301', weight: 3 }), L.marker([A.lat, A.lon], { icon: apIcon(focus.dep.iata) }), L.marker([B.lat, B.lon], { icon: apIcon(focus.arr.iata) })]).addTo(map);
        map.fitBounds([[A.lat, A.lon], [B.lat, B.lon]], { padding: [30, 30] });
      }
    }
    let pos = adsb?.pos && !adsb.onGround ? adsb.pos : null;
    if (!pos && flying && !flying._adsb) pos = await getLivePosition(flying).catch(() => null);
    if (!pos) {
      el.innerHTML = adsb?.onGround ? 'A terra in questo momento (rete ADS-B)' : flying ? `In volo come <b>${esc(flying.number)}</b>, posizione non disponibile` : 'A terra o fuori copertura in questo momento';
      return;
    }
    trail.push([pos.lat, pos.lon]); trailLine.setLatLngs(trail);
    if (!marker) { marker = L.marker([pos.lat, pos.lon], { icon: planeIcon(pos.track), zIndexOffset: 1000 }).addTo(map); if (!routeLayer) map.setView([pos.lat, pos.lon], 6); }
    else marker.setLatLng([pos.lat, pos.lon]).setIcon(planeIcon(pos.track));
    const label = flying ? (flying._adsb ? `<b>${esc(flying.number)}</b>${flying.dep?.iata ? ` ${esc(flying.dep.iata)} → ${esc(flying.arr.iata)}` : ''}` : `<a href="${flightLink(flying)}"><b>${esc(flying.number)}</b></a> ${esc(flying.dep?.iata || '')} → ${esc(flying.arr?.iata || '')}`) : '';
    el.innerHTML = `In volo${label ? ` come ${label}` : ''}${pos.alt != null ? ` · ${Math.round(pos.alt).toLocaleString('it-IT')} ft` : ''}${pos.gs != null ? ` · ${Math.round(pos.gs)} kt` : ''} · fonte ${esc(pos.source)}`;
  };
  await live();
  every(15, live);
  every(getSettings().refreshSec, async () => {
    try {
      list = await getFlightsByReg(reg, date);
      legs = build();
      const r = document.getElementById('rot');
      if (r && legs.length) r.innerHTML = `<div class="board"><div class="row head rot"><span>Partenza</span><span>Volo</span><span>Tratta</span><span>Arrivo</span><span>Stato</span></div>${rotRows(legs)}</div>`;
    } catch { /* riprova */ }
  });
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
      <label>Indirizzo del tuo Cloudflare Worker (tabelloni ufficiali di Pisa, Firenze, Ginevra)<input name="workerUrl" type="url" value="${esc(s.workerUrl || '')}" placeholder="https://tabellone-voli.tuonome.workers.dev"></label>
      <p class="hint">Facoltativo. Con il Worker, per questi aeroporti gate, orari stimati e stato arrivano dal tabellone dell'aeroporto (per Ginevra anche le marche dell'aereo). Istruzioni: <a href="https://github.com/gbagliesi/app-aerei/blob/main/worker/README.md" target="_blank" rel="noopener">worker/README.md</a>. <button type="button" class="ghost" id="testw">Prova il Worker</button></p>
      <div id="testwres"></div>
      <label>Aggiornamento automatico tabelloni (secondi)<input name="refreshSec" type="number" min="30" max="600" value="${s.refreshSec}"></label>
      <p class="hint">Ogni aggiornamento consuma una chiamata API: con il piano gratuito conviene 120–300 secondi.</p>
      <button>Salva</button> <button type="button" class="ghost" id="test">Prova la chiave</button> <span id="saved" class="sub"></span>
      <div id="testres"></div>
    </form>
    <div class="card">
      <span class="eyebrow">Tracking in tempo reale</span>
      <p class="hint">La posizione dell'aereo arriva da AeroDataBox quando disponibile, altrimenti dalle reti ADS-B gratuite <b>adsb.lol</b> e <b>OpenSky Network</b>, cercando l'aereo per codice ICAO24. Nessuna chiave richiesta.</p>
    </div>
    <div class="card">
      <span class="eyebrow">Preferiti</span>
      <p class="hint">I preferiti sono salvati in questo browser. Esportali per spostarli su un altro dispositivo.</p>
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
  document.getElementById('exp').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([exportFavorites()], { type: 'application/json' }));
    a.download = 'preferiti-voli.json'; a.click();
  };
  document.getElementById('imp').onchange = async e => {
    try { importFavorites(await e.target.files[0].text()); alert('Preferiti importati'); } catch { alert('File non valido'); }
  };
}

// ---------- router ----------
function updateBanner() { document.getElementById('demo-banner').hidden = getSettings().provider === 'aerodatabox'; }

function route() {
  clearPage();
  document.title = 'Tabellone Voli';
  const [path, qs] = location.hash.slice(1).split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(qs || '');
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === (parts[0] || 'home')));
  window.scrollTo(0, 0);
  if (parts[0] === 'airport' && parts[1]) return viewAirport(parts[1], parts[2] === 'arr' ? 'arr' : 'dep');
  if (parts[0] === 'route' && parts[1] && parts[2]) return viewAirport(parts[1], 'dep', parts[2].toUpperCase());
  if (parts[0] === 'flight' && parts[1]) return viewFlight(parts[1].toUpperCase(), parts[2] || isoDate(new Date()), params.get('dep'));
  if (parts[0] === 'aircraft' && parts[1]) return viewAircraft(parts[1], parts[2] || isoDate(new Date()));
  if (parts[0] === 'settings') return viewSettings();
  return viewHome();
}

document.addEventListener('click', e => {
  const row = e.target.closest('.row[data-href]');
  if (!row || e.target.closest('a, button')) return;
  if (e.metaKey || e.ctrlKey) window.open(row.dataset.href, '_blank'); else location.hash = row.dataset.href;
});
document.addEventListener('keydown', e => { const row = e.target.closest?.('.row[data-href]'); if (row && e.key === 'Enter') location.hash = row.dataset.href; });
window.addEventListener('hashchange', route);
updateBanner();
route();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
