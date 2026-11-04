/* Appearance preferences for the whole CRM: colour theme and sidebar width.
   Both live in localStorage and are applied as attributes on <html>:
     data-theme="light" | "dark"
     data-sidebar="expanded" | "collapsed"
   app/layout.js runs BOOT_SCRIPT in <head> so they are in place before the first paint (no flash). */

export const THEME_STORAGE_KEY = "kappiness-theme";
export const SIDEBAR_STORAGE_KEY = "kappiness-sidebar";
export const THEMES = ["light", "dark"];
export const DEFAULT_THEME = "light";
export const DEFAULT_SIDEBAR = "collapsed";

export const BOOT_SCRIPT = `(function(){try{var d=document.documentElement,t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY
)}),s=localStorage.getItem(${JSON.stringify(
  SIDEBAR_STORAGE_KEY
)});if(t==="dark"||t==="light")d.setAttribute("data-theme",t);if(s==="expanded"||s==="collapsed")d.setAttribute("data-sidebar",s)}catch(e){}})()`;

function read(key, allowed, fallback) {
  try {
    const value = window.localStorage.getItem(key);
    return allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private mode); the choice still applies for this visit.
  }
}

/* ----- theme ----- */

export function readStoredTheme() {
  return read(THEME_STORAGE_KEY, THEMES, DEFAULT_THEME);
}

export function currentTheme() {
  if (typeof document === "undefined") return DEFAULT_THEME;
  const value = document.documentElement.getAttribute("data-theme");
  return THEMES.includes(value) ? value : DEFAULT_THEME;
}

export function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", THEMES.includes(theme) ? theme : DEFAULT_THEME);
}

export function saveTheme(theme) {
  applyTheme(theme);
  write(THEME_STORAGE_KEY, theme);
}

/* ----- sidebar ----- */

export function readStoredSidebar() {
  return read(SIDEBAR_STORAGE_KEY, ["expanded", "collapsed"], DEFAULT_SIDEBAR);
}

export function currentSidebar() {
  if (typeof document === "undefined") return DEFAULT_SIDEBAR;
  return document.documentElement.getAttribute("data-sidebar") === "expanded" ? "expanded" : "collapsed";
}

export function saveSidebar(state) {
  document.documentElement.setAttribute("data-sidebar", state);
  write(SIDEBAR_STORAGE_KEY, state);
}

/* Re-renders subscribers when <html> attributes change (another tab, a dev remount, another component). */
export function subscribeRoot(callback) {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-sidebar"] });
  function onStorage(event) {
    if (event.key === THEME_STORAGE_KEY) applyTheme(readStoredTheme());
    if (event.key === SIDEBAR_STORAGE_KEY) document.documentElement.setAttribute("data-sidebar", readStoredSidebar());
  }
  window.addEventListener("storage", onStorage);
  return () => {
    observer.disconnect();
    window.removeEventListener("storage", onStorage);
  };
}

// React resets <html> attributes on the development Strict Mode remount; this puts the saved choices back.
export function restorePreferences() {
  applyTheme(readStoredTheme());
  document.documentElement.setAttribute("data-sidebar", readStoredSidebar());
}
