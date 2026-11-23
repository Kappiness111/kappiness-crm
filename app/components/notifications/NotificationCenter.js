"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "../Icon";
import { Badge } from "../ui/StatusBadges";
import { NOTIFICATION_CATEGORIES, loadNotifications, readIds, saveReadIds } from "../../lib/notifications";

/* Bell + panel for staff pages. Built from real records on open (and every 5 minutes); nothing is sent to
   clients from here. sessionItems: changes made in this browser tab ({ id, text, at, read }).
   onNavigate(href): opens the related page. */
export default function NotificationCenter({ onNavigate, sessionItems = [], onSessionRead }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState("idle"); // idle | loading | ready | error
  const [read, setRead] = useState(() => new Set());
  const [filter, setFilter] = useState("all");
  const wrapRef = useRef(null);

  const refresh = useCallback(async () => {
    setStatus((current) => (current === "ready" ? "ready" : "loading"));
    try {
      setItems(await loadNotifications(new Date()));
      setStatus("ready");
    } catch (error) {
      console.error("Failed to load notifications:", error);
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    // First load after mount, then every 5 minutes so the unread count stays current.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRead(readIds());
    refresh();
    const timer = setInterval(refresh, 5 * 60000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!open) return undefined;
    function onKey(event) {
      if (event.key === "Escape") setOpen(false);
    }
    function onClick(event) {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const unread = items.filter((item) => !read.has(item.id)).length + sessionItems.filter((item) => !item.read).length;
  const categories = useMemo(() => {
    const present = new Set(items.map((item) => item.category));
    return Object.keys(NOTIFICATION_CATEGORIES).filter((key) => present.has(key));
  }, [items]);
  const visible = filter === "all" ? items : items.filter((item) => item.category === filter);

  function markRead(ids) {
    setRead((current) => {
      const next = new Set(current);
      ids.forEach((id) => next.add(id));
      saveReadIds(next);
      return next;
    });
  }

  function openItem(item) {
    markRead([item.id]);
    setOpen(false);
    onNavigate(item.href);
  }

  return (
    <div className="popover-wrap" ref={wrapRef}>
      <button
        type="button"
        className="icon-btn"
        aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          setOpen((value) => !value);
          if (!open) refresh();
        }}
      >
        <Icon name="bell" />
        {unread > 0 && <span className="dot" />}
      </button>

      {open && (
        <div className="menu notif-panel notif-center" role="dialog" aria-label="Notifications">
          <div className="notif-head">
            <strong>
              Notifications {unread > 0 ? <span className="muted num">· {unread} unread</span> : null}
            </strong>
            {unread > 0 && (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  markRead(items.map((item) => item.id));
                  if (onSessionRead) onSessionRead();
                }}
              >
                Mark all as read
              </button>
            )}
          </div>

          {categories.length > 1 && (
            <div className="notif-filters" role="radiogroup" aria-label="Show">
              {["all", ...categories].map((key) => (
                <button key={key} type="button" role="radio" aria-checked={filter === key} className={filter === key ? "is-active" : ""} onClick={() => setFilter(key)}>
                  {key === "all" ? "All" : NOTIFICATION_CATEGORIES[key].label}
                </button>
              ))}
            </div>
          )}

          <div className="notif-list">
            {status === "loading" && <p className="notif-empty">Loading notifications…</p>}
            {status === "error" && <p className="notif-empty">We couldn&apos;t load notifications. Close and open this panel to try again.</p>}

            {filter === "all" &&
              sessionItems.map((item) => (
                <div className={`notif-item ${item.read ? "" : "unread"}`} key={item.id}>
                  <span className="notif-meta">
                    <Badge tone="neutral">Just now</Badge>
                  </span>
                  <strong>{item.text}</strong>
                  <small>{new Date(item.at).toLocaleString("en-GB", { hour: "numeric", minute: "2-digit", day: "numeric", month: "short" })}</small>
                </div>
              ))}

            {status === "ready" &&
              visible.map((item) => {
                const meta = NOTIFICATION_CATEGORIES[item.category];
                const isRead = read.has(item.id);
                return (
                  <button type="button" className={`notif-item ${isRead ? "" : "unread"}`} key={item.id} onClick={() => openItem(item)}>
                    <span className="notif-meta">
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                      {!isRead && <span className="sr-only">Unread.</span>}
                    </span>
                    <strong>{item.title}</strong>
                    <small>{item.message}</small>
                    <span className="notif-action">
                      {item.action} <Icon name="arrowRight" />
                    </span>
                  </button>
                );
              })}

            {status === "ready" && visible.length === 0 && sessionItems.length === 0 && (
              <p className="notif-empty">You&apos;re all caught up. There are no notifications at the moment.</p>
            )}
          </div>
          <p className="notif-foot">Built from your CRM records. Nothing here is sent to clients. Read status is saved on this device.</p>
        </div>
      )}
    </div>
  );
}
