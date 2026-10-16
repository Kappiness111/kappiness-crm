
"use client";

import Image from "next/image";
import { useMemo, useState } from "react";

const initialLeads = [
  {
    id: "KAP-001",
    name: "Ananya Menon",
    phone: "+91 98765 12340",
    email: "ananya@example.com",
    source: "Website",
    counsellor: "Dr. Anusree",
    status: "New",
    date: "16 Oct 2026",
  },
  {
    id: "KAP-002",
    name: "Meera Nair",
    phone: "+91 98765 12341",
    email: "meera@example.com",
    source: "Doctor Referral",
    counsellor: "Dr. Anusree",
    status: "Follow Up",
    date: "15 Oct 2026",
  },
  {
    id: "KAP-003",
    name: "Arjun Kumar",
    phone: "+91 98765 12342",
    email: "arjun@example.com",
    source: "Google Ads",
    counsellor: "Unassigned",
    status: "Contacted",
    date: "15 Oct 2026",
  },
  {
    id: "KAP-004",
    name: "Diya Thomas",
    phone: "+91 98765 12343",
    email: "diya@example.com",
    source: "Instagram",
    counsellor: "Dr. Anusree",
    status: "Converted",
    date: "14 Oct 2026",
  },
  {
    id: "KAP-005",
    name: "Rahul Das",
    phone: "+91 98765 12344",
    email: "rahul@example.com",
    source: "Walk In",
    counsellor: "Unassigned",
    status: "New",
    date: "14 Oct 2026",
  },
];

const navigation = [
  { name: "Dashboard", icon: "⌂" },
  { name: "Leads", icon: "♙" },
  { name: "Follow Ups", icon: "◷" },
  { name: "Appointments", icon: "▦" },
  { name: "Counsellors", icon: "♧" },
  { name: "Reports", icon: "▥" },
];

const followUps = [
  {
    time: "10:30 AM",
    name: "Meera Nair",
    description: "Initial enquiry follow up",
    type: "Phone call",
  },
  {
    time: "12:00 PM",
    name: "Ananya Menon",
    description: "Discuss counselling options",
    type: "Phone call",
  },
  {
    time: "03:00 PM",
    name: "Rahul Das",
    description: "Confirm appointment",
    type: "WhatsApp",
  },
];

function Icon({ children }) {
  return <span className="ui-icon" aria-hidden="true">{children}</span>;
}

