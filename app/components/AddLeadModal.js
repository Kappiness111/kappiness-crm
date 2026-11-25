"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fieldProps } from "./Field";
import Icon from "./Icon";
import ModalShell from "./ModalShell";
import { normalizePhone } from "../lib/phone";
import { clientIdLabel } from "../lib/clientsApi";
import {
  DEFAULT_STATUS,
  NOTES_LIMIT,
  CONTACT_METHODS,
  SERVICES,
  SOURCES,
  formatDate,
  nextLeadCode,
  parseDate,
  phoneDigits,
  quickFollowUpValue,
  toInputValue,
} from "../lib/leads";

function Box({ id, label, required = false, error, hint, className = "", children }) {
  return (
    <div className={`fwrap ${className}`}>
      <div className="fbox">
        <label htmlFor={id}>
          {label}
          {required && <span className="required"> *</span>}
        </label>
        {children}
      </div>
      {error ? (
        <p className="field-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

// Assigned staff starts as the signed-in account's name.
function makeInitialValues(staffName = "") {
  return {
    full_name: "",
    phone: "",
    email: "",
    source: "",
    contact_method: "",
    service_interest: "Individual counselling",
    notes: "",
    assigned_staff: staffName,
    next_follow_up_at: "",
  };
}

const FIELD_ORDER = [
  "full_name",
  "phone",
  "email",
  "source",
  "contact_method",
  "notes",
  "next_follow_up_at",
];

function validate(values, leads) {
  const errors = {};
  const name = values.full_name.trim();
  const digits = phoneDigits(values.phone);

  if (!SOURCES.includes(values.source)) errors.source = "Choose a lead source.";
  if (values.source && !CONTACT_METHODS.includes(values.contact_method)) {
    errors.contact_method = "Choose a contact method.";
  }

  if (!name) errors.full_name = "Enter the lead's full name.";
  else if (name.length < 2) errors.full_name = "That name looks too short.";

  if (!digits) {
    errors.phone = "Enter a phone number.";
  } else if (digits.length < 10 || digits.length > 13) {
    errors.phone = "Enter a valid number: 10 digits, with or without +91.";
  } else if (!normalizePhone(values.phone)) {
    errors.phone = "Enter a valid number: 10 digits, or + and the country code.";
  } else {
    // Day 24: compare normalised numbers (formatting and +91 do not matter; another country code is another number).
    // Only a still-open enquiry blocks a new one. A returning client or an earlier closed enquiry may enquire again:
    // that is shown as a notice, and the new enquiry is linked to the existing client from the lead drawer.
    const duplicate = openLeadWithPhone(values.phone, leads);
    if (duplicate) errors.phone = `Already saved for ${duplicate.full_name} (${duplicate.lead_code}), which is still open. Update that lead instead.`;
  }

  const email = values.email.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = "Enter a valid email, like name@example.com.";
  }

  if (values.notes.length > NOTES_LIMIT) {
    errors.notes = `Keep notes under ${NOTES_LIMIT} characters.`;
  }

  if (values.next_follow_up_at) {
    const date = parseDate(values.next_follow_up_at);
    if (!date) errors.next_follow_up_at = "Enter a valid date and time.";
    else if (date.getTime() < Date.now() - 60000) errors.next_follow_up_at = "Pick a time in the future.";
  }

  return errors;
}

const CLOSED_OR_CONVERTED = ["Confirmed", "Not Interested", "Lost Lead"];

function openLeadWithPhone(phone, leads) {
  const wanted = normalizePhone(phone);
  return wanted ? leads.find((lead) => !CLOSED_OR_CONVERTED.includes(lead.status) && normalizePhone(lead.phone) === wanted) : null;
}

// Existing clients and earlier (closed or converted) enquiries with the same number: shown, never blocking.
function phoneNotice(phone, leads, clients) {
  const wanted = normalizePhone(phone);
  if (!wanted) return null;
  const matching = clients.filter((item) => (item.phone_normalized || normalizePhone(item.phone)) === wanted);
  const earlier = leads.filter((lead) => CLOSED_OR_CONVERTED.includes(lead.status) && normalizePhone(lead.phone) === wanted);
  if (matching.length === 0 && earlier.length === 0) return null;
  return { clients: matching, earlier };
}

export default function AddLeadModal({
  leads,
  clients = [],
  staffOptions = [],
  currentStaffName = "",
  onClose,
  onCreate,
  createError = "",
}) {
  const initialValues = useMemo(() => makeInitialValues(currentStaffName), [currentStaffName]);
  const [values, setValues] = useState(initialValues);
  const [touched, setTouched] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const nameRef = useRef(null);

  // If the account name arrives after the form opened, fill it in (only while the field is still empty).
  useEffect(() => {
    if (!currentStaffName) return;
    // Intentional one-way sync from a prop that can arrive after mount; it only fills an empty field.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setValues((current) => (current.assigned_staff ? current : { ...current, assigned_staff: currentStaffName }));
  }, [currentStaffName]);

  const errors = useMemo(() => validate(values, leads), [values, leads]);
  const existingNotice = useMemo(
    () => (errors.phone ? null : phoneNotice(values.phone, leads, clients)),
    [errors.phone, values.phone, leads, clients]
  );
  const errorCount = Object.keys(errors).length;
  const isDirty = JSON.stringify(values) !== JSON.stringify(initialValues);

  const setField = (field, value) => setValues((current) => ({ ...current, [field]: value }));
  const onChange = (field) => (event) => setField(field, event.target.value);
  const onSourceChange = (event) => {
    const source = event.target.value;
    setValues((current) => ({ ...current, source, contact_method: "" }));
  };
  const onBlur = (field) => () => setTouched((current) => ({ ...current, [field]: true }));
  const visibleError = (field) => (touched[field] || submitted ? errors[field] : undefined);
  // Optional fields are shown or hidden only by the toggle. Values stay in state while hidden,
  // and a failed save re-opens the section if one of its fields has an error to fix.
  const moreOpen = showMore;

  function requestClose() {
    if (isSaving) return;
    if (isDirty && !window.confirm("Discard this lead? What you have entered will be lost.")) return;
    onClose();
  }

  async function submit(addAnother) {
    if (isSaving) return;
    setSubmitted(true);

    if (errorCount > 0) {
      const first = FIELD_ORDER.find((field) => errors[field]);
      const focusFirst = () => first && document.getElementById(`add-${first}`)?.focus();
      if (errors.email && !showMore) {
        // The email field is unmounted while collapsed: open the section, then focus once it renders.
        setShowMore(true);
        requestAnimationFrame(focusFirst);
      } else {
        focusFirst();
      }
      return;
    }

    setIsSaving(true);
    try {
      const created = await onCreate(
        {
          ...values,
          full_name: values.full_name.trim(),
          phone: values.phone.trim(),
          email: values.email.trim(),
          notes: values.notes.trim(),
          assigned_staff: values.assigned_staff.trim(),
        },
        { addAnother }
      );

      if (created === false) return;

      if (addAnother) {
        setValues(initialValues);
        setTouched({});
        setSubmitted(false);
        nameRef.current?.focus();
      }
    } finally {
      setIsSaving(false);
    }
  }

  const props = (field, hint) => fieldProps(`add-${field}`, visibleError(field), hint);
  const leadCode = nextLeadCode(leads);

  return (
    <ModalShell labelledBy="add-lead-title" onRequestClose={requestClose} className="add-lead" size="lg">
      <button type="button" className="icon-btn al-close" onClick={requestClose} aria-label="Close form">
        <Icon name="close" />
      </button>

      <div className="al-head">
        <div className="al-title">
          <h2 id="add-lead-title">Add Lead</h2>
          <p>Name, mobile number and where the lead came from are required (marked *). Everything else can be added now or later.</p>
        </div>

        <dl className="al-meta">
          <div>
            <dt>Lead ID</dt>
            <dd>{leadCode}</dd>
          </div>
          <div>
            <dt>Created date</dt>
            <dd>{formatDate(new Date().toISOString())}</dd>
          </div>
          <div>
            <dt>Created by</dt>
            <dd>{currentStaffName || "CRM Admin"}</dd>
          </div>
        </dl>
      </div>

      <form
        className="lead-form al-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
      >
        <div className="al-body">
          <div className="al-col">
            <Box id="add-full_name" label="Full name" required error={visibleError("full_name")}>
              <input
                {...props("full_name")}
                ref={nameRef}
                autoFocus
                autoComplete="off"
                value={values.full_name}
                onChange={onChange("full_name")}
                onBlur={onBlur("full_name")}
              />
            </Box>

            <Box
              id="add-phone"
              label="Mobile number"
              required
              error={visibleError("phone")}
              hint="Include the country code if outside India."
            >
              <input
                {...props("phone", "Include the country code if outside India.")}
                type="tel"
                inputMode="tel"
                autoComplete="off"
                value={values.phone}
                onChange={onChange("phone")}
                onBlur={onBlur("phone")}
                placeholder="+91 98765 43210"
              />
            </Box>
            {existingNotice && (
              <div className="notice warn" role="status">
                <Icon name="info" />
                <div>
                  <strong>
                    {existingNotice.clients.length
                      ? `${existingNotice.clients.length === 1 ? "1 existing client has" : `${existingNotice.clients.length} existing clients have`} this number`
                      : "This number has enquired before"}
                  </strong>
                  {existingNotice.clients.length > 0 && (
                    <ul style={{ margin: "4px 0", paddingLeft: 18 }}>
                      {existingNotice.clients.map((item) => (
                        <li key={item.id}>
                          {item.full_name} <span className="client-id">{clientIdLabel(item.id)}</span>
                          {item.is_active === false ? " (inactive)" : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                  {existingNotice.earlier.length > 0 &&
                    `Earlier enquiries: ${existingNotice.earlier.map((lead) => `${lead.lead_code} (${lead.status})`).join(", ")}. `}
                  {existingNotice.clients.length
                    ? "You can still save this enquiry. If it is from one of these clients, link it to them from the lead drawer; if it is someone else (for example a family member), it can become a separate client."
                    : "You can still save this new enquiry."}
                </div>
              </div>
            )}

            <Box id="add-source" label="Lead source" required>
              <div className="dependent-selects">
                <select
                  {...props("source")}
                  className={values.source ? "" : "is-placeholder"}
                  value={values.source}
                  onChange={onSourceChange}
                  onBlur={onBlur("source")}
                  required
                >
                  <option className="is-placeholder" value="" disabled>Select lead source</option>
                  {SOURCES.map((source) => (
                    <option key={source} value={source}>{source}</option>
                  ))}
                </select>
                {visibleError("source") && (
                  <p className="field-error" id="add-source-error" role="alert">
                    {visibleError("source")}
                  </p>
                )}
                {values.source && (
                  <select
                    {...props("contact_method")}
                    aria-label="Contact method"
                    className={values.contact_method ? "" : "is-placeholder"}
                    value={values.contact_method}
                    onChange={onChange("contact_method")}
                    onBlur={onBlur("contact_method")}
                    required
                  >
                    <option className="is-placeholder" value="" disabled>Select contact method</option>
                    {CONTACT_METHODS.map((method) => (
                      <option key={method} value={method}>{method}</option>
                    ))}
                  </select>
                )}
                {values.source && visibleError("contact_method") && (
                  <p className="field-error" id="add-contact_method-error" role="alert">
                    {visibleError("contact_method")}
                  </p>
                )}
              </div>
            </Box>

          </div>

          <div className="al-col">
            <fieldset className="al-panel">
              <legend>Assignment and follow up</legend>

              <Box id="add-next_follow_up_at" label="Next follow up" error={visibleError("next_follow_up_at")}>
                <input
                  {...props("next_follow_up_at")}
                  type="datetime-local"
                  min={toInputValue(new Date())}
                  value={values.next_follow_up_at}
                  onChange={onChange("next_follow_up_at")}
                  onBlur={onBlur("next_follow_up_at")}
                />
              </Box>

              <div className="al-quick">
                {[
                  ["Tomorrow", 1],
                  ["In 3 days", 3],
                  ["Next week", 7],
                ].map(([label, days]) => (
                  <button
                    type="button"
                    key={label}
                    onClick={() => setField("next_follow_up_at", quickFollowUpValue(days))}
                  >
                    {label}
                  </button>
                ))}
                {values.next_follow_up_at && (
                  <button type="button" className="clear" onClick={() => setField("next_follow_up_at", "")}>
                    Clear
                  </button>
                )}
              </div>
            </fieldset>

            <Box
              id="add-notes"
              label="Enquiry notes"
              error={visibleError("notes")}
              hint={
                <>
                  Practical details only. Avoid sensitive clinical information.
                  <span className="char-count">
                    {values.notes.length}/{NOTES_LIMIT}
                  </span>
                </>
              }
            >
              <textarea
                {...props("notes", "notes")}
                rows={4}
                value={values.notes}
                onChange={onChange("notes")}
                onBlur={onBlur("notes")}
              />
            </Box>

            <div className="al-more">
              <button
                type="button"
                className="link-btn"
                aria-expanded={moreOpen}
                aria-controls="add-more-fields"
                onClick={() => setShowMore((open) => !open)}
              >
                <Icon name={moreOpen ? "chevronDown" : "chevronRight"} />
                {moreOpen ? "Hide optional details" : "Show optional details"}
              </button>
              {moreOpen && (
                <div id="add-more-fields" className="al-more-fields">
                <Box id="add-email" label="Email ID" error={visibleError("email")}>
                  <input
                    {...props("email")}
                    type="email"
                    autoComplete="off"
                    value={values.email}
                    onChange={onChange("email")}
                    onBlur={onBlur("email")}
                  />
                </Box>

                <Box id="add-service_interest" label="Service of interest">
                  <select {...props("service_interest")} value={values.service_interest} onChange={onChange("service_interest")}>
                    {SERVICES.map((service) => (
                      <option key={service}>{service}</option>
                    ))}
                  </select>
                </Box>

                <Box id="add-assigned_staff" label="Assigned staff">
                  <input
                    {...props("assigned_staff")}
                    list="add-staff-options"
                    autoComplete="off"
                    value={values.assigned_staff}
                    onChange={onChange("assigned_staff")}
                    placeholder="Select or type a name"
                  />
                  <datalist id="add-staff-options">
                    {staffOptions.map((name) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
                </Box>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="al-footer">
          {submitted && errorCount > 0 ? (
            <span className="footer-meta footer-error" role="alert">
              Please fix {errorCount} field{errorCount > 1 ? "s" : ""} to continue.
            </span>
          ) : createError ? (
            <span className="footer-meta footer-error" role="alert">
              {createError}
            </span>
          ) : isSaving ? (
            <span className="footer-meta" role="status">Saving lead...</span>
          ) : (
            <span className="footer-meta">New leads start as {DEFAULT_STATUS}. Next step: call them and update the status.</span>
          )}
          <button type="button" className="secondary-button" onClick={requestClose} disabled={isSaving}>
            Cancel
          </button>
          <button type="button" className="secondary-button" onClick={() => void submit(true)} disabled={isSaving}>
            Save &amp; add another
          </button>
          <button type="submit" className="primary-button" disabled={isSaving}>
            {isSaving ? "Saving..." : "Save lead"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}