"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Dialog from "../Dialog";
import Icon from "../Icon";
import ReasonDialog from "../ReasonDialog";
import FollowUpDrawer from "./FollowUpDrawer";
import ReminderUpdateDialog from "./ReminderUpdateDialog";
import FollowUpRecommendationForm from "../psychologist-dashboard/FollowUpRecommendationForm";
import useAppointmentWorkflow from "../scheduling/useAppointmentWorkflow";
import { Badge, DeliveryBadge, FollowUpStateBadge, ResponseBadge } from "../ui/StatusBadges";
import { describeAppointmentError, listAppointments } from "../../lib/appointmentsApi";
import { buildFollowUpSessions, followUpCounts } from "../../lib/followUpSessions";
import { formatDate, formatTime } from "../../lib/leads";
import { listReminders } from "../../lib/remindersApi";
import { closeRecommendation, listRecommendations, updateRecommendation } from "../../lib/sessionsApi";

const VIEWS = [
  { id: "action", label: "Needs attention", count: "needsAction" },
  { id: "upcoming", label: "Scheduled", count: "upcoming" },
  { id: "open", label: "Recommended, not booked", count: "open" },
  { id: "done", label: "Completed and closed", count: "done" },
  { id: "all", label: "All", count: "all" },
];

const inView = {
  action: (row) => row.needsAction,
  upcoming: (row) => ["scheduled", "confirmed", "reschedule", "attendance"].includes(row.state),
  open: (row) => row.state === "open" || row.state === "overdue",
  done: (row) => ["completed", "closed", "dismissed", "missed", "cancelled"].includes(row.state),
  all: () => true,
};

function ReminderCell({ reminder }) {
  if (!reminder) return <span className="muted">—</span>;
  return (
    <span className="reminder-cell">
      <DeliveryBadge status={reminder.delivery_status} />
      <ResponseBadge response={reminder.client_response} />
    </span>
  );
}

/* Follow-up sessions: psychologist recommendations, their bookings and the two reminders of each booking.
   viewer: { isStaff, isAdmin, ownPsychologist }. psychologistId limits the list (psychologist workspace).
   Reminders are readable by CRM staff only, so psychologists see sessions without reminder columns. */
