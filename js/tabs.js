// Tab in cima alla pagina: ogni aeroporto, volo, tratta o aereo aperto resta in un tab per tornarci al volo.
// Schermo largo: pannello verticale a sinistra. Più stretto: barra in alto (scorrevole) + ☰ per il pannello a scomparsa,
// e sul telefono scorrimento orizzontale col dito sul contenuto.
// I tab si riordinano trascinandoli (col dito dopo una pressione lunga); l'ordine resta salvato.
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
let armed = null, armTimer = 0; // tab con la × già toccata una volta (telefono): il secondo tocco lo chiude

function load() {
  try {
    const yday = localDate(new Date(Date.now() - 86400e3));
    const t = JSON.parse(localStorage.getItem(TKEY) || '[]');
    // i voli e gli aerei di giorni ormai passati si chiudono da soli
    return Array.isArray(t) ? t.filter(x => x?.key && x.hash && !(x.date && x.date < yday)) : [];
  } catch { return []; }
}
const save = () => { try { localStorage.setItem(TKEY, JSON.stringify(tabs)); } catch { /* spazio pieno */ } window.dispatchEvent(new Event('aerei-local-change')); };
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
// Schermo largo (≥1080 px): i tab diventano un pannello verticale a sinistra, raggruppati per tipo.
// Schermo più stretto: riga in alto (scorrevole) + pulsante ☰ che apre lo stesso elenco in un pannello a scomparsa.
const $bar = () => document.getElementById('tabbar');
const sideMQ = matchMedia('(min-width: 1080px)');
const isSide = () => sideMQ.matches;
const GROUPS = [['airport', 'Aeroporti'], ['flight', 'Voli'], ['route', 'Tratte'], ['aircraft', 'Aerei']];
const dotHtml = t => t.dot ? `<i class="dot ${esc(t.dot)}"></i>` : '';
const tabHtml = t => `<a class="tab k-${esc(t.kind)} ${t.key === active ? 'active' : ''}" href="${esc(t.hash)}" data-key="${esc(t.key)}" title="${esc([t.title, t.city, t.sub].filter(Boolean).join(' · '))}">
      ${dotHtml(t)}<span class="tt">${esc(t.title)}</span>${t.sub ? `<small>${esc(t.sub)}</small>` : ''}
      ${t.key === armed ? `<button class="x arm" type="button" data-close="${esc(t.key)}" aria-label="Conferma: chiudi ${esc(t.title)}">Chiudi</button>` : `<button class="x" type="button" data-close="${esc(t.key)}" aria-label="Chiudi ${esc(t.title)}" title="Chiudi">×</button>`}</a>`;

const homeHtml = () => `<a class="tab home ${active === 'home' ? 'active' : ''}" href="#/" data-key="home" title="Preferiti e ricerca"><span class="tt">★</span><span class="lbl">Preferiti</span></a>`;
// elenco verticale (pannello del desktop e pannello a scomparsa): gruppi per tipo, dentro ogni gruppo l'ordine scelto trascinando
function groupedHtml() {
  const known = GROUPS.map(g => g[0]);
  const groups = GROUPS.map(([k, label]) => [label, tabs.filter(t => k === 'airport' ? (t.kind === k || !known.includes(t.kind)) : t.kind === k)]).filter(g => g[1].length);
  return homeHtml() + groups.map(([label, list]) => `<div class="tgrp"><div class="glab">${label}</div>${list.map(tabHtml).join('')}</div>`).join('')
    + (tabs.length ? (tabs.length > 1 ? `<button class="tab closeall" type="button" data-closeall title="Chiudi tutti i tab">Chiudi tutti</button>` : '')
      : '<p class="tabhint">Aeroporti, voli e aerei che apri restano qui per tornarci al volo.</p>');
}

