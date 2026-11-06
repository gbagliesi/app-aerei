import { getBoard, getFlight, getInbound, getLivePosition, getAirportInfo, isoDate, testKey } from './api.js';
import { searchAirports, airportByIata } from './airports.js';
import { getSettings, saveSettings, getFavorites, isFavorite, toggleFavorite, exportFavorites, importFavorites } from './store.js';
import { greatCircle } from './demo.js';

const $app = document.getElementById('app');
let timers = [];
let maps = [];
const clearPage = () => { timers.forEach(clearInterval); timers = []; maps.forEach(m => m.remove()); maps = []; };
const every = (sec, fn) => timers.push(setInterval(fn, sec * 1000));

// ---------- utilità ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hhmm = t => t?.local ? t.local.slice(11, 16) : '—';
const minutesBetween = (a, b) => a?.utc && b?.utc ? Math.round((new Date(b.utc) - new Date(a.utc)) / 60e3) : 0;

const STATUS = {
  Unknown: ['Sconosciuto', 'muted'], Expected: ['Previsto', 'ok'], CheckIn: ['Check-in', 'ok'],
  Boarding: ['Imbarco', 'go'], GateClosed: ['Gate chiuso', 'warn'], Departed: ['Decollato', 'go'],
  EnRoute: ['In volo', 'go'], Approaching: ['In avvicinamento', 'go'], Delayed: ['In ritardo', 'warn'],
  Arrived: ['Atterrato', 'done'], Canceled: ['Cancellato', 'bad'], CanceledUncertain: ['Forse cancellato', 'bad'],
  Diverted: ['Dirottato', 'bad'],
};
const statusBadge = s => { const [t, c] = STATUS[s] || [s, 'muted']; return `<span class="badge ${c}">${esc(t)}</span>`; };
const star = (on, attrs) => `<button class="star ${on ? 'on' : ''}" ${attrs} aria-pressed="${on}" title="${on ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti'}">${on ? '★' : '☆'}</button>`;
const flightDate = f => f.dep?.sched?.local?.slice(0, 10) || isoDate(new Date());
const flightLink = f => `#/flight/${encodeURIComponent(f.number)}/${flightDate(f)}${f.dep?.iata ? `?dep=${f.dep.iata}` : ''}`;
const apName = iata => airportByIata(iata)?.city || iata;
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
    <input id="q" type="search" placeholder="Aeroporto (FCO, Milano…) o volo (AZ610)" aria-label="Cerca aeroporto o volo">
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
      return `${nowLine}<a class="row ${x.status === 'Canceled' ? 'cancel' : ''}" role="row" href="${flightLink(x)}">
        <span class="t">${timeCell(side?.sched, side?.revised, side?.actual)}</span>
        <span class="num"><b>${esc(x.number)}</b><small>${esc(x.airline?.name || '')}</small></span>
        <span class="dest"><b>${esc(other?.name || other?.iata || '—')}</b><small>${esc(other?.iata || '')}${side?.terminal ? ` · T${esc(side.terminal)}` : ''}</small></span>
        <span class="gate">${esc((dir === 'dep' ? side?.gate : side?.belt) || '—')}</span>
        <span>${statusBadge(x.status)}</span>
      </a>`;
    }).join('')}
  </div>`;
}

async function viewAirport(iata, dir = 'dep', onlyTo = null) {
  iata = iata.toUpperCase();
  const info = airportByIata(iata) || await getAirportInfo(iata) || { iata, name: iata };
  let data = null, filter = '';
  const isRoute = !!onlyTo;
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

// ---------- Dettaglio volo ----------
const planeIcon = track => L.divIcon({ className: 'plane', html: `<div style="transform:rotate(${(track || 0) - 45}deg)">✈︎</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
const apIcon = code => L.divIcon({ className: 'apmark', html: `<span>${esc(code)}</span>`, iconSize: [40, 18], iconAnchor: [20, 9] });

function arc(a, b) { return Array.from({ length: 65 }, (_, i) => greatCircle(a, b, i / 64)).map(p => [p.lat, p.lon]); }

