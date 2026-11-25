"use client";

import { useMemo, useState } from "react";
import Icon from "../Icon";
import FollowUpFilters, { EMPTY_FOLLOW_UP_FILTERS } from "./FollowUpFilters";
import { CommunicationBadge, DueDate, FollowUpStatusCell, FollowUpTypeBadge } from "./FollowUpBadges";
import useFollowUpRecords from "./useFollowUpRecords";
import styles from "./followups.module.css";
import { isAwaitingConfirmation, isClosedFollowUp, sortFollowUps, wantsReschedule } from "../../lib/followUpsApi";
import { formatDate, formatTime } from "../../lib/leads";

// Quick filters behind the counts line. Each one is a plain question about the row.
const QUICK = [
  { id: "overdue", label: "overdue", tone: "danger", test: (row) => row.due_state === "Overdue" },
  { id: "today", label: "due today", tone: "warning", test: (row) => row.due_state === "Due Today" },
  { id: "reschedule", label: "want to reschedule", tone: "warning", test: wantsReschedule },
  { id: "awaiting", label: "awaiting confirmation", tone: "", test: isAwaitingConfirmation },
  { id: "tentative", label: "tentative", tone: "", test: (row) => row.status === "Tentative" },
  { id: "contact", label: "contact needed", tone: "", test: (row) => row.status === "Contact Needed" },
];

/* Follow-ups (Type A = next session, Type B = contact client) from follow_ups_with_status.
   Due Today and Overdue come from due_state (clinic time). Overdue and "wants to reschedule" rows stand out.
   viewer: { isStaff }. psychologistId fixes the list to one psychologist (psychologist workspace, read-only).
   initialFocusId opens a follow-up (its id, or the id of the recommendation it came from). */
