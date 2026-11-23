"use client";

import { useState } from "react";
import Dialog from "./Dialog";

/* Asks before a significant change. onConfirm() resolves to { ok, message }; the dialog stays open on failure
   and shows the message, so nothing is reported as done before the database confirms it. */
export default function ConfirmDialog({ title, children, confirmLabel = "Confirm", danger = false, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError("");
    const result = await onConfirm();
    setBusy(false);
    if (result && result.ok) onClose();
    else setError((result && result.message) || "That didn't work. Please try again.");
  }

  return (
    <Dialog
      titleId="confirm-dialog-title"
      title={title}
      onClose={onClose}
      busy={busy}
      small
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Go back
          </button>
          <button type="button" className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={confirm} disabled={busy}>
            {busy ? "Saving…" : confirmLabel}
          </button>
        </>
      }
    >
      <div className="modal-body confirm-body">
        {children}
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
