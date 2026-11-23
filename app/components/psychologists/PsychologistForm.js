"use client";

import { useState } from "react";
import { validatePsychologist } from "../../lib/psychologists";
import Dialog from "./Dialog";

/* Add / edit psychologist profile.
   The login account is NOT an input: auth_user_id must come from the backend account workflow. */
export default function PsychologistForm({ mode, psychologist, onSubmit, onClose }) {
  const editing = mode === "edit";
  const [values, setValues] = useState({
    name: editing ? psychologist.name : "",
    phone: editing ? psychologist.phone : "",
    active: editing ? psychologist.active : true,
  });
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const errors = validatePsychologist(values);
  const showError = (field) => (submitted ? errors[field] : undefined);
  const setField = (field) => (event) => setValues((current) => ({ ...current, [field]: event.target.value }));

  async function handleSubmit(event) {
    event.preventDefault();
    if (saving) return;
    setSubmitted(true);
    setFormError("");
    if (Object.keys(errors).length > 0) return;

    setSaving(true);
    const result = await onSubmit({ name: values.name.trim(), phone: values.phone.trim(), active: values.active });
    setSaving(false);

    if (!result || !result.ok) setFormError((result && result.message) || "Could not save. Please try again.");
  }

  return (
    <Dialog
      titleId="psychologist-form-title"
      title={editing ? "Edit psychologist profile" : "Add psychologist"}
      subtitle={editing ? "Update the profile details." : "Create the psychologist's profile."}
      onClose={onClose}
      busy={saving}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" form="psychologist-form" className="btn btn-primary" disabled={saving}>
            {saving ? "Saving..." : editing ? "Save changes" : "Add psychologist"}
          </button>
        </>
      }
    >
      <form id="psychologist-form" className="modal-body" onSubmit={handleSubmit} noValidate>
        {formError ? <div className="form-alert" role="alert">{formError}</div> : null}

        <div className="field">
          <label htmlFor="psy-name">Full name <span className="required">*</span></label>
          <input
            id="psy-name"
            aria-invalid={Boolean(showError("name"))}
            value={values.name}
            onChange={setField("name")}
            placeholder="Dr. Anita Menon"
            autoComplete="off"
                        autoFocus
          />
          {showError("name") ? <p className="field-error" role="alert">{errors.name}</p> : null}
        </div>

        <div className="field">
          <label htmlFor="psy-phone">Phone number <span className="required">*</span></label>
          <input
            id="psy-phone"
            type="tel"
            aria-invalid={Boolean(showError("phone"))}
            value={values.phone}
            onChange={setField("phone")}
            placeholder="+91 98765 43210"
            autoComplete="off"
                      />
          {showError("phone") ? <p className="field-error" role="alert">{errors.phone}</p> : null}
        </div>

        <div className="form-note">
          <strong>Login account</strong>
          {editing
            ? psychologist.hasLogin
              ? "A login account is linked to this profile. Changing the link is managed by the authentication system, not this form."
              : "No login account is linked to this profile yet."
            : "Sign-in accounts can't be created or linked from this screen yet. This profile will be saved without a sign-in; your administrator can link one later."}
        </div>

        <label className="check-row">
          <input
            type="checkbox"
            checked={values.active}
            onChange={(event) => setValues((current) => ({ ...current, active: event.target.checked }))}
          />
          <div>
            <strong>Account active</strong>
            <span>Inactive psychologists stay on record but are marked as unavailable for work.</span>
          </div>
        </label>
      </form>
    </Dialog>
  );
}