export default function FollowUpSessionsPanel({ viewer, psychologistId = null, psychologistNames = {}, notify, onOpenClient, initialFocusId = null }) {
  const [data, setData] = useState({ status: "loading", message: "", recs: [], appts: [], reminders: [] });
  const [reload, setReload] = useState(0);
  const [view, setView] = useState("action");
  const [search, setSearch] = useState("");
  const [psychologistFilter, setPsychologistFilter] = useState("all");
  const [selectedId, setSelectedId] = useState(initialFocusId);
  const [reminderDialog, setReminderDialog] = useState(null); // { reminder, mode }
  const [closing, setClosing] = useState(null);
  const [editing, setEditing] = useState(null);
  const [now, setNow] = useState(() => new Date());

  const showReminders = Boolean(viewer.isStaff);
  const refresh = useCallback(() => setReload((value) => value + 1), []);
  const workflow = useAppointmentWorkflow({ viewer, onChanged: refresh, notify });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [recs, appts] = await Promise.all([
          listRecommendations({ psychologistId }),
          listAppointments({ psychologistId, followUpsOnly: true }),
        ]);
        const reminderResult = showReminders ? await listReminders(appts.map((item) => item.id)) : { rows: [] };
        if (cancelled) return;
        setData({ status: "ready", message: "", recs, appts, reminders: reminderResult.rows });
        setNow(new Date());
      } catch (error) {
        console.error("Failed to load follow-up sessions:", error);
        if (!cancelled) setData((current) => ({ ...current, status: "error", message: describeAppointmentError(error, "Could not load follow-up sessions.") }));
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [psychologistId, reload, showReminders]);

  const rows = useMemo(
    () =>
      buildFollowUpSessions({ recommendations: data.recs, appointments: data.appts, reminders: data.reminders, now }).sort(
        (a, b) => a.when - b.when
      ),
    [data, now]
  );
  const counts = useMemo(() => followUpCounts(rows), [rows]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (!inView[view](row)) return false;
      if (psychologistFilter !== "all" && String(row.psychologistId) !== psychologistFilter) return false;
      if (!term) return true;
      return [row.clientName, row.clientPhone, row.recommendation.recommendation, psychologistNames[row.psychologistId]].some((field) =>
        String(field || "").toLowerCase().includes(term)
      );
    });
  }, [rows, view, search, psychologistFilter, psychologistNames]);

  const selected = selectedId ? rows.find((row) => row.id === selectedId) || null : null;
  const psychologistIds = [...new Set(rows.map((row) => String(row.psychologistId)))];
  const loading = data.status === "loading";

  return (
    <>
      <section className="kpis" aria-label="Follow-up summary">
        <button type="button" className="kpi" onClick={() => setView("action")}>
          <span className="kpi-label">Needs attention</span>
          <span className="kpi-value">{loading ? "…" : counts.needsAction}</span>
          <span className="kpi-meta">Reschedule requests, due reminders, late follow-ups</span>
        </button>
        <button type="button" className="kpi" onClick={() => setView("action")}>
          <span className="kpi-label">Reschedule requests</span>
          <span className="kpi-value">{loading ? "…" : counts.reschedule}</span>
          <span className={`kpi-meta ${counts.reschedule ? "warn" : ""}`}>From reminder responses</span>
        </button>
        {showReminders && (
          <button type="button" className="kpi" onClick={() => setView("action")}>
            <span className="kpi-label">Reminders due</span>
            <span className="kpi-value">{loading ? "…" : counts.remindersDue}</span>
            <span className="kpi-meta">Pending and past their due time</span>
          </button>
        )}
        <button type="button" className="kpi" onClick={() => setView("open")}>
          <span className="kpi-label">Follow-ups recommended</span>
          <span className="kpi-value">{loading ? "…" : counts.open}</span>
          <span className="kpi-meta">Not booked yet</span>
        </button>
        <button type="button" className="kpi" onClick={() => setView("upcoming")}>
          <span className="kpi-label">Follow-ups scheduled</span>
          <span className="kpi-value">{loading ? "…" : counts.upcoming}</span>
          <span className="kpi-meta">Booked, including awaiting confirmation</span>
        </button>
      </section>

      {counts.reschedule > 0 && (
        <div className="notice warn" role="status">
          <Icon name="alert" />
          <div>
            <strong>
              {counts.reschedule} client{counts.reschedule > 1 ? "s want" : " wants"} to reschedule
            </strong>
            {rows
              .filter((row) => row.state === "reschedule")
              .slice(0, 3)
              .map((row, index) => (
                <span key={row.id}>
                  {index ? ", " : ""}
                  <button type="button" className="link-btn" onClick={() => setSelectedId(row.id)}>
                    {row.clientName}
                  </button>
                </span>
              ))}
            {counts.reschedule > 3 ? ` and ${counts.reschedule - 3} more` : ""}
          </div>
        </div>
      )}

      <section className="panel" aria-label="Follow-up sessions">
        <div className="tabs" role="tablist" aria-label="Show">
          {VIEWS.map((item) => (
            <button key={item.id} type="button" role="tab" className="tab" aria-selected={view === item.id} onClick={() => setView(item.id)}>
              {item.label}
              <span className="tab-count">{loading ? "" : counts[item.count]}</span>
            </button>
          ))}
        </div>

        <div className="toolbar">
          <label className="search">
            <Icon name="search" />
            <span className="sr-only">Search follow-up sessions</span>
            <input type="search" placeholder="Search client, phone or recommendation" value={search} onChange={(event) => setSearch(event.target.value)} />
          </label>
          {!psychologistId && psychologistIds.length > 1 && (
            <select value={psychologistFilter} onChange={(event) => setPsychologistFilter(event.target.value)} aria-label="Filter by psychologist">
              <option value="all">All psychologists</option>
              {psychologistIds.map((id) => (
                <option key={id} value={id}>
                  {psychologistNames[id] || "Psychologist"}
                </option>
              ))}
            </select>
          )}
          <span className="spacer" />
          <span className="count">
            {visible.length} of {rows.length}
          </span>
        </div>

        {data.status === "error" && (
          <div className="state" role="alert">
            <Icon name="alert" />
            <strong>Could not load follow-up sessions</strong>
            <span>{data.message}</span>
            <button type="button" className="btn btn-sm" onClick={refresh}>
              Try again
            </button>
          </div>
        )}
        {loading && <p className="appt-empty">Loading follow-up sessions…</p>}
        {data.status === "ready" && visible.length === 0 && (
          <div className="state">
            <Icon name="checkCircle" />
            <strong>{rows.length === 0 ? "No follow-up sessions yet" : "Nothing in this view"}</strong>
            <span>
              {rows.length === 0 ? "Follow-ups are recommended after a completed session." : "Try another tab, search or filter."}
            </span>
          </div>
        )}
        {data.status === "ready" && visible.length > 0 && (
          <div className="table-wrap">
            <table className="table followup-table">
              <thead>
                <tr>
                  <th scope="col">Client</th>
                  {!psychologistId && <th scope="col">Psychologist</th>}
                  <th scope="col">Recommended</th>
                  <th scope="col">Scheduled for</th>
                  {showReminders && <th scope="col">Reminder 1</th>}
                  {showReminders && <th scope="col">Reminder 2</th>}
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr
                    key={row.id}
                    className="clickable"
                    tabIndex={0}
                    onClick={() => setSelectedId(row.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedId(row.id);
                      }
                    }}
                    aria-label={`Open follow-up for ${row.clientName}`}
                  >
                    <td>
                      <strong>{row.clientName}</strong>
                      {row.clientPhone ? <small className="muted block">{row.clientPhone}</small> : null}
                    </td>
                    {!psychologistId && <td>{psychologistNames[row.psychologistId] || "—"}</td>}
                    <td>
                      {formatDate(row.recommendation.recommended_date)}
                      {row.recommendation.recommended_time ? <small className="muted"> {String(row.recommendation.recommended_time).slice(0, 5)}</small> : null}
                      {row.recommendation.priority !== "Normal" && (
                        <span className="block">
                          <Badge tone="warning">{row.recommendation.priority}</Badge>
                        </span>
                      )}
                    </td>
                    <td>
                      {row.current ? (
                        <>
                          {formatDate(row.current.starts_at)}, {formatTime(row.current.starts_at)}
                          {row.previous.some((item) => item.status === "Rescheduled") && <small className="muted block">Rescheduled; old slot released</small>}
                        </>
                      ) : (
                        <span className="muted">Not booked yet</span>
                      )}
                    </td>
                    {showReminders && (
                      <td>
                        <ReminderCell reminder={row.reminder1} />
                      </td>
                    )}
                    {showReminders && (
                      <td>
                        <ReminderCell reminder={row.reminder2} />
                      </td>
                    )}
                    <td>
                      <FollowUpStateBadge state={row.state} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selected && (
        <FollowUpDrawer
          row={selected}
          names={psychologistNames}
          viewer={viewer}
          showReminders={showReminders}
          now={now}
          workflow={workflow}
          reloadKey={reload}
          onClose={() => setSelectedId(null)}
          onRecordReminder={(reminder, mode) => setReminderDialog({ reminder, mode, clientName: selected.clientName })}
          onCloseRecommendation={setClosing}
          onEditRecommendation={setEditing}
          onOpenClient={onOpenClient}
        />
      )}

      {reminderDialog && (
        <ReminderUpdateDialog
          reminder={reminderDialog.reminder}
          mode={reminderDialog.mode}
          clientName={reminderDialog.clientName}
          onClose={() => setReminderDialog(null)}
          onSaved={(saved, value) => {
            setReminderDialog(null);
            notify(
              reminderDialog.mode === "delivery"
                ? `Reminder ${saved.reminder_number} marked ${value}`
                : `Reminder ${saved.reminder_number}: client response "${value}" recorded`
            );
            refresh();
          }}
        />
      )}

      {closing && (
        <ReasonDialog
          title="Close follow-up"
          subtitle={`Recommended for ${formatDate(closing.recommended_date)}`}
          label="Outcome"
          confirmLabel="Close follow-up"
          choices={[
            { value: "Completed", label: "Follow-up done" },
            { value: "Dismissed", label: "Not needed / declined" },
          ]}
          onClose={() => setClosing(null)}
          onSubmit={async (outcome, status) => {
            try {
              await closeRecommendation(closing.id, status, outcome);
              notify(status === "Completed" ? "Follow-up closed as done" : "Follow-up dismissed");
              refresh();
              return { ok: true };
            } catch (error) {
              return { ok: false, message: describeAppointmentError(error, "Could not close the follow-up.") };
            }
          }}
        />
      )}

      {editing && (
        <Dialog titleId="rec-edit-title" title="Edit recommendation" onClose={() => setEditing(null)}>
          <div className="modal-body">
            <FollowUpRecommendationForm
              initial={editing}
              onCancel={() => setEditing(null)}
              onSubmit={async (values) => {
                try {
                  await updateRecommendation(editing.id, { recommendation: values.notes, date: values.date, time: values.time, priority: values.priority });
                  notify("Recommendation updated");
                  setEditing(null);
                  refresh();
                  return { ok: true };
                } catch (error) {
                  return { ok: false, message: describeAppointmentError(error, "Could not save the recommendation.") };
                }
              }}
            />
          </div>
        </Dialog>
      )}

      {workflow.dialogs}
    </>
  );
}
