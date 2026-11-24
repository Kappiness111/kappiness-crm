"use client";

import { useState } from "react";
import { COMMUNICATION_STATUSES, communicationLabel, describeFollowUpError, setCommunicationStatus } from "../../lib/followUpsApi";

/* Quick buttons that record what actually happened with the client (staff only; the database checks again).
   Opening WhatsApp is never recorded as "Message Sent": staff press Message Sent after they have sent it.
   onSaved(result, status) gets { followUp, createdFollowUpId, contactNeededOpen }. */
export default function CommunicationButtons({ followUp, notify, onSaved, compact = false }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const noteId = `comm-note-${followUp.id}`;

  async function choose(status) {
    if (busy) return;
    setBusy(status);
    setError("");
    try {
      const result = await setCommunicationStatus(followUp.id, status, note);
      setNote("");
      if (status === "No Response") {
        notify(
          result.createdFollowUpId
            ? `No Response recorded for ${followUp.client_name || "the client"}. A call follow-up (Contact client, status Contact Needed) was created for reception.`
            : result.createdFollowUpId === null
              ? `No Response recorded for ${followUp.client_name || "the client"}. A call follow-up for reception (Contact Needed) already exists for this client.`
              : `No Response recorded for ${followUp.client_name || "the client"}. A call follow-up for reception (Contact Needed) is open for this client.`
        );
      } else {
        notify(`${communicationLabel(status)} recorded for ${followUp.client_name || "the client"}`);
      }
      if (onSaved) onSaved(result, status);
    } catch (err) {
      const message = describeFollowUpError(err, "Could not record the communication status.");
      setError(message);
      notify(message, "error");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="comm-buttons">
      {!compact && (
        <div className="field">
          <label htmlFor={noteId}>Note (optional)</label>
          <input id={noteId} type="text" maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} placeholder="What happened" />
        </div>
      )}
      <div className="followup-actions" role="group" aria-label={`Communication status for ${followUp.client_name || "client"}`}>
        {COMMUNICATION_STATUSES.map((status) => {
          const current = followUp.communication_status === status;
          return (
            <button
              key={status}
              type="button"
              className={`btn btn-sm ${current ? "btn-primary" : ""}`}
              aria-pressed={current}
              disabled={Boolean(busy)}
              onClick={() => choose(status)}
            >
              {busy === status ? "Saving…" : communicationLabel(status)}
            </button>
          );
        })}
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
