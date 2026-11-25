"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Field from "../Field";
import Icon from "../Icon";
import { formatDateTime, parseDate, toInputValue, whatsappLink } from "../../lib/leads";
import { normalizePhone } from "../../lib/phone";
import {
  COMMUNICATION_CHANNELS,
  COMMUNICATION_TONE,
  channelAllows,
  communicationLabel,
  describeCommunicationError,
  listCommunications,
  listFollowUpContactsForClient,
  recordCommunication,
  statusesForChannel,
} from "../../lib/communicationApi";

const NOTES_LIMIT = 1000;

function waLink(phone) {
  const normalized = normalizePhone(phone);
  return normalized && normalized.startsWith("+") ? `https://wa.me/${normalized.slice(1)}` : whatsappLink(phone);
}

export function CommunicationBadge({ status }) {
  if (!status) return <span className="badge">No contact recorded</span>;
  return (
    <span className={`badge ${COMMUNICATION_TONE[status] || ""}`}>
      <span className="badge-dot" />
      {communicationLabel(status)}
    </span>
  );
}

/* Communication history and recording for ONE lead or ONE client (public.communication_events).
   subject: { leadId } or { clientId }  where new entries are recorded
   includeLeadIds: other leads whose history is shown too (a client's original and linked enquiries)
   includeFollowUps: also show the client's follow-up communications (read-only, recorded in follow-ups)
   leadLabels: { [leadId]: "KAP-001" } to label entries recorded on an enquiry
   canRecord: staff only (the database checks again)
   Opening WhatsApp or the phone dialler records nothing; "Message Sent" is saved only after staff confirm it. */
