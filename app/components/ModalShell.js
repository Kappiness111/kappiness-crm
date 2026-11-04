"use client";

import { useEffect, useRef } from "react";

/* The one modal frame used across the CRM (dialogs and side drawers).
   Handles Escape, outside click, page scroll lock and focus: focus moves into the dialog when it opens,
   stays inside while tabbing, and returns to the element that opened it when it closes. */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function ModalShell({
  labelledBy,
  onRequestClose,
  className = "",
  variant = "dialog", // dialog | drawer
  size = "md", // sm | md | lg
  children,
}) {
  const closeRef = useRef(onRequestClose);
  const panelRef = useRef(null);

  useEffect(() => {
    closeRef.current = onRequestClose;
  });

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement;
    document.body.style.overflow = "hidden";

    // Respect an autoFocus field inside the dialog; otherwise focus the panel itself.
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true });

    function onKeyDown(event) {
      if (event.key === "Escape") {
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const items = [...panelRef.current.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
      if (previousFocus && typeof previousFocus.focus === "function" && document.contains(previousFocus)) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, []);

  const drawer = variant === "drawer";
  return (
    <div
      className={`modal-backdrop ${drawer ? "drawer-backdrop" : ""}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeRef.current();
      }}
    >
      <section
        ref={panelRef}
        tabIndex={-1}
        className={`modal ${drawer ? "drawer" : ""} size-${size} ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
      >
        {children}
      </section>
    </div>
  );
}
