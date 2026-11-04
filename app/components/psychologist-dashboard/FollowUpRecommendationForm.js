"use client";

import { useState } from "react";
import { dateKey } from "../../lib/calendar";
import { RECOMMENDATION_PRIORITIES } from "../../lib/sessionsApi";

/* The psychologist RECOMMENDS a follow-up after a completed session. Staff track it in the CRM and book it
   through the normal appointment process: a recommendation is never an appointment by itself.
   `initial` pre-fills the form when editing an open recommendation. */
export default function FollowUpRecommendationForm({ appointment, initial = null, onSubmit, onCancel }) {
  const [values, setValues] = useState({
    date: initial ? initial.recommended_date : "",
    time: initial && initial.recommended_time ? String(initial.recommended_time).slice(0, 5) : "",
    notes: initial ? initial.recommendation : "",
    priority: initial ? initial.priority : "Normal",
  });
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const todayKey = dateKey(new Date());
  const errors = {};
  if (!values.date) errors.date = "Choose the recommended date.";
  else if (values.date < todayKey) errors.date = "The recommended date cannot be in the past.";
  if (values.notes.trim().length < 3) errors.notes = "Describe the recommended follow-up.";
  else if (values.notes.length > 2000) errors.notes = "Keep it under 2000 characters.";

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
      appointmentId: appointment ? appointment.id : null,
      date: values.date,
      time: values.time,
      notes: values.notes.trim(),
      priority: values.priority,
    });
    setSaving(false);
    if (!result.ok) setMessage(result.message);
  }

  return (
    <form className="lost-prompt" style={{ borderLeftColor: "var(--warning-dot)", display: "flex", flexDirection: "column", gap: 12, marginTop: 0 }} onSubmit={handleSubmit} noValidate>
      <div>
        <strong>{initial ? "Edit recommendation" : "Recommend a follow-up"}</strong>
        <p className="subtle-text" style={{ marginTop: 2 }}>
          Staff track this and book it through the normal appointment process. The client is not contacted from here.
        </p>
      </div>

      {message ? <div className="form-alert" role="alert">{message}</div> : null}

      {appointment ? (
        <div className="field">
          <span className="field-label">Client</span>
          <strong>{appointment.clientName}</strong>
        </div>
      ) : null}

      <div className="field">
        <label htmlFor="fu-notes">Recommendation</label>
        <textarea id="fu-notes" rows={3} aria-invalid={Boolean(show("notes"))} value={values.notes} onChange={setField("notes")} />
        {show("notes") ? <p className="field-error" role="alert">{errors.notes}</p> : null}
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="fu-date">Recommended date</label>
          <input id="fu-date" type="date" min={todayKey} aria-invalid={Boolean(show("date"))} value={values.date} onChange={setField("date")} />
          {show("date") ? <p className="field-error" role="alert">{errors.date}</p> : null}
        </div>
        <div className="field">
          <label htmlFor="fu-time">Recommended time (optional)</label>
          <input id="fu-time" type="time" value={values.time} onChange={setField("time")} />
        </div>
      </div>

      <div className="field">
        <label htmlFor="fu-priority">Priority</label>
        <select id="fu-priority" value={values.priority} onChange={setField("priority")}>
          {RECOMMENDATION_PRIORITIES.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? "Saving..." : initial ? "Save changes" : "Save recommendation"}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>Cancel</button>
      </div>
    </form>
  );
}
