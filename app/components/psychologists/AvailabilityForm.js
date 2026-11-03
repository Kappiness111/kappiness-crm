"use client";

import { useState } from "react";
import { DAYS, validateAvailability } from "../../lib/psychologists";
import Dialog from "./Dialog";

/* Add / edit one recurring availability period.
   period = existing period when editing; defaultDay = weekday pre-selected when adding. */
export default function AvailabilityForm({ period, defaultDay = 1, existingPeriods, onSubmit, onClose }) {
  const editing = Boolean(period);
  const [draft, setDraft] = useState({
    day_of_week: editing ? period.day_of_week : defaultDay,
    start_time: editing ? period.start_time : "09:00",
    end_time: editing ? period.end_time : "17:00",
    is_active: editing ? period.is_active : true,
  });
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const errors = validateAvailability(draft, existingPeriods, editing ? period.id : null);
  const showError = (field) => (submitted ? errors[field] : undefined);
  const setField = (field) => (event) => setDraft((current) => ({ ...current, [field]: event.target.value }));

  async function handleSubmit(event) {
    event.preventDefault();
    if (saving) return;
    setSubmitted(true);
    setFormError("");
    if (Object.keys(errors).length > 0) return;

    setSaving(true);
    const result = await onSubmit({ ...draft, day_of_week: Number(draft.day_of_week) });
    setSaving(false);

    if (!result || !result.ok) setFormError((result && result.message) || "Could not save. Please try again.");
  }

  return (
    <Dialog
      titleId="availability-form-title"
      title={editing ? "Edit availability" : "Add availability"}
      subtitle="Recurring weekly working hours. This does not create bookable appointment slots."
      onClose={onClose}
      busy={saving}
      small
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" form="availability-form" className="btn btn-primary" disabled={saving}>
            {saving ? "Saving..." : editing ? "Save changes" : "Add availability"}
          </button>
        </>
      }
    >
      <form id="availability-form" className="modal-body" onSubmit={handleSubmit} noValidate>
        {formError ? <div className="form-alert" role="alert">{formError}</div> : null}

        <div className="field">
          <label htmlFor="avail-day">Weekday <span className="required">*</span></label>
          <select
            id="avail-day"
            aria-invalid={Boolean(showError("day_of_week"))}
            value={draft.day_of_week}
            onChange={setField("day_of_week")}
          >
            {DAYS.map((day) => (
              <option key={day.value} value={day.value}>{day.name}</option>
            ))}
          </select>
          {showError("day_of_week") ? <p className="field-error" role="alert">{errors.day_of_week}</p> : null}
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="avail-start">Start time <span className="required">*</span></label>
            <input
              id="avail-start"
              type="time"
              aria-invalid={Boolean(showError("start_time"))}
              value={draft.start_time}
              onChange={setField("start_time")}
                          />
          </div>
          <div className="field">
            <label htmlFor="avail-end">End time <span className="required">*</span></label>
            <input
              id="avail-end"
              type="time"
              aria-invalid={Boolean(showError("end_time"))}
              value={draft.end_time}
              onChange={setField("end_time")}
                          />
          </div>
        </div>
        {showError("start_time") ? <p className="field-error" role="alert">{errors.start_time}</p> : null}
        {showError("end_time") ? <p className="field-error" role="alert">{errors.end_time}</p> : null}

        <label className="check-row">
          <input
            type="checkbox"
            checked={draft.is_active}
            onChange={(event) => setDraft((current) => ({ ...current, is_active: event.target.checked }))}
          />
          <div>
            <strong>Active</strong>
            <span>Inactive periods are kept on record but not treated as working hours.</span>
          </div>
        </label>
      </form>
    </Dialog>
  );
}