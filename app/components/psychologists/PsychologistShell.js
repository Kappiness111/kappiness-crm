"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState } from "react";
import Icon from "../Icon";
import styles from "./psychologists.module.css";

/* Page frame for the /psychologists routes. It reuses the CRM's sidebar and top bar styles so the
   module looks like part of the same app. Dashboard navigation goes back to "/". */

const NAV = [
  { name: "Dashboard", icon: "dashboard", href: "/" },
  { name: "Psychologists", icon: "heart", href: "/psychologists" },
];

export default function PsychologistShell({ crumbs = [], staffName = "", children }) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);

  function go(href) {
    setMenuOpen(false);
    router.push(href);
  }

  return (
    <main className="crm-shell">
      {menuOpen && <button className="mobile-overlay" onClick={() => setMenuOpen(false)} aria-label="Close navigation" />}

      <aside className={`sidebar ${menuOpen ? "sidebar-open" : ""}`}>
        <div className="brand">
          <div className="brand-logo">
            <Image
              src="/kappiness_logo_sq.jpeg"
              alt="Kappiness — Nourishing Minds, Pouring Happiness"
              width={180}
              height={100}
              priority
              className="brand-logo-image"
            />
          </div>
          <button className="mobile-close" onClick={() => setMenuOpen(false)} aria-label="Close menu">
            <Icon name="close" />
          </button>
        </div>

        <div className="workspace-label">WORKSPACE</div>

        <nav className="main-nav" aria-label="Main navigation">
          {NAV.map((item) => {
            const active = item.href === "/psychologists";
            return (
              <button
                key={item.name}
                className={`nav-item ${active ? "active" : ""}`}
                onClick={() => go(item.href)}
                aria-current={active ? "page" : undefined}
              >
                <span className="ui-icon" aria-hidden="true">
                  <Icon name={item.icon} />
                </span>
                <span className="nav-label">{item.name}</span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-bottom">
          <div className="profile">
            <div className="profile-avatar">{(staffName || "S").charAt(0).toUpperCase()}</div>
            <div className="profile-copy">
              <strong>{staffName || "Staff"}</strong>
              <span>Staff</span>
            </div>
          </div>
        </div>
      </aside>

      <section className="main-panel">
        <header className="topbar">
          <div className="breadcrumb">
            <button className="mobile-menu-button" onClick={() => setMenuOpen(true)} aria-label="Open navigation">
              <Icon name="menu" />
            </button>
            <span>Workspace</span>
            {crumbs.map((crumb, index) => (
              <span key={`${crumb.label}-${index}`} style={{ display: "contents" }}>
                <span className="breadcrumb-divider">/</span>
                {crumb.href ? (
                  <button
                    type="button"
                    onClick={() => go(crumb.href)}
                    style={{ background: "none", border: 0, padding: 0, color: "inherit" }}
                  >
                    {crumb.label}
                  </button>
                ) : (
                  <strong>{crumb.label}</strong>
                )}
              </span>
            ))}
          </div>
        </header>

        <div className={styles.page}>{children}</div>

        <footer className="app-footer">
          <span>© 2026 Kappiness CRM</span>
          <span>Nourishing Minds, Pouring Happiness.</span>
        </footer>
      </section>
    </main>
  );
}