function renderBar() {
  const bar = $bar();
  if (!bar) return;
  if (drag) { drag.stale = true; return; }   // durante un trascinamento ridisegno alla fine
  const side = isSide();
  document.documentElement.classList.toggle('sidetabs', side);
  bar.classList.toggle('vlist', side);
  if (side) {
    bar.innerHTML = groupedHtml();
    const a = bar.querySelector('.tab.active');
    if (a) { const r = a.getBoundingClientRect(), br = bar.getBoundingClientRect(); if (r.top < br.top || r.bottom > br.bottom) a.scrollIntoView({ block: 'nearest' }); }
  } else {
    bar.innerHTML = homeHtml() + tabs.map(tabHtml).join('')
      + (tabs.length > 1 ? `<button class="tab closeall" type="button" data-closeall title="Chiudi tutti i tab">Chiudi tutti</button>` : '');
    const a = bar.querySelector('.tab.active');
    if (a) {
      // tiene il tab attivo visibile nella barra (su telefono la barra scorre di lato)
      const l = a.offsetLeft - bar.offsetLeft, r = l + a.offsetWidth;
      if (l < bar.scrollLeft + 8 || r > bar.scrollLeft + bar.clientWidth - 8) bar.scrollTo({ left: Math.max(0, l - bar.clientWidth / 2 + a.offsetWidth / 2), behavior: 'smooth' });
    }
  }
  const all = document.getElementById('tabsall');
  if (all) { all.hidden = side || !tabs.length; all.querySelector('b').textContent = tabs.length; }
  if (drawerOpen()) renderDrawer();
  maybeHint();
}

// ---------- pannello laterale a scomparsa (telefono e schermi stretti) ----------
const $drawer = () => document.getElementById('tabdrawer');
const drawerOpen = () => { const d = $drawer(); return !!d && !d.hidden; };
function renderDrawer() {
  const d = $drawer();
  if (!d) return;
  const list = d.querySelector('.dlist');
  if (drag && drag.box === list) { drag.stale = true; return; }
  d.querySelector('.dhead b').textContent = `${tabs.length} ${tabs.length === 1 ? 'pagina aperta' : 'pagine aperte'}`;
  list.innerHTML = groupedHtml() + (tabs.length > 1 ? '<p class="dhint">Tieni premuta una voce e trascinala per spostarla.</p>' : '');
}
function openDrawer() {
  const d = $drawer();
  if (!d) return;
  d.hidden = false;
  renderDrawer();
  requestAnimationFrame(() => d.classList.add('open'));
  document.documentElement.classList.add('drawlock');
  d.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest' });
}
function closeDrawer() {
  const d = $drawer();
  if (!d || d.hidden) return;
  d.classList.remove('open');
  document.documentElement.classList.remove('drawlock');
  setTimeout(() => { if (!d.classList.contains('open')) d.hidden = true; }, 200);
}
function buildDrawer() {
  const d = document.createElement('div');
  d.id = 'tabdrawer'; d.className = 'tabdrawer noswipe'; d.hidden = true;
  d.innerHTML = `<div class="drawbg" data-dismiss></div><nav class="drawer" aria-label="Pagine aperte">
    <div class="dhead"><b></b><button class="linkbtn" type="button" data-dismiss aria-label="Chiudi il pannello">×</button></div>
    <div class="dlist vlist"></div></nav>`;
  document.body.appendChild(d);
  d.addEventListener('click', e => {
    if (e.target.closest('[data-dismiss]')) { e.preventDefault(); closeDrawer(); return; }
    const x = e.target.closest('[data-close]');
    if (x) { e.preventDefault(); e.stopPropagation(); closeTab(x.dataset.close); renderDrawer(); return; }
    if (e.target.closest('[data-closeall]')) { e.preventDefault(); closeDrawer(); closeAllTabs(); return; }
    if (e.target.closest('.tab[data-key]')) closeDrawer();   // il link apre la pagina
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
  // scorrendo col dito verso sinistra il pannello si chiude
  const panel = d.querySelector('.drawer');
  let sx = null, sy = 0;
  panel.addEventListener('touchstart', e => { if (e.touches.length === 1) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; } }, { passive: true });
  panel.addEventListener('touchmove', e => {
    if (sx == null || drag) return;
    const dx = e.touches[0].clientX - sx, dy = e.touches[0].clientY - sy;
    if (Math.abs(dy) > Math.abs(dx)) { if (Math.abs(dy) > 12) sx = null; return; }
    if (dx < 0) { panel.style.transition = 'none'; panel.style.transform = `translateX(${dx}px)`; }
  }, { passive: true });
  panel.addEventListener('touchend', e => {
    if (sx == null) return;
    const dx = (e.changedTouches[0]?.clientX ?? sx) - sx;
    sx = null;
    panel.style.transition = ''; panel.style.transform = '';
    if (dx < -60) closeDrawer();
  });
  initDrag(d.querySelector('.dlist'), { item: '.tab[data-key]:not(.home)', mode: () => 'y', scroller: d.querySelector('.dlist') });
}

function maybeHint() {
  if (tabs.length < 2 || localStorage.getItem('aerei.tabs.hint5')) return;
  const seen = localStorage.getItem('aerei.tabs.hint2');
  localStorage.setItem('aerei.tabs.hint5', '1'); localStorage.setItem('aerei.tabs.hint4', '1'); localStorage.setItem('aerei.tabs.hint3', '1'); localStorage.setItem('aerei.tabs.hint2', '1'); localStorage.setItem('aerei.tabs.hint', '1');
  const touch = matchMedia('(pointer: coarse)').matches;
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = isSide()
    ? `${seen ? 'Nuovo: le' : 'Le'} pagine aperte restano nel pannello a sinistra, raggruppate per tipo. Trascinale per cambiare l’ordine.`
    : `${seen ? 'Nuovo: tocca' : 'Le pagine aperte restano nei tab in alto. Tocca'} ☰ in alto a sinistra per vederle tutte in un pannello laterale${touch ? ', oppure fai scorrere il dito verso destra nella metà bassa dello schermo, a sinistra; tieni premuta una voce per spostarla' : ''}.`;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('out'), 6500);
  setTimeout(() => t.remove(), 7200);
}

