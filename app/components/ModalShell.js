"use client";

import { useEffect, useRef } from "react";

/* Backdrop + dialog frame. Handles Escape, outside click, and page scroll lock. */

export default function ModalShell({ labelledBy, onRequestClose, className = "", variant = "dialog", children }) {
  const closeRef = useRef(onRequestClose);

  useEffect(() => {
    closeRef.current = onRequestClose;
  });

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKeyDown(event) {
      if (event.key === "Escape") closeRef.current();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <div
      className={`modal-backdrop ${variant === "drawer" ? "drawer-backdrop" : ""}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeRef.current();
      }}
    >
      <section className={`lead-modal ${variant === "drawer" ? "lead-drawer" : ""} ${className}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        {children}
      </section>
    </div>
  );
}