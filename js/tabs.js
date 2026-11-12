// Tab in cima alla pagina: ogni aeroporto, volo, tratta o aereo aperto resta in un tab per tornarci al volo.
// Desktop: barra di tab cliccabili. Telefono: stessa barra (scorrevole) + scorrimento orizzontale col dito sul contenuto.
import { airportByIata } from './airports.js';

const TKEY = 'aerei.tabs.v1';
const MAX = 12;
const pad = n => String(n).padStart(2, '0');
const localDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let tabs = load();
let active = null;           // chiave del tab attivo ('home', 'settings' o 'airport:FCO' ecc.)
const scrolls = {};          // posizione di scroll di ogni tab, per ritrovarla tornandoci
let pendingAnim = null;      // animazione d'ingresso dopo uno scorrimento col dito

function load() {
  try {
    const yday = localDate(new Date(Date.now() - 86400e3));
    const t = JSON.parse(localStorage.getItem(TKEY) || '[]');
    // i voli e gli aerei di giorni ormai passati si chiudono da soli
    return Array.isArray(t) ? t.filter(x => x?.key && x.hash && !(x.date && x.date < yday)) : [];
  } catch { return []; }
}
const save = () => { try { localStorage.setItem(TKEY, JSON.stringify(tabs)); } catch { /* spazio pieno */ } };
const find = key => tabs.find(t => t.key === key);

export function tabKey(parts) {
  const [k, a, b] = parts.map(s => String(s || '').toUpperCase());
  // partenze e arrivi dello stesso aeroporto in due tab separati (il tab partenze tiene la chiave di sempre)
  if (parts[0] === 'airport' && a) return `airport:${a}${b === 'ARR' ? ':ARR' : ''}`;
  if (parts[0] === 'route' && a && b) return `route:${a}-${b}`;
  if (parts[0] === 'flight' && a) return `flight:${a}`;
  if (parts[0] === 'aircraft' && a) return `aircraft:${a}`;
  if (parts[0] === 'settings') return 'settings';
  return 'home';
}

function describe(parts) {
  const [kind, a = '', b = '', c = ''] = parts;
  const A = a.toUpperCase(), B = b.toUpperCase();
  const city = x => airportByIata(x)?.city || '';
  const dayLabel = d => d && d !== localDate(new Date()) ? new Date(`${d}T12:00:00`).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }) : '';
  if (kind === 'airport') return { kind, title: A, sub: b === 'arr' ? 'Arrivi' : 'Partenze', city: city(A) };
  if (kind === 'route') return { kind, title: `${A}→${B}`, sub: 'tratta' };
  if (kind === 'flight') return { kind, title: A, sub: dayLabel(b) || 'volo', date: b || null };
  if (kind === 'aircraft') return { kind, title: A, sub: dayLabel(b) || 'aereo', date: b || null };
  return { kind, title: c, sub: '' };
}

/**
 * Chiamata dal router a ogni cambio di pagina. Apre o aggiorna il tab della pagina e
 * restituisce la posizione di scroll da ripristinare quando si torna su un tab già aperto (o null).
 */
export function enterTab(parts, hash, isNewEntry) {
  const key = tabKey(parts);
  const prev = active;
  if (prev && prev !== key) scrolls[prev] = Math.round(window.scrollY);
  let restore = null;
  if (key !== 'home' && key !== 'settings') {
    let t = find(key);
    const d = describe(parts);
    if (t) {
      if (isNewEntry && prev !== key && t.hash === hash && scrolls[key] != null) restore = scrolls[key];
      const dayChanged = (t.date ?? null) !== (d.date ?? null);
      if (d.kind === 'airport' || d.kind === 'route' || dayChanged) { t.sub = d.sub; t.dot = null; }
      t.hash = hash; t.date = d.date ?? null;
    } else {
      t = { key, hash, ...d };
      // voli e aerei si aprono accanto al tab da cui li apri (es. il tabellone), aeroporti e tratte in fondo
      const pair = d.kind === 'airport' ? tabs.findIndex(x => x.key.split(':').slice(0, 2).join(':') === key.split(':').slice(0, 2).join(':')) : -1;
      const i = d.kind === 'flight' || d.kind === 'aircraft' ? tabs.findIndex(x => x.key === prev) : pair;
      tabs.splice(i >= 0 ? i + 1 : tabs.length, 0, t);
    }
    t.used = Date.now();
    // troppi tab: chiudo quelli usati meno di recente
    while (tabs.length > MAX) {
      const old = tabs.filter(x => x !== t).sort((x, y) => (x.used || 0) - (y.used || 0))[0];
      tabs.splice(tabs.indexOf(old), 1);
    }
    save();
  } else if (key === 'home' && isNewEntry && prev !== key && scrolls.home != null) restore = scrolls.home;
  active = key;
  renderBar();
  return restore;
}

