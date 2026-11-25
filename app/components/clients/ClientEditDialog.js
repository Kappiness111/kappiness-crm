"use client";

import { useState } from "react";
import Dialog from "../Dialog";
import Field from "../Field";
import { SERVICES, SOURCES } from "../../lib/leads";
import { describeAppointmentError } from "../../lib/appointmentsApi";
import { clientIdLabel, findPhoneMatches, updateClientDetails } from "../../lib/clientsApi";
import { normalizePhone } from "../../lib/phone";

const FIELDS = [
  { id: "full_name", label: "Full name", required: true },
  { id: "phone", label: "Phone", required: true, hint: "Include + and the country code for numbers outside India." },
  { id: "email", label: "Email", type: "email" },
  { id: "city", label: "City" },
  { id: "preferred_language", label: "Preferred language" },
  { id: "preferred_contact", label: "Preferred contact", options: ["WhatsApp", "Call", "Email", "Other"] },
  { id: "best_time", label: "Best time to contact" },
  { id: "service_interest", label: "Service interest", options: SERVICES },
  { id: "referral_source", label: "Referral source", options: SOURCES, free: true, hint: "How the client first came to the clinic. Correct it only if it was recorded wrongly." },
];

function validate(values) {
  const errors = {};
  if (values.full_name.trim().length < 2) errors.full_name = "Enter the client's full name.";
  if (!normalizePhone(values.phone)) errors.phone = "Enter a valid phone number: 10 digits, or + and the country code.";
  if (values.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) errors.email = "Enter a valid email, like name@example.com.";
  if (values.referral_source.trim().length > 80) errors.referral_source = "Keep the referral source under 80 characters.";
  return errors;
}

/* Staff edit a client's personal and contact details (update_client_details: validated and audited by the database).
   A new phone number that other clients already use is allowed (family members may share one): the dialog lists
   those clients first and saves only after staff confirm. */
export default function ClientEditDialog({ client, onClose, onSaved, onOpenClient }) {
  const [values, setValues] = useState(() => Object.fromEntries(FIELDS.map((field) => [field.id, client[field.id] || ""])));
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sharedWith, setSharedWith] = useState(null); // null = not checked yet; [] or the other clients with this number
  const [checkedPhone, setCheckedPhone] = useState("");
  const errors = validate(values);
  const visible = (id) => (submitted ? errors[id] : undefined);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setSubmitted(true);
    if (Object.keys(errors).length) return;
    const changes = {};
    FIELDS.forEach((field) => {
      if ((values[field.id] || "").trim() !== (client[field.id] || "").trim()) changes[field.id] = values[field.id];
    });
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setError("");
    try {
      // A changed phone number: show the other clients that use it, once, before saving (a warning, not a block).
      if ("phone" in changes && checkedPhone !== normalizePhone(values.phone)) {
        let others = [];
        try {
          others = (await findPhoneMatches(values.phone)).clients.filter((item) => String(item.id) !== String(client.id));
        } catch (lookupError) {
          console.error("Phone lookup failed:", lookupError);
        }
        setCheckedPhone(normalizePhone(values.phone));
        setSharedWith(others);
        if (others.length) return;
      }
      const saved = await updateClientDetails(client.id, changes, client.updated_at || null);
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(describeAppointmentError(err, "Could not save the client's details. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      titleId="client-edit-title"
      title="Edit client details"
      subtitle={`${client.full_name} · ${clientIdLabel(client.id)}. Changes are recorded with your name.`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="client-edit-form" className="btn btn-primary" disabled={busy}>
            {busy ? "Saving…" : sharedWith && sharedWith.length && checkedPhone === normalizePhone(values.phone) ? "Save anyway" : "Save changes"}
          </button>
        </>
      }
    >
      <form id="client-edit-form" className="modal-body" noValidate onSubmit={submit}>
        <div className="field-grid">
          {FIELDS.map((field) => {
            const id = `client-edit-${field.id}`;
            const choices = field.options ? [...new Set([...(field.options || []), values[field.id]].filter(Boolean))] : null;
            return (
              <Field key={field.id} id={id} label={field.label} required={field.required} error={visible(field.id)} hint={field.hint}>
                {choices && !field.free ? (
                  <select id={id} value={values[field.id]} onChange={(event) => setValues({ ...values, [field.id]: event.target.value })}>
                    <option value="">Not set</option>
                    {choices.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                ) : (
                  <>
                    <input
                      id={id}
                      type={field.type || "text"}
                      value={values[field.id]}
                      maxLength={field.id === "referral_source" ? 80 : 200}
                      list={choices ? `${id}-list` : undefined}
                      aria-invalid={visible(field.id) ? "true" : undefined}
                      onChange={(event) => setValues({ ...values, [field.id]: event.target.value })}
                    />
                    {choices && (
                      <datalist id={`${id}-list`}>
                        {choices.map((item) => (
                          <option key={item} value={item} />
                        ))}
                      </datalist>
                    )}
                  </>
                )}
              </Field>
            );
          })}
        </div>
        {sharedWith && sharedWith.length > 0 && checkedPhone === normalizePhone(values.phone) && (
          <div className="notice warn" role="status" style={{ marginTop: 12 }}>
            <div className="match-card">
              <strong>
                {sharedWith.length === 1 ? "1 other client uses" : `${sharedWith.length} other clients use`} this phone number
              </strong>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {sharedWith.map((item) => (
                  <li key={item.id}>
                    {item.full_name} <span className="client-id">{clientIdLabel(item.id)}</span>
                    {onOpenClient ? (
                      <>
                        {" "}
                        <button type="button" className="btn btn-sm" onClick={() => onOpenClient(item.id)}>
                          Open
                        </button>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
              <span>Shared numbers are allowed (for example family members). Press Save anyway to keep it; nothing is linked or merged.</span>
            </div>
          </div>
        )}
        {error && (
          <div className="notice warn" role="alert" style={{ marginTop: 12 }}>
            <div>
              <strong>{error}</strong>
            </div>
          </div>
        )}
      </form>
    </Dialog>
  );
}