function StatusBadge({ status }) {
  const statusClass = status.toLowerCase().replaceAll(" ", "-");

  return (
    <span className={`status-badge status-${statusClass}`}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function ProgressRing({ value = 80 }) {
  const radius = 53;
  const circumference = 2 * Math.PI * radius;
  const progress = (value / 100) * circumference;

  return (
    <div className="ring-container">
      <svg viewBox="0 0 140 140" className="progress-ring">
        <circle
          cx="70"
          cy="70"
          r={radius}
          fill="none"
          stroke="#E9DFD0"
          strokeWidth="9"
        />
        <circle
          cx="70"
          cy="70"
          r={radius}
          fill="none"
          stroke="#B96A08"
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={`${progress} ${circumference}`}
          transform="rotate(-90 70 70)"
        />
        <text x="70" y="68" textAnchor="middle" className="ring-value">
          {value}%
        </text>
        <text x="70" y="86" textAnchor="middle" className="ring-subtitle">
          Follow ups
        </text>
      </svg>
    </div>
  );
}

function LeadTrendChart() {
  const months = ["May", "Jun", "Jul", "Aug", "Sep", "Oct"];

  return (
    <div className="chart-container">
      <div className="chart-y-axis" aria-hidden="true">
        <span>40</span>
        <span>30</span>
        <span>20</span>
        <span>10</span>
        <span>0</span>
      </div>

      <div className="chart-main">
        <svg
          viewBox="0 0 500 160"
          preserveAspectRatio="none"
          className="trend-chart"
          role="img"
          aria-label="Illustrative lead activity trend"
        >
          {[20, 50, 80, 110, 140].map((y) => (
            <line
              key={y}
              x1="0"
              y1={y}
              x2="500"
              y2={y}
              className="chart-grid"
            />
          ))}

          <defs>
            <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#D99536" stopOpacity=".22" />
              <stop offset="100%" stopColor="#D99536" stopOpacity="0" />
            </linearGradient>
          </defs>

          <path
            d="M0 120 L40 102 L75 112 L110 76 L145 92 L180 64 L215 78 L250 42 L280 51 L315 26 L345 18 L375 68 L405 55 L435 84 L465 49 L500 34 L500 160 L0 160 Z"
            fill="url(#trendFill)"
          />

          <path
            d="M0 120 L40 102 L75 112 L110 76 L145 92 L180 64 L215 78 L250 42 L280 51 L315 26 L345 18 L375 68 L405 55 L435 84 L465 49 L500 34"
            fill="none"
            stroke="#B96A08"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        <div className="chart-months">
          {months.map((month) => <span key={month}>{month}</span>)}
        </div>
      </div>
    </div>
  );
}

function SectionHeading({ eyebrow, title, action, onAction }) {
  return (
    <div className="section-heading">
      <div className="section-heading-copy">
        <span className="eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
      </div>

      {action && (
        <button className="text-button" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const [activePage, setActivePage] = useState("Dashboard");
  const [leads, setLeads] = useState(initialLeads);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [showForm, setShowForm] = useState(false);
  const [selectedLead, setSelectedLead] = useState(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [newLead, setNewLead] = useState({
    name: "",
    phone: "",
    email: "",
    source: "Website",
  });

  const totalLeads = leads.length;
  const newCount = leads.filter((lead) => lead.status === "New").length;
  const followUpCount = leads.filter((lead) => lead.status === "Follow Up").length;
  const convertedCount = leads.filter((lead) => lead.status === "Converted").length;
  const contactedCount = leads.filter((lead) => lead.status === "Contacted").length;

  const filteredLeads = useMemo(() => {
    const term = search.trim().toLowerCase();

    return leads.filter((lead) => {
      const matchesSearch =
        lead.name.toLowerCase().includes(term) ||
        lead.phone.toLowerCase().includes(term) ||
        lead.email.toLowerCase().includes(term) ||
        lead.id.toLowerCase().includes(term);

      const matchesStatus =
        statusFilter === "All" || lead.status === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [leads, search, statusFilter]);

  function navigateTo(page) {
    setActivePage(page);
    setMobileMenuOpen(false);
    setSelectedLead(null);
  }

  function handleAddLead(event) {
    event.preventDefault();

    const lead = {
      id: `KAP-${String(Date.now()).slice(-6)}`,
      name: newLead.name.trim(),
      phone: newLead.phone.trim(),
      email: newLead.email.trim(),
      source: newLead.source,
      counsellor: "Unassigned",
      status: "New",
      date: new Date().toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      }),
    };

    setLeads((current) => [lead, ...current]);
    setNewLead({
      name: "",
      phone: "",
      email: "",
      source: "Website",
    });
    setStatusFilter("All");
    setSearch("");
    setShowForm(false);
    navigateTo("Leads");
  }

  function updateLeadStatus(lead) {
    const nextStatus = lead.status === "New" ? "Contacted" : "Follow Up";

    setLeads((current) =>
      current.map((item) =>
        item.id === lead.id ? { ...item, status: nextStatus } : item
      )
    );

    setSelectedLead(null);
  }

  function renderLeadsTable() {
    return (
      <>
        <div className="table-scroll">
          <table className="leads-table">
            <thead>
              <tr>
                <th>LEAD</th>
                <th>LEAD ID</th>
                <th>SOURCE</th>
                <th>COUNSELLOR</th>
                <th>STATUS</th>
                <th>DATE ADDED</th>
                <th aria-label="Actions" />
              </tr>
            </thead>

            <tbody>
              {filteredLeads.map((lead) => (
                <tr key={lead.id}>
                  <td>
                    <div className="person-cell">
                      <div className="person-avatar">
                        {lead.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="person-info">
                        <strong>{lead.name}</strong>
                        <span>{lead.phone}</span>
                      </div>
                    </div>
                  </td>
                  <td className="muted-cell">{lead.id}</td>
                  <td>{lead.source}</td>
                  <td>{lead.counsellor}</td>
                  <td><StatusBadge status={lead.status} /></td>
                  <td>{lead.date}</td>
                  <td>
                    <button
                      className="row-action"
                      onClick={() => setSelectedLead(lead)}
                      aria-label={`View details for ${lead.name}`}
                    >
                      ⋯
                    </button>
                  </td>
                </tr>
              ))}

              {filteredLeads.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <div className="empty-state">
                      <span className="empty-state-icon">⌕</span>
                      <strong>No leads found</strong>
                      <p>Try another search or change the status filter.</p>
                      <button
                        className="text-button"
                        onClick={() => {
                          setSearch("");
                          setStatusFilter("All");
                        }}
                      >
                        Clear filters
                      </button>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="table-footer">
          <span>Showing {filteredLeads.length} of {totalLeads} leads</span>
          <button className="text-button" onClick={() => navigateTo("Leads")}>
            View all leads <span aria-hidden="true">→</span>
          </button>
        </div>
      </>
    );
  }

  return (
    <main className="crm-shell">
      {mobileMenuOpen && (
        <button
          className="mobile-overlay"
          onClick={() => setMobileMenuOpen(false)}
          aria-label="Close navigation"
        />
      )}

      <aside className={`sidebar ${mobileMenuOpen ? "sidebar-open" : ""}`}>
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

          <button
            className="mobile-close"
            onClick={() => setMobileMenuOpen(false)}
            aria-label="Close menu"
          >
            ×
          </button>
        </div>

        <div className="workspace-label">WORKSPACE</div>

        <nav className="main-nav" aria-label="Main navigation">
          {navigation.map((item) => (
            <button
              key={item.name}
              className={`nav-item ${activePage === item.name ? "active" : ""}`}
              onClick={() => navigateTo(item.name)}
            >
              <Icon>{item.icon}</Icon>
              <span className="nav-label">{item.name}</span>

              {item.name === "Follow Ups" && followUpCount > 0 && (
                <span className="nav-count">{followUpCount}</span>
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="help-card">
            <span className="help-icon">i</span>
            <div>
              <strong>Need assistance?</strong>
              <span>Workspace guide</span>
            </div>
            <span className="help-arrow">↗</span>
          </div>

          <div className="profile">
            <div className="profile-avatar">A</div>
            <div className="profile-copy">
              <strong>CRM Admin</strong>
              <span>Administrator</span>
            </div>
            <span className="profile-chevron">⌄</span>
          </div>
        </div>
      </aside>

      <section className="main-panel">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="mobile-menu-button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open navigation"
            >
              ☰
            </button>
            <span>Workspace</span>
            <span className="breadcrumb-divider">/</span>
            <strong>{activePage}</strong>
          </div>

          <div className="topbar-actions">
            <span className="today-label">Friday, 16 October 2026</span>
            <button
              className="top-icon"
              aria-label="Appointments"
              onClick={() => navigateTo("Appointments")}
            >
              ▦
            </button>
            <button className="top-icon notification-button" aria-label="Notifications">
              ♧<span className="notification-dot" />
            </button>
          </div>
        </header>

        {activePage === "Dashboard" && (
          <>
            <section className="hero-panel">
              <div className="hero-content">
                <span className="eyebrow">YOUR WORKSPACE AT A GLANCE</span>
                <h1>Good morning, <span>Team Kappiness</span></h1>
                <p>Here is what is happening with your leads today.</p>

                <div className="hero-stats">
                  <div className="hero-stat">
                    <span className="hero-stat-icon">♙</span>
                    <div>
                      <strong>{totalLeads}</strong>
                      <span>Total Leads</span>
                    </div>
                  </div>

                  <div className="hero-stat">
                    <span className="hero-stat-icon">✳</span>
                    <div>
                      <strong>{newCount}</strong>
                      <span>New Leads</span>
                    </div>
                  </div>

                  <div className="hero-stat">
                    <span className="hero-stat-icon">◷</span>
                    <div>
                      <strong>{followUpCount}</strong>
                      <span>Follow Ups</span>
                    </div>
                  </div>

                  <div className="hero-stat">
                    <span className="hero-stat-icon">✓</span>
                    <div>
                      <strong>{convertedCount}</strong>
                      <span>Converted</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="hero-progress">
                <span className="progress-title">FOLLOW UP PROGRESS</span>
                <ProgressRing />
                <p>Keep every conversation moving forward.</p>
              </div>
            </section>

            <section className="dashboard-grid">
              <article className="surface schedule-card">
                <SectionHeading
                  eyebrow="STAY CONNECTED"
                  title="Today's follow ups"
                  action="View all →"
                  onAction={() => navigateTo("Follow Ups")}
                />

                <div className="schedule-date">
                  <span>FRI</span>
                  <strong>16</strong>
                  <small>OCT</small>
                </div>

                <div className="follow-list">
                  {followUps.map((item, index) => (
                    <div className="follow-item" key={item.name}>
                      <span className={`timeline-dot timeline-dot-${index}`} />

                      <span className="follow-time">{item.time}</span>

                      <div className="follow-details">
                        <strong>{item.name}</strong>
                        <span>{item.description}</span>
                        <small>{item.type}</small>
                      </div>

                      <button
                        className="round-arrow"
                        onClick={() => navigateTo("Follow Ups")}
                        aria-label={`Open follow up for ${item.name}`}
                      >
                        ↗
                      </button>
                    </div>
                  ))}
                </div>

                <button
                  className="schedule-add"
                  onClick={() => navigateTo("Follow Ups")}
                >
                  + View follow up schedule
                </button>
              </article>

              <article className="surface performance-card">
                <SectionHeading
                  eyebrow="LEAD ACTIVITY"
                  title="Lead overview"
                  action="↗"
                  onAction={() => navigateTo("Reports")}
                />

                <div className="performance-number">
                  <strong>{totalLeads}</strong>
                  <span className="trend-pill">Active records</span>
                </div>

                <p className="subtle-text">Lead activity over the past six months</p>

                <LeadTrendChart />

                <div className="chart-legend">
                  <span />
                  <span>Illustrative trend · Sample data</span>
                </div>
              </article>

              <article className="surface status-card">
                <SectionHeading
                  eyebrow="PIPELINE"
                  title="Lead status"
                  action="···"
                  onAction={() => navigateTo("Leads")}
                />

                <div className="pipeline-total">
                  <strong>{totalLeads}</strong>
                  <span>Total records</span>
                </div>

                <div className="status-bars">
                  {[
                    { name: "New", count: newCount, color: "bar-amber" },
                    { name: "Contacted", count: contactedCount, color: "bar-brown" },
                    { name: "Follow Up", count: followUpCount, color: "bar-beige" },
                    { name: "Converted", count: convertedCount, color: "bar-muted" },
                  ].map((item) => (
                    <button
                      key={item.name}
                      className="status-bar-item"
                      onClick={() => {
                        setStatusFilter(item.name);
                        navigateTo("Leads");
                      }}
                      aria-label={`View ${item.name} leads`}
                    >
                      <div className="status-bar-track">
                        <div
                          className={`status-bar-fill ${item.color}`}
                          style={{
                            height: `${Math.max(
                              8,
                              (item.count / Math.max(totalLeads, 1)) * 100
                            )}%`,
                          }}
                        />
                      </div>
                      <strong>{item.count}</strong>
                      <span>{item.name}</span>
                    </button>
                  ))}
                </div>
              </article>
            </section>

            <section className="quick-stats">
              <article className="quick-stat-card">
                <div className="quick-stat-top">
                  <span className="quick-stat-icon">◷</span>
                  <span className="quick-stat-tag">TODAY</span>
                </div>
                <span className="quick-stat-label">Follow ups due</span>
                <strong>{followUps.length}</strong>
                <button onClick={() => navigateTo("Follow Ups")}>
                  Review schedule ↗
                </button>
              </article>

              <article className="quick-stat-card">
                <div className="quick-stat-top">
                  <span className="quick-stat-icon">▦</span>
                  <span className="quick-stat-tag">UPCOMING</span>
                </div>
                <span className="quick-stat-label">Appointments</span>
                <strong>4</strong>
                <button onClick={() => navigateTo("Appointments")}>
                  View appointments ↗
                </button>
              </article>

              <article className="quick-stat-card">
                <div className="quick-stat-top">
                  <span className="quick-stat-icon">♙</span>
                  <span className="quick-stat-tag">TEAM</span>
                </div>
                <span className="quick-stat-label">Active counsellors</span>
                <strong>3</strong>
                <button onClick={() => navigateTo("Counsellors")}>
                  View team ↗
                </button>
              </article>

              <article className="quick-stat-card">
                <div className="quick-stat-top">
                  <span className="quick-stat-icon">✓</span>
                  <span className="quick-stat-tag">COMPLETED</span>
                </div>
                <span className="quick-stat-label">Converted leads</span>
                <strong>{convertedCount}</strong>
                <button
                  onClick={() => {
                    setStatusFilter("Converted");
                    navigateTo("Leads");
                  }}
                >
                  View converted ↗
                </button>
              </article>
            </section>

            <section className="surface leads-section">
              <div className="leads-section-heading">
                <div>
                  <span className="eyebrow">YOUR LATEST RECORDS</span>
                  <h2>Recent leads</h2>
                  <p>Keep track of every new conversation.</p>
                </div>

                <button className="primary-button" onClick={() => setShowForm(true)}>
                  <span>＋</span> Add lead
                </button>
              </div>

              <div className="table-toolbar">
                <div className="table-tabs">
                  {[
                    { label: "All leads", value: "All" },
                    { label: "New", value: "New" },
                    { label: "Follow ups", value: "Follow Up" },
                  ].map((tab) => (
                    <button
                      key={tab.value}
                      className={`table-tab ${statusFilter === tab.value ? "active" : ""}`}
                      onClick={() => setStatusFilter(tab.value)}
                    >
                      {tab.label}
                      {tab.value === "All" && <span>{totalLeads}</span>}
                    </button>
                  ))}
                </div>

                <div className="table-controls">
                  <label className="search-box">
                    <span aria-hidden="true">⌕</span>
                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search leads..."
                      aria-label="Search leads"
                    />
                  </label>

                  <select
                    className="filter-select"
                    value={statusFilter}
                    onChange={(event) => setStatusFilter(event.target.value)}
                    aria-label="Filter by lead status"
                  >
                    {["All", "New", "Contacted", "Follow Up", "Converted", "Lost"].map((status) => (
                      <option key={status} value={status}>{status === "All" ? "All statuses" : status}</option>
                    ))}
                  </select>
                </div>
              </div>

              {renderLeadsTable()}
            </section>
          </>
        )}

        {activePage === "Leads" && (
          <section className="surface page-section">
            <div className="leads-section-heading">
              <div>
                <span className="eyebrow">RELATIONSHIP MANAGEMENT</span>
                <h2>Leads</h2>
                <p>Manage and track your enquiries in one place.</p>
              </div>
              <button className="primary-button" onClick={() => setShowForm(true)}>
                ＋ Add lead
              </button>
            </div>

            <div className="table-toolbar">
              <div className="table-tabs">
                {["All", "New", "Contacted", "Follow Up", "Converted", "Lost"].map((status) => (
                  <button
                    key={status}
                    className={`table-tab ${statusFilter === status ? "active" : ""}`}
                    onClick={() => setStatusFilter(status)}
                  >
                    {status === "All" ? "All leads" : status}
                  </button>
                ))}
              </div>

              <label className="search-box page-search">
                <span aria-hidden="true">⌕</span>
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search leads..."
                  aria-label="Search leads"
                />
              </label>
            </div>

            {renderLeadsTable()}

            <p className="prototype-note">
              Prototype data only. Supabase persistence has not been connected yet.
            </p>
          </section>
        )}

        {activePage !== "Dashboard" && activePage !== "Leads" && (
          <section className="surface placeholder-page">
            <div className="placeholder-icon">
              {navigation.find((item) => item.name === activePage)?.icon || "⚙"}
            </div>
            <span className="eyebrow">KAPPINESS CRM</span>
            <h2>{activePage}</h2>
            <p>This section is ready for the next implementation step.</p>

            {activePage === "Follow Ups" && (
              <div className="placeholder-follow-list">
                {followUps.map((item) => (
                  <div className="placeholder-follow" key={item.name}>
                    <strong>{item.name}</strong>
                    <span>{item.description}</span>
                    <small>{item.time}</small>
                  </div>
                ))}
              </div>
            )}

            <button className="secondary-button" onClick={() => navigateTo("Dashboard")}>
              ← Back to dashboard
            </button>
          </section>
        )}

        <footer className="app-footer">
          <span>© 2026 Kappiness CRM</span>
          <span>Nourishing Minds, Pouring Happiness.</span>
        </footer>
      </section>

      {showForm && (
        <div className="modal-backdrop" onClick={() => setShowForm(false)}>
          <section
            className="lead-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-lead-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">NEW RECORD</span>
                <h2 id="add-lead-title">Add a lead</h2>
                <p>Enter the details of a new enquiry.</p>
              </div>
              <button
                className="modal-close"
                onClick={() => setShowForm(false)}
                aria-label="Close form"
              >
                ×
              </button>
            </div>

            <form onSubmit={handleAddLead}>
              <label>
                Full name <span className="required">*</span>
                <input
                  required
                  value={newLead.name}
                  onChange={(event) => setNewLead({ ...newLead, name: event.target.value })}
                  placeholder="Enter full name"
                />
              </label>

              <label>
                Phone number <span className="required">*</span>
                <input
                  required
                  type="tel"
                  value={newLead.phone}
                  onChange={(event) => setNewLead({ ...newLead, phone: event.target.value })}
                  placeholder="+91"
                />
              </label>

              <label>
                Email address
                <input
                  type="email"
                  value={newLead.email}
                  onChange={(event) => setNewLead({ ...newLead, email: event.target.value })}
                  placeholder="name@example.com"
                />
              </label>

              <label>
                Lead source
                <select
                  value={newLead.source}
                  onChange={(event) => setNewLead({ ...newLead, source: event.target.value })}
                >
                  {[
                    "Website",
                    "Phone Call",
                    "Walk In",
                    "Doctor Referral",
                    "Instagram",
                    "Facebook",
                    "Google Ads",
                    "WhatsApp",
                    "Other",
                  ].map((source) => <option key={source}>{source}</option>)}
                </select>
              </label>

              <div className="modal-actions">
                <button type="button" className="secondary-button" onClick={() => setShowForm(false)}>
                  Cancel
                </button>
                <button type="submit" className="primary-button">
                  Save lead
                </button>
              </div>

              <p className="form-note">
                This prototype keeps new leads in temporary page state. They will not persist after a refresh.
              </p>
            </form>
          </section>
        </div>
      )}

      {selectedLead && (
        <div className="modal-backdrop" onClick={() => setSelectedLead(null)}>
          <section
            className="lead-modal details-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="lead-details-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">LEAD DETAILS</span>
                <h2 id="lead-details-title">{selectedLead.name}</h2>
                <p>{selectedLead.id}</p>
              </div>
              <button
                className="modal-close"
                onClick={() => setSelectedLead(null)}
                aria-label="Close details"
              >
                ×
              </button>
            </div>

            <div className="detail-list">
              <div><span>Phone</span><strong>{selectedLead.phone}</strong></div>
              <div><span>Email</span><strong>{selectedLead.email || "Not provided"}</strong></div>
              <div><span>Source</span><strong>{selectedLead.source}</strong></div>
              <div><span>Assigned counsellor</span><strong>{selectedLead.counsellor}</strong></div>
              <div><span>Status</span><StatusBadge status={selectedLead.status} /></div>
              <div><span>Date added</span><strong>{selectedLead.date}</strong></div>
            </div>

            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setSelectedLead(null)}>
                Close
              </button>
              <button className="primary-button" onClick={() => updateLeadStatus(selectedLead)}>
                {selectedLead.status === "New" ? "Mark contacted" : "Mark follow up"}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
