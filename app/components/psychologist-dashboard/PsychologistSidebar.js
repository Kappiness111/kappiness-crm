"use client";

import Image from "next/image";
import Icon from "../Icon";
import Glyph from "./Glyph";

/* Uses the CRM's own sidebar classes (globals.css) so it matches the rest of the app.
   Only supported items are shown. My Clients, My Sessions and Follow-ups are left out until
   appointment and client data exist for psychologists. */
const ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard" },
  { id: "calendar", label: "My Calendar", icon: "calendar" },
  { id: "availability", label: "My Availability", icon: "clock" },
  { id: "profile", label: "Profile", glyph: "user" },
];

export default function PsychologistSidebar({ active, name, open, onNavigate, onLogout, loggingOut, onClose }) {
  return (
    <>
      {open && <button className="mobile-overlay" onClick={onClose} aria-label="Close navigation" />}

      <aside className={`sidebar ${open ? "sidebar-open" : ""}`}>
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
          <button className="mobile-close" onClick={onClose} aria-label="Close menu">
            <Icon name="close" />
          </button>
        </div>

        <div className="workspace-label">PSYCHOLOGIST</div>

        <nav className="main-nav" aria-label="Main navigation">
          {ITEMS.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${active === item.id ? "active" : ""}`}
              onClick={() => onNavigate(item.id)}
              aria-current={active === item.id ? "page" : undefined}
            >
              <span className="ui-icon" aria-hidden="true">
                {item.icon ? <Icon name={item.icon} /> : <Glyph name={item.glyph} />}
              </span>
              <span className="nav-label">{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <button className="nav-item" onClick={onLogout} disabled={loggingOut}>
            <span className="ui-icon" aria-hidden="true"><Glyph name="logout" /></span>
            <span className="nav-label">{loggingOut ? "Logging out..." : "Logout"}</span>
          </button>
          <div className="profile">
            <div className="profile-avatar">{(name || "P").charAt(0).toUpperCase()}</div>
            <div className="profile-copy">
              <strong>{name || "Psychologist"}</strong>
              <span>Psychologist</span>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}