function progress(f) {
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
  try { legs = await getFlight(number, date); } catch (e) { $app.innerHTML = errorBox(e); return; }
  if (!legs.length) { $app.innerHTML = `<div class="error">Nessun volo ${esc(number)} trovato il ${esc(date)}.</div><p><a href="#/">← Torna ai preferiti</a></p>`; return; }
  let f = legs.find(l => l.dep?.iata === depHint) || legs[0];

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
    <div id="leg">${legCard(f, 'Questo volo')}</div>
    <div class="card"><div class="leghead"><span class="eyebrow">Posizione dell'aereo</span><span id="livemeta" class="sub"></span></div><div id="map" class="map"></div></div>
    <div class="card" id="aircraft"><span class="eyebrow">Aeromobile</span>
      <p><b>${esc(f.aircraft?.reg || 'Non ancora assegnato')}</b>${f.aircraft?.model ? ` · ${esc(f.aircraft.model)}` : ''}${f.aircraft?.hex ? ` · ICAO24 <code>${esc(f.aircraft.hex)}</code>` : ''}</p></div>
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
    const r = await getInbound(f);
    inbound = r.inbound;
    let html = `<div class="card"><span class="eyebrow">Da dove arriva l'aereo</span><p class="hint">${esc(r.reason)}</p></div>`;
    if (inbound) {
      const turn = minutesBetween(inbound.arr.revised || inbound.arr.sched, f.dep.revised || f.dep.sched);
      const guess = r.method === 'guess';
      html = `${legCard(inbound, `Da dove arriva l'aereo · ${guess ? 'probabile volo precedente' : 'volo precedente'} <a href="${flightLink(inbound)}">${esc(inbound.number)}</a>`, 'inbound')}
        ${guess ? `<p class="note">ℹ️ Stima: ${esc(f.airline?.name || 'la compagnia')} non ha ancora indicato quale aereo farà il volo. Questo è il suo volo in arrivo da ${esc(inbound.dep.iata)} poco prima della partenza: le low cost di solito fanno andata e ritorno con lo stesso aereo.</p>` : ''}
        <p class="note ${turn < 35 ? 'warn' : ''}">${turn < 35 ? '⚠️ ' : ''}Tempo di rotazione a ${esc(f.dep.iata)}: <b>${turn} min</b> tra l'arrivo dell'aereo e la partenza prevista${turn < 35 ? ': un ritardo del volo precedente si ripercuoterà probabilmente su questo.' : '.'}</p>`;
      const P = inbound.dep.lat != null ? inbound.dep : await getAirportInfo(inbound.dep.iata);
      if (P?.lat != null && A?.lat != null) {
        L.polyline(arc(P, A), { color: '#7aa2ff', weight: 2, dashArray: '6 6' }).addTo(map);
        L.marker([P.lat, P.lon], { icon: apIcon(inbound.dep.iata) }).addTo(map);
        bounds.push([P.lat, P.lon]); map.fitBounds(bounds, { padding: [30, 30] });
      }
    }
    document.getElementById('inbound').innerHTML = html;
    if (inbound && r.method === 'guess' && !f.aircraft?.reg && inbound.aircraft?.reg) {
      document.getElementById('aircraft').innerHTML = `<span class="eyebrow">Aeromobile (probabile)</span>
        <p><b>${esc(inbound.aircraft.reg)}</b>${inbound.aircraft.model ? ` · ${esc(inbound.aircraft.model)}` : ''}${inbound.aircraft.hex ? ` · ICAO24 <code>${esc(inbound.aircraft.hex)}</code>` : ''}</p>
        <p class="hint">Ricavato dalla rete ADS-B seguendo il volo precedente ${esc(inbound.number)}: la compagnia non ha ancora confermato l'aereo.</p>`;
    }
  } catch (e) { document.getElementById('inbound').innerHTML = errorBox(e); }

  // tracking live (stesso aeromobile: se il volo non è partito, si segue sulla tratta precedente)
  let marker = null, trail = null;
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
      const fresh = (await getFlight(number, date)).find(l => l.dep?.iata === f.dep.iata);
      if (fresh) { Object.assign(f, fresh); document.getElementById('leg').innerHTML = legCard(f, 'Questo volo'); }
    } catch { /* riprova al giro successivo */ }
  });
}

// ---------- Impostazioni ----------
function viewSettings() {
  const s = getSettings();
  $app.innerHTML = `
    <h1>Impostazioni</h1>
    <form class="card settings" id="sf">
      <span class="eyebrow">Fonte dati voli</span>
      <label class="radio"><input type="radio" name="provider" value="demo" ${s.provider !== 'aerodatabox' ? 'checked' : ''}> <span><b>Demo</b> · voli simulati, nessuna chiave richiesta</span></label>
      <label class="radio"><input type="radio" name="provider" value="aerodatabox" ${s.provider === 'aerodatabox' ? 'checked' : ''}> <span><b>AeroDataBox</b> · dati reali (tabelloni con gate, voli per numero e per aeromobile)</span></label>
      <label>Chiave API RapidAPI per AeroDataBox<input name="apiKey" type="password" value="${esc(s.apiKey)}" placeholder="incolla qui la X-RapidAPI-Key"></label>
      <p class="hint">Come ottenerla: crea un account su RapidAPI, abbonati ad <a href="https://rapidapi.com/aedbx-aedbx/api/aerodatabox" target="_blank" rel="noopener">AeroDataBox</a> (c'è un piano gratuito con poche centinaia di chiamate al mese, quelli a pagamento partono da pochi euro), poi copia la chiave. La chiave resta solo in questo browser.</p>
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
    saveSettings({ provider: fd.get('provider'), apiKey: fd.get('apiKey').trim(), refreshSec: Math.max(30, +fd.get('refreshSec') || 60) });
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
  const [path, qs] = location.hash.slice(1).split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(qs || '');
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === (parts[0] || 'home')));
  window.scrollTo(0, 0);
  if (parts[0] === 'airport' && parts[1]) return viewAirport(parts[1], parts[2] === 'arr' ? 'arr' : 'dep');
  if (parts[0] === 'route' && parts[1] && parts[2]) return viewAirport(parts[1], 'dep', parts[2].toUpperCase());
  if (parts[0] === 'flight' && parts[1]) return viewFlight(parts[1].toUpperCase(), parts[2] || isoDate(new Date()), params.get('dep'));
  if (parts[0] === 'settings') return viewSettings();
  return viewHome();
}

window.addEventListener('hashchange', route);
updateBanner();
route();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