/** Le pagine aggiornano il sottotitolo del proprio tab (es. tratta e stato del volo). */
export function setTabInfo(key, { sub, dot } = {}) {
  const t = find(key);
  if (!t || ((sub == null || sub === t.sub) && (dot === undefined || dot === t.dot))) return;
  if (sub != null) t.sub = sub;
  if (dot !== undefined) t.dot = dot;
  save();
  renderBar();
}

export function closeTab(key) {
  const i = tabs.findIndex(t => t.key === key);
  if (i < 0) return;
  tabs.splice(i, 1);
  delete scrolls[key];
  save();
  if (key === active) {
    const next = tabs[i] || tabs[i - 1];
    location.hash = next ? next.hash : '#/';
  } else renderBar();
}

export const openTabsCount = () => tabs.length;

export function closeAllTabs() {
  tabs = []; save();
  if (active !== 'home' && active !== 'settings') location.hash = '#/'; else renderBar();
}

const order = () => ['home', ...tabs.map(t => t.key)];
const hashOf = key => key === 'home' ? '#/' : find(key)?.hash;
function neighbour(step) {
  const o = order(), i = o.indexOf(active);
  if (i < 0) return null;
  return o[i + step] || null;
}
export function goTab(step) {
  const k = neighbour(step);
  if (!k) return false;
  pendingAnim = step > 0 ? 'from-right' : 'from-left';
  location.hash = hashOf(k);
  return true;
}
/** Animazione d'ingresso della pagina dopo uno scorrimento col dito (chiamata dal router dopo il disegno). */
export function playEnterAnim(el) {
  if (!pendingAnim) { el.style.transform = ''; el.style.opacity = ''; return; }
  const cls = `enter-${pendingAnim}`;
  pendingAnim = null;
  el.style.transition = 'none'; el.style.transform = ''; el.style.opacity = '';
  el.classList.remove('enter-from-left', 'enter-from-right');
  void el.offsetWidth;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), 300);
}

// ---------- barra dei tab ----------
const $bar = () => document.getElementById('tabbar');
function renderBar() {
  const bar = $bar();
  if (!bar) return;
  const home = `<a class="tab home ${active === 'home' ? 'active' : ''}" href="#/" data-key="home" title="Preferiti e ricerca"><span class="tt">★</span><span class="lbl">Preferiti</span></a>`;
  bar.innerHTML = home + tabs.map(t => `<a class="tab k-${esc(t.kind)} ${t.key === active ? 'active' : ''}" href="${esc(t.hash)}" data-key="${esc(t.key)}" title="${esc([t.title, t.city, t.sub].filter(Boolean).join(' · '))}">
      ${t.dot ? `<i class="dot ${esc(t.dot)}"></i>` : ''}<span class="tt">${esc(t.title)}</span>${t.sub ? `<small>${esc(t.sub)}</small>` : ''}
      <button class="x" type="button" data-close="${esc(t.key)}" aria-label="Chiudi ${esc(t.title)}" title="Chiudi">×</button></a>`).join('')
    + (tabs.length > 1 ? `<button class="tab closeall" type="button" data-closeall title="Chiudi tutti i tab">Chiudi tutti</button>` : '');
  const a = bar.querySelector('.tab.active');
  if (a) {
    // tiene il tab attivo visibile nella barra (su telefono la barra scorre di lato)
    const l = a.offsetLeft - bar.offsetLeft, r = l + a.offsetWidth;
    if (l < bar.scrollLeft + 8 || r > bar.scrollLeft + bar.clientWidth - 8) bar.scrollTo({ left: Math.max(0, l - bar.clientWidth / 2 + a.offsetWidth / 2), behavior: 'smooth' });
  }
  maybeHint();
}