export default function FollowUpsList({ viewer, psychologistId = null, psychologistNames = {}, notify, onOpenClient, initialFocusId = null }) {
  const [filters, setFilters] = useState({ ...EMPTY_FOLLOW_UP_FILTERS });
  const [search, setSearch] = useState("");
  const [quick, setQuick] = useState("");
  const serverFilters = useMemo(
    () => ({
      psychologistId: psychologistId || filters.psychologistId || null,
      status: filters.status || null,
      type: filters.type || null,
      dateFrom: filters.dateFrom || null,
      dateTo: filters.dateTo || null,
    }),
    [psychologistId, filters]
  );
  const records = useFollowUpRecords({ filters: serverFilters, viewer, psychologistNames, notify, onOpenClient });
  const { state, loading, open } = records;
  const showPsychologist = !psychologistId;

  const sorted = useMemo(() => sortFollowUps(records.rows), [records.rows]);
  const searched = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return sorted;
    return sorted.filter((row) => String(row.client_name || "").toLowerCase().includes(term));
  }, [sorted, search]);
  const counts = useMemo(() => Object.fromEntries(QUICK.map((item) => [item.id, searched.filter(item.test).length])), [searched]);
  const quickItem = QUICK.find((item) => item.id === quick);
  const rows = quickItem ? searched.filter(quickItem.test) : searched;

  // Open the follow-up a link points at, once the list has loaded.
  const [focusDone, setFocusDone] = useState(!initialFocusId);
  if (!focusDone && state.status === "ready" && !loading) {
    const match = records.rows.find((row) => row.id === initialFocusId || row.recommendation_id === initialFocusId);
    setFocusDone(true);
    if (match) open(match.id);
  }

  const shownCounts = QUICK.filter((item) => counts[item.id] > 0);

  return (
    <section className="panel" aria-label="Follow-ups">
      <FollowUpFilters
        value={filters}
        onChange={setFilters}
        psychologistNames={psychologistNames}
        show={{ psychologist: showPsychologist }}
        count={loading ? "" : `${rows.length} of ${records.rows.length}`}
        idPrefix="fu-list"
        search={
          <label className={`search ${styles.search}`}>
            <Icon name="search" />
            <span className="sr-only">Search by client</span>
            <input type="search" placeholder="Search client" value={search} onChange={(event) => setSearch(event.target.value)} />
          </label>
        }
      />

      <div style={{ padding: "10px 14px 0" }}>
        {!loading && state.status === "ready" && (
          <p className={styles.countsLine} aria-label="Counts. Choose one to filter the table.">
            {shownCounts.length === 0 ? (
              <span>Nothing overdue, due today or waiting for an answer.</span>
            ) : (
              shownCounts.map((item, index) => (
                <span key={item.id} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {index > 0 && (
                    <span className={styles.sep} aria-hidden="true">
                      ·
                    </span>
                  )}
                  <button
                    type="button"
                    className={`${styles.countBtn} ${item.tone === "danger" ? styles.countDanger : item.tone === "warning" ? styles.countWarning : ""}`}
                    aria-pressed={quick === item.id}
                    onClick={() => setQuick(quick === item.id ? "" : item.id)}
                  >
                    <strong>{counts[item.id]}</strong> {item.label}
                  </button>
                </span>
              ))
            )}
            {quick && (
              <button type="button" className="link-btn" onClick={() => setQuick("")}>
                Show all
              </button>
            )}
          </p>
        )}
      </div>

      {state.status === "error" && (
        <div className="state" role="alert">
          <Icon name="alert" />
          <strong>Could not load follow-ups</strong>
          <span>{state.message}</span>
          <button type="button" className="btn btn-sm" onClick={records.refresh}>
            Try again
          </button>
        </div>
      )}
      {loading && state.status !== "error" && <p className="appt-empty">Loading follow-ups…</p>}
      {!loading && state.status === "ready" && rows.length === 0 && (
        <div className="state">
          <Icon name="checkCircle" />
          <strong>{records.rows.length === 0 ? "No follow-ups yet" : "No follow-ups match"}</strong>
          <span>
            {records.rows.length === 0
              ? "Follow-ups appear here once a next session or a client contact is planned."
              : "Try another filter or search, or choose Clear filters."}
          </span>
        </div>
      )}
      {!loading && state.status === "ready" && rows.length > 0 && (
        <div className="table-wrap">
          <table className="table followup-table">
            <thead>
              <tr>
                <th scope="col">Client</th>
                <th scope="col">Type</th>
                {showPsychologist && <th scope="col">Psychologist</th>}
                <th scope="col">Due date</th>
                <th scope="col">Status</th>
                <th scope="col">Communication</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const overdue = row.due_state === "Overdue" && !isClosedFollowUp(row);
                const reschedule = wantsReschedule(row);
                return (
                  <tr
                    key={row.id}
                    className={`clickable ${overdue ? styles.rowOverdue : reschedule ? styles.rowReschedule : ""}`}
                    tabIndex={0}
                    onClick={() => open(row.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        open(row.id);
                      }
                    }}
                    aria-label={`Open follow-up for ${row.client_name || "client"}`}
                  >
                    <td>
                      <strong>{row.client_name || "Client"}</strong>
                      {row.session_number ? <small className="muted block">Session {row.session_number}</small> : null}
                    </td>
                    <td>
                      <FollowUpTypeBadge type={row.follow_up_type} />
                    </td>
                    {showPsychologist && <td>{psychologistNames[row.psychologist_id] || "—"}</td>}
                    <td>
                      {row.proposed_starts_at ? (
                        <span className={`due ${overdue ? "overdue" : row.due_state === "Due Today" ? "today" : ""}`}>
                          {formatDate(row.proposed_starts_at)}, {formatTime(row.proposed_starts_at)}
                        </span>
                      ) : (
                        <>
                          <DueDate row={row} />
                          <small className="muted block">Time not set</small>
                        </>
                      )}
                    </td>
                    <td>
                      <FollowUpStatusCell row={row} />
                    </td>
                    <td>
                      <CommunicationBadge status={row.communication_status} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {records.drawer}
    </section>
  );
}
