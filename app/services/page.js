"use client";

import { Suspense, useEffect, useState } from "react";
import Dialog from "../components/Dialog";
import Icon from "../components/Icon";
import PsychologistsTabs from "../components/psychologists/PsychologistsTabs";
import PsychologistShell from "../components/psychologists/PsychologistShell";
import Toast from "../components/Toast";
import useStaffContext from "../components/scheduling/useStaffContext";
import { describeAppointmentError } from "../lib/appointmentsApi";
import { createService, listServices, updateService, validateService } from "../lib/schedulingApi";

/* Service configuration: appointment length and the buffer kept after each appointment. Changes apply to new
   bookings; existing appointments keep the length and buffer they were booked with. */
function ServicesView() {
  const { viewer, notify, toast } = useStaffContext();
  const [services, setServices] = useState([]);
  const [state, setState] = useState({ status: "loading", message: "" });
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState(null); // null | { service? }

  useEffect(() => {
    let cancelled = false;
    listServices()
      .then((rows) => {
        if (cancelled) return;
        setServices(rows);
        setState({ status: "ready", message: "" });
      })
      .catch((error) => {
        console.error("Failed to load services:", error);
        if (!cancelled) setState({ status: "error", message: describeAppointmentError(error, "Could not load services.") });
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  return (
    <PsychologistShell activeId="Psychologists" crumbs={[{ label: "Psychologists", href: "/psychologists" }, { label: "Services" }]}>
      <PsychologistsTabs active="services" />
      <header className="page-head">
        <div>
          <h1>Services</h1>
          <p>Appointment length and buffer time per service. Changes apply to new bookings only.</p>
        </div>
        {viewer.isStaff && (
          <div className="page-actions">
            <button type="button" className="btn btn-primary" onClick={() => setEditing({})}>
              <Icon name="plus" /> Add service
            </button>
          </div>
        )}
      </header>

      <div className="panel">
        {state.status === "loading" && <p className="appt-empty">Loading services…</p>}
        {state.status === "error" && (
          <div className="state" role="alert">
            <Icon name="alert" />
            <strong>Could not load services</strong>
            <span>{state.message}</span>
            <button type="button" className="btn btn-sm" onClick={() => setReload((value) => value + 1)}>
              Try again
            </button>
          </div>
        )}
        {state.status === "ready" && services.length === 0 && (
          <div className="state">
            <strong>No services yet</strong>
            <span>Add a service so appointments can be booked.</span>
          </div>
        )}
        {state.status === "ready" && services.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Service</th>
                  <th scope="col" className="right">
                    Duration
                  </th>
                  <th scope="col" className="right">
                    Buffer after
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col" className="right">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {services.map((service) => (
                  <tr key={service.id}>
                    <td>{service.name}</td>
                    <td className="right num">{service.duration_minutes} min</td>
                    <td className="right num">{service.buffer_minutes} min</td>
                    <td>
                      <span className={`badge ${service.is_active ? "tone-success" : ""}`}>{service.is_active ? "Active" : "Inactive"}</span>
                    </td>
                    <td className="right">
                      {viewer.isStaff && (
                        <button type="button" className="btn btn-sm" onClick={() => setEditing({ service })}>
                          Edit
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <ServiceForm
          service={editing.service}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            notify(message);
            setEditing(null);
            setReload((value) => value + 1);
          }}
        />
      )}
      <Toast toast={toast} />
    </PsychologistShell>
  );
}

function ServiceForm({ service, onClose, onSaved }) {
  const [values, setValues] = useState({
    name: service ? service.name : "",
    duration_minutes: service ? String(service.duration_minutes) : "50",
    buffer_minutes: service ? String(service.buffer_minutes) : "10",
    is_active: service ? service.is_active : true,
  });
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const errors = validateService(values);
  const show = (field) => (submitted ? errors[field] : undefined);
  const set = (field) => (event) =>
    setValues((current) => ({ ...current, [field]: event.target.type === "checkbox" ? event.target.checked : event.target.value }));

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setSubmitted(true);
    if (Object.keys(errors).length) return;
    setBusy(true);
    setError("");
    try {
      if (service) await updateService(service.id, values);
      else await createService(values);
      onSaved(service ? "Service updated" : "Service added");
    } catch (err) {
      setError(err && err.code === "23505" ? "A service with this name already exists." : describeAppointmentError(err, "Could not save the service."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      titleId="service-form-title"
      title={service ? "Edit service" : "Add service"}
      onClose={onClose}
      busy={busy}
      small
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="service-form" className="btn btn-primary" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <form id="service-form" className="modal-body" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="service-name">Name</label>
          <input id="service-name" maxLength={80} value={values.name} aria-invalid={Boolean(show("name"))} onChange={set("name")} />
          {show("name") && <p className="field-error">{errors.name}</p>}
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="service-duration">Duration (minutes)</label>
            <input id="service-duration" type="number" min={10} max={480} step={5} value={values.duration_minutes} aria-invalid={Boolean(show("duration_minutes"))} onChange={set("duration_minutes")} />
            {show("duration_minutes") && <p className="field-error">{errors.duration_minutes}</p>}
          </div>
          <div className="field">
            <label htmlFor="service-buffer">Buffer after (minutes)</label>
            <input id="service-buffer" type="number" min={0} max={120} step={5} value={values.buffer_minutes} aria-invalid={Boolean(show("buffer_minutes"))} onChange={set("buffer_minutes")} />
            {show("buffer_minutes") && <p className="field-error">{errors.buffer_minutes}</p>}
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={values.is_active} onChange={set("is_active")} /> Active (offered when booking)
        </label>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

export default function ServicesPage() {
  return (
    <Suspense fallback={null}>
      <ServicesView />
    </Suspense>
  );
}
