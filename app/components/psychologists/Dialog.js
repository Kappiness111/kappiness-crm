"use client";

import { useEffect, useRef } from "react";
import Icon from "../Icon";
import styles from "./psychologists.module.css";

/* Modal frame: Escape and outside click close it (unless busy), page scroll is locked. */
export default function Dialog({ titleId, title, subtitle, onClose, busy = false, small = false, footer, children }) {
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);

  useEffect(() => {
    closeRef.current = onClose;
    busyRef.current = busy;
  });

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKeyDown(event) {
      if (event.key === "Escape" && !busyRef.current) closeRef.current();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <div
      className={styles.backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busyRef.current) closeRef.current();
      }}
    >
      <section
        className={`${styles.dialog} ${small ? styles.dialogSmall : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className={styles.dialogHead}>
          <div>
            <h2 id={titleId} className={styles.dialogTitle}>{title}</h2>
            {subtitle ? <p className={styles.dialogSub}>{subtitle}</p> : null}
          </div>
          <button type="button" className={styles.closeBtn} onClick={onClose} disabled={busy} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        {children}
        {footer ? <footer className={styles.dialogFoot}>{footer}</footer> : null}
      </section>
    </div>
  );
}