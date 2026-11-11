// Impostazioni e preferiti, salvati nel browser (localStorage).
const SKEY = 'aerei.settings.v1';
const FKEY = 'aerei.favorites.v1';

const read = (k, d) => { try { return { ...d, ...JSON.parse(localStorage.getItem(k) || '{}') }; } catch { return d; } };

export const getSettings = () => read(SKEY, { provider: 'demo', apiKey: '', refreshSec: 60, workerUrl: '' });
export const saveSettings = s => localStorage.setItem(SKEY, JSON.stringify(s));

const emptyFav = { airports: [], routes: [], flights: [], aircraft: [] };
export const getFavorites = () => read(FKEY, emptyFav);
const saveFav = f => { localStorage.setItem(FKEY, JSON.stringify(f)); window.dispatchEvent(new Event('favorites-changed')); };

const keyOf = (type, item) => type === 'airports' ? item.iata : type === 'aircraft' ? item.reg
  : type === 'routes' ? `${item.from}-${item.to}` : item.number;

export function isFavorite(type, item) {
  const k = keyOf(type, item);
  return getFavorites()[type].some(x => keyOf(type, x) === k);
}

export function toggleFavorite(type, item) {
  const f = getFavorites();
  const k = keyOf(type, item);
  const i = f[type].findIndex(x => keyOf(type, x) === k);
  if (i >= 0) f[type].splice(i, 1); else f[type].unshift({ ...item, addedAt: new Date().toISOString() });
  saveFav(f);
  return i < 0;
}

// nuovo ordine di una categoria di preferiti: keys = chiavi nell'ordine voluto
export const favKey = keyOf;
export function reorderFavorites(type, keys) {
  const f = getFavorites();
  const pos = new Map(keys.map((k, i) => [k, i]));
  f[type] = [...f[type]].sort((a, b) => (pos.get(keyOf(type, a)) ?? 1e9) - (pos.get(keyOf(type, b)) ?? 1e9));
  saveFav(f);
}

export function exportFavorites() { return JSON.stringify(getFavorites(), null, 2); }
export function importFavorites(json) {
  const f = JSON.parse(json);
  saveFav({ airports: f.airports || [], routes: f.routes || [], flights: f.flights || [], aircraft: f.aircraft || [] });
}
