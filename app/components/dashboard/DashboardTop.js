"use client";

import { useEffect, useRef, useState } from "react";
import Icon from "../Icon";
import { loadDashboardCounts } from "../../lib/dashboardApi";

/* Top of the dashboard: who and when, the few things people do most, and one line of today's to-dos.
   Everything else on the dashboard is the clinic schedule itself (the same board as Availability & Leave). */

const telHref = (phone) => `tel:${String(phone || "").replace(/[^\d+]/g, "")}`;

function CallFinder({ people, onClose }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const digits = q.replace(/\D/g, "");
  const matches = q
    ? people
        .filter((p) => p.phone && (p.name.toLowerCase().includes(q) || (digits.length >= 3 && p.phone.replace(/\D/g, "").includes(digits))))
        .slice(0, 6)
    : [];
  return (
    <div className="ops-call" role="dialog" aria-label="Make a call">
      <div className="ops-call-head">
        <strong>Who do you want to call?</strong>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <Icon name="close" />
        </button>
      </div>
      <label className="search">
        <Icon name="search" />
        <span className="sr-only">Search a lead or client</span>
        <input autoFocus type="search" placeholder="Type a name or number" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {q && matches.length === 0 ? <p className="subtle-text">Nobody with a phone number matches.</p> : null}
      <ul className="ops-call-list">
        {matches.map((p) => (
          <li key={`${p.kind}-${p.id}`}>
            <a href={telHref(p.phone)}>
              <Icon name="phone" />
              <span>
                <strong>{p.name}</strong>
                <small>
                  {p.phone} · {p.kind}
                </small>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function useOutside(ref, open, close) {
  useEffect(() => {
    if (!open) return undefined;
    function onPointer(event) {
      if (ref.current && !ref.current.contains(event.target)) close();
    }
    function onKey(event) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [ref, open, close]);
}

export default function DashboardTop({
  greeting,
  dateLabel,
  now,
  leads,
  leadsLoading,
  clients,
  canBook,
  onAddLead,
  onAddClient,
  onBook,
  onScheduleFollowUp,
  onSendReminder,
  onOpenFollowUpCalls,
  onOpenLeads,
}) {
  const [menu, setMenu] = useState(null); // "call" | "more" | null
  const callRef = useRef(null);
  const moreRef = useRef(null);
  useOutside(callRef, menu === "call", () => setMenu(null));
  useOutside(moreRef, menu === "more", () => setMenu(null));

  // Lead numbers: from the dashboard database views when they are applied, otherwise counted here.
  const [fromViews, setFromViews] = useState(null);
  useEffect(() => {
    if (!now) return undefined;
    let cancelled = false;
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
    loadDashboardCounts({ start, end })
      .then((data) => {
        if (!cancelled) setFromViews(data);
      })
      .catch((error) => {
        console.error("Dashboard views could not be read; counting in the browser instead:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [now, leads]);

  const open = leads.filter((l) => l.status !== "Lost" && l.status !== "Confirmed" && l.next_follow_up_at);
  const sameDay = (iso) => now && new Date(iso).toDateString() === now.toDateString();
  const local = {
    due: now ? open.filter((l) => sameDay(l.next_follow_up_at) && new Date(l.next_follow_up_at) >= now).length : 0,
    overdue: now ? open.filter((l) => new Date(l.next_follow_up_at) < now).length : 0,
    fresh: now ? leads.filter((l) => l.created_at && sameDay(l.created_at)).length : 0,
    awaiting: leads.filter((l) => l.status === "Yet to Confirm" || l.status === "Will Inform").length,
  };
  const counts = fromViews
    ? {
        due: fromViews.followUpCalls.dueToday,
        overdue: fromViews.followUpCalls.overdue,
        fresh: fromViews.leads.newInPeriod,
        awaiting: fromViews.leads.awaiting,
      }
    : local;
  const pending = leadsLoading || !now;

  const people = [
    ...clients.map((c) => ({ id: c.id, name: c.full_name, phone: c.phone, kind: "Client" })),
    ...leads.filter((l) => l.status !== "Confirmed").map((l) => ({ id: l.id, name: l.full_name || "Lead", phone: l.phone, kind: "Lead" })),
  ];

  const todo = [
    { id: "overdue", n: counts.overdue, text: (n) => `${n} overdue call${n === 1 ? "" : "s"}`, tone: "danger", onClick: onOpenFollowUpCalls },
    { id: "due", n: counts.due, text: (n) => `${n} call${n === 1 ? "" : "s"} due today`, onClick: onOpenFollowUpCalls },
    { id: "awaiting", n: counts.awaiting, text: (n) => `${n} lead${n === 1 ? "" : "s"} waiting to confirm`, onClick: () => onOpenLeads("Yet to Confirm") },
    { id: "fresh", n: counts.fresh, text: (n) => `${n} new lead${n === 1 ? "" : "s"} today`, onClick: () => onOpenLeads("Enquiry") },
  ].filter((item) => item.n > 0);

  return (
    <section className="home-top" aria-label="Today">
      <div className="home-hello">
        <h1>{greeting}</h1>
        <p>{dateLabel}</p>
      </div>

      <div className="home-actions">
        <button type="button" className="btn btn-primary" onClick={onAddLead}>
          <Icon name="plus" /> Add lead
        </button>
        {canBook && (
          <button type="button" className="btn" onClick={onBook}>
            <Icon name="calendar" /> Book appointment
          </button>
        )}
        <span className="popover-wrap" ref={callRef}>
          <button type="button" className="btn" aria-expanded={menu === "call"} onClick={() => setMenu(menu === "call" ? null : "call")}>
            <Icon name="phone" /> Call
          </button>
          {menu === "call" && <CallFinder people={people} onClose={() => setMenu(null)} />}
        </span>
        <span className="popover-wrap" ref={moreRef}>
          <button type="button" className="btn" aria-haspopup="menu" aria-expanded={menu === "more"} onClick={() => setMenu(menu === "more" ? null : "more")}>
            More <Icon name="chevronDown" />
          </button>
          {menu === "more" && (
            <div className="menu home-more" role="menu">
              {[
                ["user", "Add client", "Starts as a lead; confirming it creates the client", onAddClient],
                ["calendarCheck", "Schedule follow-up", "Book a follow-up a psychologist recommended", onScheduleFollowUp],
                ["bell", "Send reminder", "Record a reminder for a booked follow-up", onSendReminder],
              ].map(([icon, label, hint, run]) => (
                <button
                  key={label}
                  type="button"
                  role="menuitem"
                  className="menu-item home-more-item"
                  onClick={() => {
                    setMenu(null);
                    run();
                  }}
                >
                  <Icon name={icon} />
                  <span>
                    {label}
                    <small>{hint}</small>
                  </span>
                </button>
              ))}
            </div>
          )}
        </span>
      </div>

      <p className="home-todo" role="status">
        {pending ? (
          <span className="muted">Checking today&apos;s calls and leads…</span>
        ) : todo.length === 0 ? (
          <span className="home-clear">
            <Icon name="checkCircle" /> No calls due and nothing overdue.
          </span>
        ) : (
          <>
            <span className="home-todo-label">To do</span>
            {todo.map((item) => (
              <button key={item.id} type="button" className={`home-chip ${item.tone === "danger" ? "is-danger" : ""}`} onClick={item.onClick}>
                {item.text(item.n)}
                <Icon name="chevronRight" />
              </button>
            ))}
          </>
        )}
      </p>
    </section>
  );
}