function setSideTop() {
  const b = document.querySelector('.topbar .bar');
  if (b) document.documentElement.style.setProperty('--tbtop', `${b.getBoundingClientRect().bottom}px`);
}

export function initTabs(appEl) {
  const bar = $bar();
  // tab arrivati da un altro dispositivo (sync.js): ricarico l'elenco, il tab della pagina aperta resta
  window.addEventListener('tabs-remote', () => {
    const cur = find(active);
    tabs = load();
    if (cur && !find(cur.key)) tabs.push(cur);
    renderBar();
  });
  bar.addEventListener('click', e => {
    const x = e.target.closest('[data-close]');
    if (x) {
      e.preventDefault(); e.stopPropagation();
      const k = x.dataset.close;
      // sul telefono la × si tocca per sbaglio: il primo tocco la trasforma in "Chiudi", il secondo chiude
      if (matchMedia('(pointer: coarse)').matches && armed !== k) {
        armed = k; clearTimeout(armTimer);
        armTimer = setTimeout(() => { armed = null; renderBar(); }, 3000);
        renderBar(); return;
      }
      armed = null; clearTimeout(armTimer);
      closeTab(k); return;
    }
    if (armed) { armed = null; clearTimeout(armTimer); renderBar(); }
    if (e.target.closest('[data-closeall]')) { e.preventDefault(); closeAllTabs(); }
  });
  // clic centrale su un tab: chiude (come nei browser)
  bar.addEventListener('auxclick', e => { const t = e.target.closest('.tab[data-key]'); if (e.button === 1 && t && t.dataset.key !== 'home') { e.preventDefault(); closeTab(t.dataset.key); } });
  // sfumatura accanto a ★ solo quando ci sono tab scorsi sotto
  const sc = () => bar.classList.toggle('scrolled', !isSide() && bar.scrollLeft > 2);
  bar.addEventListener('scroll', sc, { passive: true }); sc();
  document.getElementById('tabsall')?.addEventListener('click', openDrawer);
  buildDrawer();
  sideMQ.addEventListener('change', () => { closeDrawer(); setSideTop(); renderBar(); sc(); });
  window.addEventListener('resize', setSideTop);
  setSideTop();
  initSwipe(appEl);
  initEdgeOpen();
  initDrag(bar, { item: '.tab[data-key]:not(.home)', mode: () => isSide() ? 'y' : 'x', scroller: bar });
  renderBar();
}

