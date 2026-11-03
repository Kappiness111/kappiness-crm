"use client";

import { useEffect, useMemo, useState } from "react";
import Dialog from "../Dialog";
import Icon from "../Icon";
import ReasonDialog from "../ReasonDialog";
import FollowUpRecommendationForm from "../psychologist-dashboard/FollowUpRecommendationForm";
import useAppointmentWorkflow from "../scheduling/useAppointmentWorkflow";
import { describeAppointmentError } from "../../lib/appointmentsApi";
import { formatDate } from "../../lib/leads";
import { closeRecommendation, listRecommendations, recommendationState, updateRecommendation } from "../../lib/sessionsApi";

const VIEWS = [
  { id: "open", label: "Open" },
  { id: "overdue", label: "Overdue" },
  { id: "scheduled", label: "Booked" },
  { id: "closed", label: "Closed" },
  { id: "all", label: "All" },
];

/* Follow-up recommendations. Recommendation status (Open / Booked / Completed / Dismissed) is separate from
   appointment status: a recommendation becomes an appointment only through normal booking.
   Staff: see all, book from a recommendation, close with an outcome. Psychologist: own only, edit while open. */
export default function RecommendationsPanel({ viewer, psychologistId = null, psychologistNames = {}, notify, onOpenClient }) {
  const [rows, setRows] = useState([]);
  const [state, setState] = useState({ status: "loading", message: "" });
  const [view, setView] = useState("open");
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState(null);
  const [closing, setClosing] = useState(null);

  const workflow = useAppointmentWorkflow({ viewer, onChanged: () => setReload((value) => value + 1), notify });
  const ownId = viewer.ownPsychologist ? viewer.ownPsychologist.id : null;

  useEffect(() => {
    let cancelled = false;
    listRecommendations({ psychologistId })
      .then((list) => {
        if (cancelled) return;
        setRows(list);
        setState({ status: "ready", message: "" });
      })
      .catch((error) => {
        console.error("Failed to load recommendations:", error);
        if (!cancelled) setState({ status: "error", message: describeAppointmentError(error, "Could not load recommendations.") });
      });
    return () => {
      cancelled = true;
    };
  }, [psychologistId, reload]);

  const withState = useMemo(() => rows.map((rec) => ({ ...rec, state: recommendationState(rec, new Date()) })), [rows]);
  const counts = {
    open: withState.filter((rec) => rec.status === "Open").length,
    overdue: withState.filter((rec) => rec.state === "overdue").length,
    scheduled: withState.filter((rec) => rec.status === "Scheduled").length,
    closed: withState.filter((rec) => rec.status === "Completed" || rec.status === "Dismissed").length,
    all: withState.length,
  };
  const visible = withState.filter((rec) => {
    if (view === "open") return rec.status === "Open";
    if (view === "overdue") return rec.state === "overdue";
    if (view === "scheduled") return rec.status === "Scheduled";
    if (view === "closed") return rec.status === "Completed" || rec.status === "Dismissed";
    return true;
  });

  const canBook = (rec) => rec.status === "Open" && (viewer.isStaff || (ownId && String(rec.psychologist_id) === String(ownId)));
  const canEdit = (rec) => rec.status === "Open" && ownId && String(rec.psychologist_id) === String(ownId);
  const canClose = (rec) => viewer.isStaff && (rec.status === "Open" || rec.status === "Scheduled");

  return (
    <>
      <section className="kpis" aria-label="Recommendation summary">
        <div className="kpi">
          <span className="kpi-label">Open</span>
          <span className="kpi-value">{counts.open}</span>
          <span className="kpi-meta">Not booked yet</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Overdue</span>
          <span className="kpi-value">{counts.overdue}</span>
          <span className={`kpi-meta ${counts.overdue ? "warn" : ""}`}>Recommended date passed</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Booked</span>
          <span className="kpi-value">{counts.scheduled}</span>
          <span className="kpi-meta">Appointment made</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Closed</span>
          <span className="kpi-value">{counts.closed}</span>
          <span className="kpi-meta">Completed or dismissed</span>
        </div>
      </section>

      <div className="toolbar">
        <div className="range-tabs" role="radiogroup" aria-label="Show">
          {VIEWS.map((item) => (
            <button key={item.id} type="button" role="radio" aria-checked={view === item.id} className={view === item.id ? "is-active" : ""} onClick={() => setView(item.id)}>
              {item.label} <span className="muted num">{counts[item.id]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="panel">
        {state.status === "loading" && <p className="appt-empty">Loading recommendations…</p>}
        {state.status === "error" && (
          <div className="state" role="alert">
            <Icon name="alert" />
            <strong>Could not load recommendations</strong>
            <span>{state.message}</span>
            <button type="button" className="btn btn-sm" onClick={() => setReload((value) => value + 1)}>
              Try again
            </button>
          </div>
        )}
        {state.status === "ready" && visible.length === 0 && (
          <div className="state">
            <Icon name="checkCircle" />
            <strong>Nothing here</strong>
            <span>Psychologists add recommendations after completed sessions.</span>
          </div>
        )}
        {state.status === "ready" && visible.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Recommended for</th>
                  <th scope="col">Client</th>
                  {!psychologistId && <th scope="col">Psychologist</th>}
                  <th scope="col">Recommendation</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="right">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((rec) => (
                  <tr key={rec.id}>
                    <td>
                      {formatDate(rec.recommended_date)}
                      {rec.recommended_time ? <small className="muted"> {String(rec.recommended_time).slice(0, 5)}</small> : null}
                      {rec.priority !== "Normal" && (
                        <>
                          {" "}
                          <span className="badge tone-warning">{rec.priority}</span>
                        </>
                      )}
                    </td>
                    <td>
                      {onOpenClient ? (
                        <button type="button" className="link-btn" onClick={() => onOpenClient(rec.client_id)}>
                          {rec.client_name}
                        </button>
                      ) : (
                        rec.client_name
                      )}
                      {rec.client_phone ? <small className="muted"> · {rec.client_phone}</small> : null}
                    </td>
                    {!psychologistId && <td>{psychologistNames[rec.psychologist_id] || "—"}</td>}
                    <td className="wrap">
                      {rec.recommendation}
                      {rec.outcome ? <small className="muted"> · Outcome: {rec.outcome}</small> : null}
                    </td>
                    <td>
                      <span className={`badge rec-${rec.state}`}>{rec.state === "overdue" ? "Overdue" : rec.status === "Scheduled" ? "Booked" : rec.status}</span>
                    </td>
                    <td className="right">
                      <span className="appt-actions">
                        {canBook(rec) && (
                          <button
                            type="button"
                            className="appt-btn dark"
                            onClick={() => workflow.openBooking({ id: rec.client_id, full_name: rec.client_name, lead_id: rec.lead_id, primary_psychologist_id: rec.psychologist_id }, rec)}
                          >
                            Book
                          </button>
                        )}
                        {canEdit(rec) && (
                          <button type="button" className="appt-btn" onClick={() => setEditing(rec)}>
                            Edit
                          </button>
                        )}
                        {canClose(rec) && (
                          <button type="button" className="appt-btn" onClick={() => setClosing(rec)}>
                            Close…
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <Dialog titleId="rec-edit-title" title="Edit recommendation" subtitle={editing.client_name} onClose={() => setEditing(null)}>
          <div className="modal-body">
            <FollowUpRecommendationForm
              initial={editing}
              onCancel={() => setEditing(null)}
              onSubmit={async (values) => {
                try {
                  await updateRecommendation(editing.id, { recommendation: values.notes, date: values.date, time: values.time, priority: values.priority });
                  notify("Recommendation updated");
                  setEditing(null);
                  setReload((value) => value + 1);
                  return { ok: true };
                } catch (error) {
                  return { ok: false, message: describeAppointmentError(error, "Could not save the recommendation.") };
                }
              }}
            />
          </div>
        </Dialog>
      )}

      {closing && (
        <ReasonDialog
          title="Close recommendation"
          subtitle={`${closing.client_name}, recommended for ${formatDate(closing.recommended_date)}`}
          label="Outcome"
          confirmLabel="Close recommendation"
          choices={[
            { value: "Completed", label: "Follow-up done" },
            { value: "Dismissed", label: "Not needed / declined" },
          ]}
          onClose={() => setClosing(null)}
          onSubmit={async (outcome, status) => {
            try {
              await closeRecommendation(closing.id, status, outcome);
              notify(`Recommendation ${status === "Completed" ? "completed" : "dismissed"}`);
              setReload((value) => value + 1);
              return { ok: true };
            } catch (error) {
              return { ok: false, message: describeAppointmentError(error, "Could not close the recommendation.") };
            }
          }}
        />
      )}

      {workflow.dialogs}
    </>
  );
}
