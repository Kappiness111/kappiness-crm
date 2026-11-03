"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createClient } from "../../utils/supabase/client";
import Dialog from "./Dialog";
import Icon from "./Icon";
import {
  DEFAULT_SIDEBAR,
  DEFAULT_THEME,
  currentSidebar,
  currentTheme,
  restorePreferences,
  saveSidebar,
  saveTheme,
  subscribeRoot,
} from "../lib/theme";

/* The application frame used by every signed-in screen: one sidebar, one header, one profile menu.

   Desktop (>= 900px): the sidebar is always visible, either collapsed (icons) or expanded (icons + labels).
   The header menu button switches between the two and the choice is remembered across pages.
   Mobile: the sidebar is hidden; the menu button slides it in over a backdrop. It closes on backdrop
   click, Escape, or when a destination is chosen.

   Appearance (light / dark) lives only in Profile settings. */

const MOBILE_QUERY = "(max-width: 899px)";

function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return ((parts[0][0] || "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

function ProfileSettings({ user, onClose }) {
  const theme = useSyncExternalStore(subscribeRoot, currentTheme, () => DEFAULT_THEME);
  const options = [
    { value: "light", label: "Light", icon: "sun" },
    { value: "dark", label: "Dark", icon: "moon" },
  ];

  function onKeyDown(event) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const next = theme === "light" ? "dark" : "light";
    saveTheme(next);
    document.getElementById(`theme-${next}`)?.focus();
  }

  return (
    <Dialog titleId="profile-settings-title" title="Profile settings" subtitle="Your account and how the CRM looks on this device." onClose={onClose} small>
      <div className="modal-body">
        <section className="settings-group" aria-labelledby="settings-account">
          <h3 id="settings-account">Account</h3>
          <dl className="kv">
            <dt>Name</dt>
            <dd>{user.name || "—"}</dd>
            <dt>Email</dt>
            <dd>{user.email || "—"}</dd>
            <dt>Role</dt>
            <dd>{user.roleLabel || "—"}</dd>
          </dl>
        </section>

        <section className="settings-group" aria-labelledby="settings-appearance">
          <h3 id="settings-appearance">Appearance</h3>
          <p>Applies to every page and is remembered on this device.</p>
          <div className="theme-options" role="radiogroup" aria-labelledby="settings-appearance" onKeyDown={onKeyDown}>
            {options.map((option) => (
              <button
                key={option.value}
                id={`theme-${option.value}`}
                type="button"
                role="radio"
                aria-checked={theme === option.value}
                tabIndex={theme === option.value ? 0 : -1}
                className="theme-option"
                onClick={() => saveTheme(option.value)}
              >
                <span className={`theme-swatch ${option.value}`} aria-hidden="true">
                  <i />
                  <i />
                </span>
                <span className="theme-option-label">
                  <Icon name={option.icon} />
                  {option.label} mode
                  {theme === option.value ? (
                    <span className="check">
                      <Icon name="check" />
                    </span>
                  ) : null}
                </span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </Dialog>
  );
}

function ProfileMenu({ user }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onPointer(event) {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false);
    }
    function onKey(event) {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    wrapRef.current?.querySelector('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function onMenuKey(event) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...wrapRef.current.querySelectorAll('[role="menuitem"]')];
    const index = items.indexOf(document.activeElement);
    const next = event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  async function logout() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await createClient().auth.signOut();
    } catch (error) {
      console.error("Sign out failed:", error);
    }
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="popover-wrap" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className="profile-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="avatar" aria-hidden="true">
          {initials(user.name)}
        </span>
        <span className="profile-name">{user.name || "Account"}</span>
        <Icon name="chevronDown" />
      </button>

      {open && (
        <div className="menu" role="menu" aria-label="Account" onKeyDown={onMenuKey}>
          <div className="menu-head">
            <span className="avatar" aria-hidden="true">
              {initials(user.name)}
            </span>
            <div>
              <strong>{user.name || "Signed in"}</strong>
              <span>{user.email || user.roleLabel}</span>
            </div>
          </div>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpen(false);
              setSettingsOpen(true);
            }}
          >
            <Icon name="settings" /> Profile settings
          </button>
          <div className="menu-sep" role="separator" />
          <button type="button" role="menuitem" className="menu-item" onClick={() => void logout()} disabled={signingOut}>
            <Icon name="logout" /> {signingOut ? "Signing out…" : "Log out"}
          </button>
        </div>
      )}

      {settingsOpen && <ProfileSettings user={user} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

export default function AppShell({
  nav = [],
  activeId,
  onNavigate,
  workspaceLabel = "CRM",
  crumbs = [],
  headerActions = null,
  user = { name: "", email: "", roleLabel: "" },
  children,
}) {
  const router = useRouter();
  const sidebar = useSyncExternalStore(subscribeRoot, currentSidebar, () => DEFAULT_SIDEBAR);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [tip, setTip] = useState(null); // { label, top } while hovering a collapsed icon
  const menuButtonRef = useRef(null);

  // Put the saved theme and sidebar width back if React reset <html> (development remount). No-op in production.
  useLayoutEffect(() => {
    restorePreferences();
  }, []);

  useEffect(() => {
    if (!drawerOpen) return undefined;
    function onKey(event) {
      if (event.key === "Escape") {
        setDrawerOpen(false);
        menuButtonRef.current?.focus();
      }
    }
    // Leaving the mobile layout (rotating a tablet, resizing) closes the drawer.
    const media = window.matchMedia(MOBILE_QUERY);
    function onChange(event) {
      if (!event.matches) setDrawerOpen(false);
    }
    document.addEventListener("keydown", onKey);
    media.addEventListener("change", onChange);
    return () => {
      document.removeEventListener("keydown", onKey);
      media.removeEventListener("change", onChange);
    };
  }, [drawerOpen]);

  function toggleSidebar() {
    if (window.matchMedia(MOBILE_QUERY).matches) setDrawerOpen((value) => !value);
    else saveSidebar(sidebar === "expanded" ? "collapsed" : "expanded");
    setTip(null);
  }

  function go(item) {
    setDrawerOpen(false);
    setTip(null);
    if (item.href) router.push(item.href);
    else if (onNavigate) onNavigate(item.id);
  }

  function showTip(event, label) {
    if (sidebar === "expanded" || window.matchMedia(MOBILE_QUERY).matches) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setTip({ label, top: rect.top + rect.height / 2 });
  }

  const sections = [];
  nav.forEach((item) => {
    const name = item.section || "";
    let group = sections.find((entry) => entry.name === name);
    if (!group) sections.push((group = { name, items: [] }));
    group.items.push(item);
  });

  const mobileOpen = drawerOpen;
  const current = crumbs[crumbs.length - 1];

  return (
    <div className="app" data-drawer={mobileOpen ? "open" : "closed"}>
      <aside className="sidebar" id="app-sidebar" aria-label="Main navigation">
        <div className="sb-brand">
          <Image src="/kappiness_logo_sq.jpeg" alt="" width={34} height={34} className="sb-logo" priority />
          <span className="sb-wordmark">
            <strong>Kappiness</strong>
            <span>{workspaceLabel}</span>
          </span>
        </div>

        <nav className="sb-nav" onMouseLeave={() => setTip(null)}>
          {sections.map((group) => (
            <div key={group.name || "main"} role="group" aria-label={group.name || undefined}>
              {group.name ? <div className="sb-section">{group.name}</div> : null}
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="sb-item"
                  aria-current={item.id === activeId ? "page" : undefined}
                  aria-label={item.count ? `${item.label}, ${item.count}` : item.label}
                  onClick={() => go(item)}
                  onMouseEnter={(event) => showTip(event, item.label)}
                  onFocus={(event) => showTip(event, item.label)}
                  onBlur={() => setTip(null)}
                >
                  <Icon name={item.icon} />
                  <span className="sb-label">{item.label}</span>
                  {item.count ? <span className="sb-count" aria-hidden="true">{item.count}</span> : null}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      {tip ? (
        <div className="sb-tip" style={{ top: tip.top }} role="tooltip">
          {tip.label}
        </div>
      ) : null}

      <button
        type="button"
        className="sb-backdrop"
        tabIndex={-1}
        aria-hidden="true"
        onClick={() => setDrawerOpen(false)}
      />

      <div className="app-main">
        <header className="app-header">
          <button
            ref={menuButtonRef}
            type="button"
            className="icon-btn"
            onClick={toggleSidebar}
            aria-controls="app-sidebar"
            aria-expanded={mobileOpen || sidebar === "expanded"}
            aria-label="Toggle navigation"
            title="Toggle navigation"
          >
            <Icon name="menu" />
          </button>

          <nav className="app-header-title" aria-label="Breadcrumb">
            {crumbs.map((crumb, index) => {
              const last = index === crumbs.length - 1;
              return (
                <span key={`${crumb.label}-${index}`} style={{ display: "contents" }}>
                  {index > 0 ? <span className="sep" aria-hidden="true">/</span> : null}
                  {last ? (
                    <strong aria-current="page">{crumb.label}</strong>
                  ) : crumb.onClick ? (
                    <button type="button" className="crumb" onClick={crumb.onClick}>
                      {crumb.label}
                    </button>
                  ) : (
                    <span>{crumb.label}</span>
                  )}
                </span>
              );
            })}
            {!current ? <strong>Kappiness</strong> : null}
          </nav>

          <div className="app-header-actions">
            {headerActions}
            <ProfileMenu user={user} />
          </div>
        </header>

        <main className="app-content" id="main-content">
          {children}
        </main>
      </div>
    </div>
  );
}