// ---------- riordino trascinando ----------
// mouse/penna: si trascina subito (oltre 6 px); dito: pressione lunga (~0,35 s) poi si trascina,
// così lo scorrimento normale col dito resta com'è. "Preferiti" resta sempre primo.
// mode 'x' = riga in alto, 'y' = pannello laterale (dentro il proprio gruppo), 'grid' = griglia (non più usata).
let drag = null;
function initDrag(box, { item, mode, scroller }) {
  let press = null;   // pressione in attesa di diventare trascinamento
  const items = () => [...box.querySelectorAll(item)];
  const begin = (el, x, y) => {
    const r = el.getBoundingClientRect();
    drag = { el, box, m: mode(), gx: x - r.left, gy: y - r.top, moved: false, stale: false, x, y };
    el.classList.add('dragging');
    box.classList.add('reordering');
    document.documentElement.classList.add('tabdrag');
    try { getSelection()?.removeAllRanges(); } catch { /* niente */ }
    navigator.vibrate?.(10);
    follow();
  };
  const follow = () => {
    const { el, m, x, y } = drag;
    el.style.transform = '';
    const r = el.getBoundingClientRect();
    const dx = m === 'y' ? 0 : x - drag.gx - r.left, dy = m === 'x' ? 0 : y - drag.gy - r.top;
    el.style.transform = `translate(${dx}px, ${dy}px)`;
  };
  const place = () => {
    const { el, m, x, y } = drag;
    // nel pannello si sposta solo dentro il proprio gruppo
    const sibs = m === 'y' ? [...el.parentElement.querySelectorAll(item)] : items();
    const others = sibs.filter(o => o !== el);
    let t = null, after = false;
    if (m === 'grid') {
      t = others.find(o => { const r = o.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; });
      if (!t) return;
      after = sibs.indexOf(t) > sibs.indexOf(el);
    } else {
      const c = r => m === 'y' ? r.top + r.height / 2 : r.left + r.width / 2;
      const p = m === 'y' ? y : x;
      // nuovo posto: prima del primo elemento la cui metà è oltre il puntatore, altrimenti in fondo
      t = others.find(o => p < c(o.getBoundingClientRect())) || null;
      const cur = sibs.indexOf(el), want = t ? sibs.indexOf(t) - (sibs.indexOf(t) > cur ? 1 : 0) : others.length;
      if (want === cur) return;
      if (!t) { t = others[others.length - 1]; after = true; }
      if (!t) return;
    }
    const before = new Map(others.map(o => { const r = o.getBoundingClientRect(); return [o, [r.left, r.top]]; }));
    if (after) t.after(el); else t.before(el);
    drag.moved = true;
    others.forEach(o => {
      const r = o.getBoundingClientRect(), [l0, t0] = before.get(o), dx = l0 - r.left, dy = t0 - r.top;
      if (!dx && !dy) return;
      o.style.transition = 'none'; o.style.transform = `translate(${dx}px, ${dy}px)`;
      o.getBoundingClientRect();
      o.style.transition = 'transform .16s ease'; o.style.transform = '';
    });
  };
  // vicino ai bordi di ciò che scorre lo faccio scorrere
  let raf = 0;
  const edgeScroll = () => {
    raf = 0;
    if (!drag) return;
    const r = scroller.getBoundingClientRect();
    if (drag.m === 'x') {
      const v = drag.x < r.left + 30 ? -8 : drag.x > r.right - 30 ? 8 : 0;
      if (!v) return;
      scroller.scrollLeft += v;
    } else {
      const v = drag.y < r.top + 30 ? -8 : drag.y > r.bottom - 30 ? 8 : 0;
      if (!v) return;
      scroller.scrollTop += v;
    }
    place(); follow();
    raf = requestAnimationFrame(edgeScroll);
  };
  const moveTo = (x, y) => {
    if (!drag) return;
    drag.x = x; drag.y = y;
    place(); follow();
    if (!raf) raf = requestAnimationFrame(edgeScroll);
  };
  const finish = () => {
    if (!drag || drag.box !== box) return;
    const { el, moved, stale } = drag;
    drag = null;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    box.classList.remove('reordering');
    document.documentElement.classList.remove('tabdrag');
    try { getSelection()?.removeAllRanges(); } catch { /* niente */ }
    if (moved) {
      const keys = items().map(o => o.dataset.key);
      tabs.sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key));
      save();
      // il clic che segue il rilascio non deve aprire il tab
      const eat = e => { e.preventDefault(); e.stopPropagation(); };
      box.addEventListener('click', eat, true);
      setTimeout(() => box.removeEventListener('click', eat, true), 400);
    }
    el.style.transition = 'transform .14s ease'; el.style.transform = '';
    setTimeout(() => { el.classList.remove('dragging'); el.style.transition = ''; if (moved || stale) renderBar(); }, 150);
  };
  const cancelPress = () => { if (press) { clearTimeout(press.timer); press = null; } };

  // mouse e penna
  box.addEventListener('pointerdown', e => {
    if (e.pointerType === 'touch' || e.button !== 0 || drag) return;
    const el = e.target.closest(item);
    if (!el || e.target.closest('.x')) return;
    press = { el, x: e.clientX, y: e.clientY, id: e.pointerId };
  });
  window.addEventListener('pointermove', e => {
    if (e.pointerType === 'touch') return;
    if (press && !drag && e.pointerId === press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) {
      const p = press; press = null;
      begin(p.el, p.x, p.y);
    }
    if (drag && drag.box === box) { e.preventDefault(); moveTo(e.clientX, e.clientY); }
  });
  window.addEventListener('pointerup', e => { if (e.pointerType === 'touch') return; press = null; finish(); });
  box.addEventListener('dragstart', e => e.preventDefault());   // niente trascinamento nativo del link
  // la pressione lunga su Android seleziona il testo e annulla il trascinamento: la blocco qui e, durante il trascinamento, ovunque
  box.addEventListener('selectstart', e => e.preventDefault());
  document.addEventListener('selectstart', e => { if (drag || press) e.preventDefault(); });

  // dito: pressione lunga, poi trascinamento (Touch Events: su Safari iOS i pointer vengono annullati dallo scorrimento)
  box.addEventListener('contextmenu', e => { if (e.target.closest(item)) e.preventDefault(); });
  box.addEventListener('touchstart', e => {
    if (e.touches.length !== 1 || drag) return;
    const el = e.target.closest(item);
    if (!el || e.target.closest('.x')) return;
    const x = e.touches[0].clientX, y = e.touches[0].clientY;
    cancelPress();
    press = { el, x, y, timer: setTimeout(() => { const p = press; press = null; if (p) begin(p.el, p.x, p.y); }, 350) };
  }, { passive: true });
  box.addEventListener('touchmove', e => {
    if (drag && drag.box === box) { e.preventDefault(); moveTo(e.touches[0].clientX, e.touches[0].clientY); return; }
    if (press && press.timer) {
      const t = e.touches[0];
      if (Math.abs(t.clientX - press.x) > 8 || Math.abs(t.clientY - press.y) > 8) cancelPress();   // sta scorrendo
    }
  }, { passive: false });
  box.addEventListener('touchend', e => {
    cancelPress();
    if (drag && drag.box === box) { e.preventDefault(); finish(); }
  });
  box.addEventListener('touchcancel', () => { cancelPress(); finish(); });
}

