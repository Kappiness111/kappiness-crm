"use client";

import { useEffect, useState } from "react";
import { describeAppointmentError } from "../../lib/appointmentsApi";
import { formatDate } from "../../lib/leads";
import { todayInputValue } from "../../lib/followUpsApi";
import { getSessionFollowUpDecision, saveSessionFollowUpDecision } from "../../lib/sessionFollowUpApi";
import styles from "./checklist.module.css";

export default function SessionFollowUpDecision({ sessionId, notify, onSaved, canEdit = true }) {
  const [state, setState] = useState({ status: "loading", error: "", saved: null });
  const [required, setRequired] = useState("");
  const [purpose, setPurpose] = useState("");
  const [date, setDate] = useState("");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const saved = await getSessionFollowUpDecision(sessionId);
        if (cancelled) return;
        if (saved) {
          setRequired(saved.follow_up_required ? "yes" : "no");
          setPurpose(saved.follow_up_purpose || "");
          setDate(saved.follow_up_date || "");
          setDetails(saved.follow_up_details || "");
        }
        setState({ status: "ready", error: "", saved });
      } catch (error) {
        if (!cancelled) {
          setState({
            status: "error",
            error: describeAppointmentError(error, "Could not load the follow-up decision."),
            saved: null,
          });
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  async function save(event) {
    event.preventDefault();
    if (!canEdit || busy || (required !== "yes" && required !== "no")) return;
    setBusy(true);
    setState((current) => ({ ...current, error: "" }));
    try {
      const saved = await saveSessionFollowUpDecision(sessionId, {
        followUpRequired: required === "yes",
        purpose,
        date,
        details,
      });
      setState({ status: "ready", error: "", saved });
      if (onSaved) onSaved(saved);
      if (notify) notify("Follow-up decision saved.");
    } catch (error) {
      setState((current) => ({
        ...current,
        error: describeAppointmentError(error, "Could not save the follow-up decision."),
      }));
    } finally {
      setBusy(false);
    }
  }

  if (state.status === "loading") return <p className="subtle-text">Loading follow-up decision…</p>;
  if (state.status === "error") return <p className="field-error" role="alert">{state.error}</p>;

  return (
    <form className={styles.sessionFollowUpForm} onSubmit={save}>
      <fieldset disabled={!canEdit || busy}>
        <legend>Follow-up decision</legend>
        <div className={styles.sessionFollowUpChoices} role="radiogroup" aria-label="Follow-up required">
          <label>
            <input type="radio" name={`follow-up-${sessionId}`} value="yes" checked={required === "yes"} onChange={() => setRequired("yes")} />
            Yes
          </label>
          <label>
            <input
              type="radio"
              name={`follow-up-${sessionId}`}
              value="no"
              checked={required === "no"}
              onChange={() => {
                setRequired("no");
                setPurpose("");
                setDate("");
                setDetails("");
              }}
            />
            No
          </label>
        </div>
        {required === "yes" && (
          <div className={styles.sessionFollowUpFields}>
            <div className="field">
              <label htmlFor={`follow-up-purpose-${sessionId}`}>Purpose</label>
              <input
                id={`follow-up-purpose-${sessionId}`}
                value={purpose}
                onChange={(event) => setPurpose(event.target.value)}
                maxLength={120}
                required
              />
            </div>
            <div className="field">
              <label htmlFor={`follow-up-date-${sessionId}`}>Follow-up date</label>
              <input
                id={`follow-up-date-${sessionId}`}
                type="date"
                min={todayInputValue()}
                value={date}
                onChange={(event) => setDate(event.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor={`follow-up-details-${sessionId}`}>Relevant details (optional)</label>
              <textarea
                id={`follow-up-details-${sessionId}`}
                rows={2}
                value={details}
                onChange={(event) => setDetails(event.target.value)}
                maxLength={1000}
              />
            </div>
          </div>
        )}
      </fieldset>
      {state.saved && (
        <p className="subtle-text" role="status">
          Saved: follow-up {state.saved.follow_up_required ? "required" : "not required"}
          {state.saved.follow_up_required ? ` · ${state.saved.follow_up_purpose} · ${formatDate(state.saved.follow_up_date)}` : ""}.
        </p>
      )}
      {state.error && <p className="field-error" role="alert">{state.error}</p>}
      {canEdit && (
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || (required !== "yes" && required !== "no")}>
          {busy ? "Saving…" : "Save follow-up decision"}
        </button>
      )}
    </form>
  );
}
