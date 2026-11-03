// Colour theme: Dark (the default), Light, or System (follows the OS). The choice lives in localStorage like the app's
// other preferences (previs.*). THEME_BOOT, inlined in each page's <head>, applies it before first paint, so the light
// theme never flashes; this module keeps the page in step afterwards (the setting, and the OS switching in System mode).
// render.html has no boot script and never reads the theme: blockout renders do not depend on it.
export type ThemePref = 'dark' | 'light' | 'system';
export type Theme = 'dark' | 'light';
export const THEME_KEY = 'previs.theme';
export const THEME_PREFS: { id: ThemePref; label: string }[] = [{ id: 'dark', label: 'Dark' }, { id: 'light', label: 'Light' }, { id: 'system', label: 'System' }];
const DARK_QUERY = '(prefers-color-scheme: dark)';

/** The stored choice; anything missing or unknown is the default, Dark. */
export function readThemePref(storage: Pick<Storage, 'getItem'> | null = globalThis.localStorage ?? null): ThemePref {
  let v: string | null = null;
  try { v = storage?.getItem(THEME_KEY) ?? null; } catch { /* storage blocked: the default */ }
  return v === 'light' || v === 'system' || v === 'dark' ? v : 'dark';
}
/** The theme a choice shows: System follows the OS. */
export function resolveTheme(pref: ThemePref, systemDark: boolean): Theme {
  return pref === 'system' ? (systemDark ? 'dark' : 'light') : pref;
}
const systemDark = () => !!globalThis.matchMedia?.(DARK_QUERY).matches;

export function applyTheme(pref = readThemePref()) {
  const theme = resolveTheme(pref, systemDark()), root = document.documentElement;
  root.dataset.theme = theme; root.dataset.themePref = pref;
  root.style.colorScheme = theme;
  return theme;
}
export function setThemePref(pref: ThemePref) {
  try { localStorage.setItem(THEME_KEY, pref); } catch { /* not saved; still applied for this page */ }
  return applyTheme(pref);
}
let watching = false;
/** Re-apply when the OS switches between light and dark (only matters in System mode) or another tab changes the setting. */
export function watchTheme() {
  if (watching) return; watching = true;
  globalThis.matchMedia?.(DARK_QUERY).addEventListener?.('change', () => applyTheme());
  globalThis.addEventListener?.('storage', ev => { if (ev.key === THEME_KEY) applyTheme(); });
}