// ---------- dito dal bordo sinistro verso destra: apre il pannello delle pagine aperte (telefono) ----------
// Lo swipe partito dal centro dello schermo continua a cambiare tab (initSwipe ignora i bordi).
// Nota: dove il sistema usa il bordo per "indietro" (Safari in una scheda, Android con navigazione a gesti) vince il sistema.
// fascia del bordo sinistro riservata al pannello: abbastanza larga per il pollice
const edgeW = () => isSide() ? 24 : Math.min(72, Math.round(window.innerWidth * 0.18));
// zona che apre il pannello con uno swipe verso destra: il bordo sinistro e tutto il quarto in basso a sinistra.
// Dalla metà in su (fuori dal bordo) lo swipe verso destra torna al tab precedente; verso sinistra va sempre al successivo.
const inDrawerZone = (x, y) => !isSide() && (x <= edgeW() || (y > window.innerHeight / 2 && x < window.innerWidth / 2));
function initEdgeOpen() {
  let st = null;
  // dopo il gesto il tocco non deve aprire/attivare ciò che c'era sotto il dito (riga, tab, link)
  const eatClick = () => {
    const eat = ev => { ev.preventDefault(); ev.stopPropagation(); };
    document.addEventListener('click', eat, true);
    setTimeout(() => document.removeEventListener('click', eat, true), 600);
  };
  document.addEventListener('touchstart', e => {
    st = null;
    if (isSide() || drawerOpen() || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (!inDrawerZone(t.clientX, t.clientY) || e.target.closest('.leaflet-container, input, textarea, select')) return;
    st = { x: t.clientX, y: t.clientY, done: false, moved: false };
  }, { passive: true, capture: true });
  document.addEventListener('touchmove', e => {
    if (!st || st.done) return;
    const t = e.touches[0], dx = t.clientX - st.x, dy = t.clientY - st.y;
    if (!st.moved && Math.abs(dy) > 10 && Math.abs(dy) > dx) { st = null; return; }   // sta scorrendo in verticale
    if (!st.moved && dx < -6) { st = null; return; }   // verso sinistra: è lo swipe al tab successivo
    if (dx > 4 && dx > Math.abs(dy)) st.moved = true;
    if (st.moved) e.preventDefault();   // niente scorrimento della barra dei tab
    if (dx > 30) { st.done = true; openDrawer(); }
  }, { passive: false, capture: true });
  document.addEventListener('touchend', () => { if (st?.moved) eatClick(); st = null; }, { capture: true });
  document.addEventListener('touchcancel', () => { st = null; }, { capture: true });
}

// ---------- scorrimento orizzontale col dito (telefono e tablet) ----------
function initSwipe(el) {
  let sx = 0, sy = 0, dx = 0, mode = null, t0 = 0, zone = false;
  const reset = () => { el.style.transition = 'transform .2s ease, opacity .2s ease'; el.style.transform = ''; el.style.opacity = ''; };
  el.addEventListener('touchstart', e => {
    mode = null; dx = 0;
    if (e.touches.length !== 1 || active === 'settings') { mode = 'off'; return; }
    const tch = e.touches[0];
    // niente swipe sulla mappa, nei campi di testo e vicino ai bordi (lì c'è il gesto "indietro" di iOS)
    if (e.target.closest('.map, .leaflet-container, input, textarea, select, .noswipe') || tch.clientX < 16 || tch.clientX > window.innerWidth - 24) { mode = 'off'; return; }
    zone = inDrawerZone(tch.clientX, tch.clientY);
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
      mode = Math.abs(dx) > Math.abs(dy) * 1.5 && !(zone && dx > 0) ? 'h' : 'off';   // verso destra nella zona del pannello: lo apre initEdgeOpen
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