function maybeHint() {
  if (!tabs.length || !matchMedia('(pointer: coarse)').matches || localStorage.getItem('aerei.tabs.hint')) return;
  localStorage.setItem('aerei.tabs.hint', '1');
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = 'Nuovo: le pagine aperte restano nei tab in alto. Scorri col dito a destra o a sinistra per passare da un tab all’altro.';
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('out'), 5500);
  setTimeout(() => t.remove(), 6200);
}

export function initTabs(appEl) {
  const bar = $bar();
  bar.addEventListener('click', e => {
    const x = e.target.closest('[data-close]');
    if (x) { e.preventDefault(); e.stopPropagation(); closeTab(x.dataset.close); return; }
    if (e.target.closest('[data-closeall]')) { e.preventDefault(); closeAllTabs(); }
  });
  // clic centrale su un tab: chiude (come nei browser)
  bar.addEventListener('auxclick', e => { const t = e.target.closest('.tab[data-key]'); if (e.button === 1 && t && t.dataset.key !== 'home') { e.preventDefault(); closeTab(t.dataset.key); } });
  initSwipe(appEl);
  renderBar();
}

// ---------- scorrimento orizzontale col dito (telefono e tablet) ----------
function initSwipe(el) {
  let sx = 0, sy = 0, dx = 0, mode = null, t0 = 0;
  const reset = () => { el.style.transition = 'transform .2s ease, opacity .2s ease'; el.style.transform = ''; el.style.opacity = ''; };
  el.addEventListener('touchstart', e => {
    mode = null; dx = 0;
    if (e.touches.length !== 1 || active === 'settings') { mode = 'off'; return; }
    const tch = e.touches[0];
    // niente swipe sulla mappa, nei campi di testo e vicino ai bordi (lì c'è il gesto "indietro" di iOS)
    if (e.target.closest('.map, .leaflet-container, input, textarea, select, .noswipe') || tch.clientX < 24 || tch.clientX > window.innerWidth - 24) { mode = 'off'; return; }
    sx = tch.clientX; sy = tch.clientY; t0 = Date.now();
    el.style.transition = 'none';
  }, { passive: true });
  el.addEventListener('touchmove', e => {
    if (mode === 'off') return;
    const tch = e.touches[0];
    dx = tch.clientX - sx;
    const dy = tch.clientY - sy;
    if (!mode) {
      if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
      mode = Math.abs(dx) > Math.abs(dy) * 1.5 ? 'h' : 'off';
      if (mode === 'off') return;
    }
    e.preventDefault();
    const has = neighbour(dx < 0 ? 1 : -1);
    const shown = has ? dx : dx * 0.25;   // resistenza se non c'è un tab da quella parte
    el.style.transform = `translateX(${shown}px)`;
    el.style.opacity = String(1 - Math.min(0.5, Math.abs(shown) / window.innerWidth));
  }, { passive: false });
  const end = () => {
    if (mode !== 'h') { mode = null; return; }
    mode = null;
    const fast = Math.abs(dx) > 40 && Date.now() - t0 < 300;
    if ((Math.abs(dx) > window.innerWidth * 0.28 || fast) && neighbour(dx < 0 ? 1 : -1)) {
      el.style.transition = 'transform .15s ease, opacity .15s ease';
      el.style.transform = `translateX(${dx < 0 ? -60 : 60}%)`; el.style.opacity = '0';
      setTimeout(() => goTab(dx < 0 ? 1 : -1), 120);
    } else reset();
  };
  el.addEventListener('touchend', end);
  el.addEventListener('touchcancel', () => { mode = null; reset(); });
}