export default function CommunicationPanel({
  subject,
  name = "",
  phone = "",
  includeLeadIds = [],
  includeFollowUps = false,
  leadLabels = {},
  canRecord = false,
  notify,
  onRecorded,
}) {
  const leadId = subject.leadId || null;
  const clientId = subject.clientId || null;
  const [events, setEvents] = useState([]);
  const [loadState, setLoadState] = useState("loading");
  const [reload, setReload] = useState(0);
  const [channel, setChannel] = useState("Call");
  const [status, setStatus] = useState("Call Completed");
  const [notes, setNotes] = useState("");
  const [occurredAt, setOccurredAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [whatsAppOpened, setWhatsAppOpened] = useState(false);
  const savingRef = useRef(false);
  const leadKey = [leadId, ...includeLeadIds].filter(Boolean).join(",");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoadState((current) => (current === "ready" ? current : "loading"));
      try {
        const ids = leadKey ? leadKey.split(",") : [];
        const [rows, followUps] = await Promise.all([
          listCommunications({ leadIds: ids, clientId }),
          includeFollowUps && clientId ? listFollowUpContactsForClient(clientId).catch(() => []) : Promise.resolve([]),
        ]);
        if (cancelled) return;
        const merged = [...rows.map((row) => ({ ...row, source: "crm" })), ...followUps].sort(
          (a, b) => new Date(b.occurred_at) - new Date(a.occurred_at) || new Date(b.created_at) - new Date(a.created_at)
        );
        setEvents(merged);
        setLoadState("ready");
      } catch (err) {
        console.error("Failed to load communication history:", err);
        if (!cancelled) setLoadState("error");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [leadKey, clientId, includeFollowUps, reload]);

  // The current status of THIS subject (its own entries only; follow-ups keep their own status).
  const current = useMemo(() => {
    const own = events.filter((row) => row.source === "crm" && (leadId ? row.lead_id === leadId : row.client_id === clientId));
    return own.length ? own[0].communication_status : null;
  }, [events, leadId, clientId]);

  function chooseChannel(value) {
    setChannel(value);
    if (!channelAllows(value, status)) setStatus(statusesForChannel(value)[0]);
  }

  async function save(values) {
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      const at = values.occurredAt ? parseDate(values.occurredAt) : null;
      if (values.occurredAt && !at) throw Object.assign(new Error("Enter a valid date and time."), { code: "22023" });
      const saved = await recordCommunication({ leadId, clientId, channel: values.channel, status: values.status, notes: values.notes, occurredAt: at });
      setEvents((rows) => [{ ...saved, source: "crm" }, ...rows]);
      if (notify) notify(`${communicationLabel(values.status)} recorded for ${name || "this contact"}`);
      if (onRecorded) onRecorded(saved);
      return true;
    } catch (err) {
      const message = describeCommunicationError(err);
      setError(message);
      if (notify) notify(message, "error");
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (notes.length > NOTES_LIMIT) {
      setError(`Keep notes under ${NOTES_LIMIT} characters.`);
      return;
    }
    const ok = await save({ channel, status, notes, occurredAt });
    if (ok) {
      setNotes("");
      setOccurredAt("");
    }
  }

  async function confirmWhatsAppSent() {
    const ok = await save({ channel: "WhatsApp", status: "Message Sent", notes, occurredAt: "" });
    if (ok) {
      setWhatsAppOpened(false);
      setNotes("");
    }
  }

  const sourceLabel = (row) => {
    if (row.source === "follow-up") return "Follow-up";
    if (row.lead_id) return leadLabels[row.lead_id] ? `Enquiry ${leadLabels[row.lead_id]}` : "Enquiry";
    return "Client";
  };

  return (
    <div className="comm-panel">
      <div className="comm-panel-head">
        <div>
          <span className="muted">Current communication status</span>
          <div>
            <CommunicationBadge status={current} />
          </div>
        </div>
        {phone && (
          <div className="followup-actions">
            <a className="btn btn-sm" href={`tel:${String(phone).replace(/\s/g, "")}`}>
              <Icon name="phone" /> Call
            </a>
            <a
              className="btn btn-sm"
              href={waLink(phone)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => {
                if (canRecord) setWhatsAppOpened(true);
              }}
            >
              <Icon name="chat" /> Open WhatsApp
            </a>
          </div>
        )}
      </div>
      <p className="subtle-text" style={{ margin: "6px 0 0" }}>
        Separate from the lead, client, appointment and session status. Opening WhatsApp or the dialler records nothing.
      </p>

      {whatsAppOpened && canRecord && (
        <div className="notice warn" role="status" style={{ marginTop: 10 }}>
          <Icon name="info" />
          <div>
            <strong>WhatsApp was opened. Nothing has been recorded.</strong>
            Did you actually send the message?
            <div className="followup-actions" style={{ marginTop: 8 }}>
              <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={() => void confirmWhatsAppSent()}>
                {saving ? "Saving…" : "Yes, record Message Sent"}
              </button>
              <button type="button" className="btn btn-sm" disabled={saving} onClick={() => setWhatsAppOpened(false)}>
                Not sent
              </button>
            </div>
          </div>
        </div>
      )}

      {canRecord && (
        <form className="comm-form" noValidate onSubmit={submit} aria-busy={saving}>
          <fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <div className="field-grid">
              <Field id={`comm-channel-${leadId || clientId}`} label="Channel" required>
                <select id={`comm-channel-${leadId || clientId}`} value={channel} onChange={(event) => chooseChannel(event.target.value)}>
                  {COMMUNICATION_CHANNELS.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id={`comm-status-${leadId || clientId}`} label="Communication status" required>
                <select id={`comm-status-${leadId || clientId}`} value={status} onChange={(event) => setStatus(event.target.value)}>
                  {statusesForChannel(channel).map((item) => (
                    <option key={item} value={item}>
                      {communicationLabel(item)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id={`comm-at-${leadId || clientId}`} label="When" hint="Leave empty for now. Up to 30 days back.">
                <input
                  id={`comm-at-${leadId || clientId}`}
                  type="datetime-local"
                  value={occurredAt}
                  max={toInputValue(new Date())}
                  onChange={(event) => setOccurredAt(event.target.value)}
                />
              </Field>
              <Field
                id={`comm-notes-${leadId || clientId}`}
                label="Notes"
                className="span-2"
                hint={
                  <>
                    Optional. Practical details only.
                    <span className="char-count">
                      {notes.length}/{NOTES_LIMIT}
                    </span>
                  </>
                }
              >
                <textarea
                  id={`comm-notes-${leadId || clientId}`}
                  rows={2}
                  maxLength={NOTES_LIMIT}
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="For example: Will call back after checking with family."
                />
              </Field>
            </div>
          </fieldset>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <div className="activity-form-actions">
            <button type="submit" className="primary-button" disabled={saving}>
              <Icon name="plus" /> {saving ? "Saving…" : "Record communication"}
            </button>
          </div>
        </form>
      )}

      <h4 className="field-label" style={{ marginTop: 14 }}>
        History <span className="muted num">{events.length}</span>
      </h4>
      {loadState === "loading" && (
        <p className="subtle-text" role="status">
          Loading communication history…
        </p>
      )}
      {loadState === "error" && (
        <p className="subtle-text" role="alert">
          Could not load the communication history.{" "}
          <button type="button" className="text-button" onClick={() => setReload((value) => value + 1)}>
            Try again
          </button>
        </p>
      )}
      {loadState === "ready" && events.length === 0 && <p className="subtle-text">No communication recorded yet.</p>}
      {events.length > 0 && (
        <ol className="activity-list">
          {events.map((row) => (
            <li key={row.id} className="activity-item logged">
              <span className="activity-dot">
                <Icon name={row.channel === "Call" ? "phone" : row.channel === "Email" ? "mail" : row.channel === "Reminder" ? "bell" : "chat"} />
              </span>
              <div>
                <p className="activity-text">
                  <CommunicationBadge status={row.communication_status} /> <strong>{row.channel || "Follow-up contact"}</strong>
                  <span className="muted"> · {sourceLabel(row)}</span>
                </p>
                {row.notes ? <p className="activity-text">{row.notes}</p> : null}
                <span className="activity-time">
                  {formatDateTime(row.occurred_at)}
                  {row.recorded_by_name ? ` · ${row.recorded_by_name}` : ""}
                  {row.previous_status ? ` · was ${communicationLabel(row.previous_status)}` : ""}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
