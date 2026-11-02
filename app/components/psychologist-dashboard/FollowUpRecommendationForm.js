"use client";

import { useState } from "react";
import { dateKey } from "../../lib/calendar";
import styles from "./dashboard.module.css";

/* The psychologist RECOMMENDS a follow-up. Staff record and track it in the CRM.
   The client reminder workflow is intentionally not part of this form. */
export default function FollowUpRecommendationForm({ appointment, allowNotes, onSubmit, onCancel }) {
  const [values, setValues] = useState({ date: "", time: "", notes: "" });
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const todayKey = dateKey(new Date());
  const errors = {};
  if (!values.date) errors.date = "Choose the recommended date.";
  else if (values.date < todayKey) errors.date = "The recommended date cannot be in the past.";
  if (!values.time) errors.time = "Choose the recommended time.";

  const setField = (field) => (event) => setValues((current) => ({ ...current, [field]: event.target.value }));
  const show = (field) => (submitted ? errors[field] : undefined);

  async function handleSubmit(event) {
    event.preventDefault();
    if (saving) return;
    setSubmitted(true);
    setMessage("");
    if (Object.keys(errors).length > 0) return;

    setSaving(true);
    const result = await onSubmit({
      appointmentId: appointment.id,
      clientId: appointment.clientId,
      date: values.date,
      time: values.time,
      notes: allowNotes ? values.notes.trim() : undefined,
    });
    setSaving(false);
    if (!result.ok) setMessage(result.message);
  }

  return (
    <form className={styles.inlineForm} onSubmit={handleSubmit} noValidate>
      <div>
        <strong>Recommend a follow-up</strong>
        <p className={styles.help} style={{ marginTop: 4 }}>
          Staff will record and track this recommendation. The client is not contacted from here.
        </p>
      </div>

      {message ? <div className={styles.formAlert} role="alert">{message}</div> : null}

      <div className={styles.field}>
        <span className={styles.label}>Client</span>
        <strong>{appointment.clientName}</strong>
      </div>

      <div className={styles.fieldRow}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="fu-date">Recommended date</label>
          <input
            id="fu-date"
            type="date"
            min={todayKey}
            className={`${styles.input} ${show("date") ? styles.inputError : ""}`}
            value={values.date}
            onChange={setField("date")}
          />
          {show("date") ? <p className={styles.fieldError} role="alert">{errors.date}</p> : null}
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="fu-time">Recommended time</label>
          <input
            id="fu-time"
            type="time"
            className={`${styles.input} ${show("time") ? styles.inputError : ""}`}
            value={values.time}
            onChange={setField("time")}
          />
          {show("time") ? <p className={styles.fieldError} role="alert">{errors.time}</p> : null}
        </div>
      </div>

      {allowNotes ? (
        <div className={styles.field}>
          <label className={styles.label} htmlFor="fu-notes">Notes (optional)</label>
          <textarea id="fu-notes" rows={3} className={styles.input} value={values.notes} onChange={setField("notes")} />
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={saving}>
          {saving ? "Sending..." : "Send recommendation"}
        </button>
        <button type="button" className={styles.btn} onClick={onCancel} disabled={saving}>Cancel</button>
      </div>
    </form>
  );
}