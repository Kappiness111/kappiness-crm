"use client";

import Icon from "./Icon";
import ModalShell from "./ModalShell";

/* Standard dialog: title (+ optional subtitle), body, optional footer. Built on ModalShell.
   While `busy`, Escape, the backdrop and the close button do nothing so a save cannot be interrupted. */
export default function Dialog({ titleId, title, subtitle, onClose, busy = false, small = false, size, footer, children }) {
  const requestClose = () => {
    if (!busy) onClose();
  };

  return (
    <ModalShell labelledBy={titleId} onRequestClose={requestClose} size={size || (small ? "sm" : "md")}>
      <header className="modal-head">
        <div>
          <h2 id={titleId}>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        <button type="button" className="icon-btn" onClick={requestClose} disabled={busy} aria-label="Close">
          <Icon name="close" />
        </button>
      </header>
      {children}
      {footer ? <footer className="modal-foot">{footer}</footer> : null}
    </ModalShell>
  );
}
