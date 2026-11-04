"use client";

import { useState } from "react";
import Dialog from "./Dialog";

/* Asks for a required reason or outcome before an action (cancel an appointment, close a recommendation).
   onSubmit(text) resolves to { ok, message }. */
export default function ReasonDialog({
  title,
  subtitle,
  label = "Reason",
  confirmLabel = "Save",
  danger = false,
  choices = null, // optional [{ value, label }] radio choices, passed to onSubmit as the second argument
  onClose,
  onSubmit,
}) {
  const [text, setText] = useState("");
  const [choice, setChoice] = useState(choices ? choices[0].value : null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    if (!text.trim()) {
      setError(`Add the ${label.toLowerCase()}.`);
      return;
    }
    setBusy(true);
    setError("");
    const result = await onSubmit(text.trim(), choice);
    setBusy(false);
    if (result && result.ok) onClose();
    else setError((result && result.message) || "Could not save. Please try again.");
  }

  return (
    <Dialog
      titleId="reason-dialog-title"
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      busy={busy}
      small
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Back
          </button>
          <button type="submit" form="reason-dialog-form" className={`btn ${danger ? "btn-danger" : "btn-primary"}`} disabled={busy}>
            {busy ? "Saving…" : confirmLabel}
          </button>
        </>
      }
    >
      <form id="reason-dialog-form" className="modal-body" onSubmit={submit} noValidate>
        {choices && (
          <div className="field">
            <span className="field-label">Result</span>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              {choices.map((item) => (
                <label key={item.value} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                  <input type="radio" name="reason-choice" value={item.value} checked={choice === item.value} onChange={() => setChoice(item.value)} />
                  {item.label}
                </label>
              ))}
            </div>
          </div>
        )}
        <div className="field">
          <label htmlFor="reason-dialog-text">{label}</label>
          <textarea
            id="reason-dialog-text"
            rows={3}
            maxLength={1000}
            value={text}
            aria-invalid={Boolean(error)}
            onChange={(event) => {
              setText(event.target.value);
              setError("");
            }}
          />
          {error ? (
            <p className="field-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </form>
    </Dialog>
  );
}
