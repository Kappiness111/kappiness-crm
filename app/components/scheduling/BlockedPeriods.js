"use client";

import { useCallback, useEffect, useState } from "react";
import Icon from "../Icon";
import { describeAppointmentError } from "../../lib/appointmentsApi";
import { addBlock, blockConflicts, listBlocks, removeBlock } from "../../lib/schedulingApi";
import { formatDate, formatDateTime, formatTime } from "../../lib/leads";

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* Date-specific unavailable periods for one psychologist (leave, training, a closed afternoon).
   Blocking never touches existing bookings: if active appointments fall inside the period, they are listed
   and the block is not saved until a person cancels or reschedules them. The database enforces the same. */
export default function BlockedPeriods({ psychologistId, canManage = true, notify }) {
  const [blocks, setBlocks] = useState([]);
  const [state, setState] = useState("loading");
  const [form, setForm] = useState({ from: todayKey(), to: todayKey(), allDay: true, start: "09:00", end: "13:00", reason: "" });
  const [error, setError] = useState("");
  const [conflicts, setConflicts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    listBlocks({ psychologistId, from })
      .then((rows) => {
        if (cancelled) return;
        setBlocks(rows);
        setState("ready");
      })
      .catch((err) => {
        console.error("Failed to load blocked periods:", err);
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [psychologistId, reload]);

  const set = (field) => (event) => {
    const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
    setForm((current) => ({ ...current, [field]: value }));
    setError("");
    setConflicts([]);
  };

  const range = useCallback(() => {
    if (!form.from || !form.to) return null;
    const start = new Date(`${form.from}T${form.allDay ? "00:00" : form.start}`);
    const endDay = new Date(`${form.to}T${form.allDay ? "00:00" : form.end}`);
    const end = form.allDay ? new Date(endDay.getFullYear(), endDay.getMonth(), endDay.getDate() + 1) : endDay;
    return { start, end };
  }, [form]);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const r = range();
    if (!r || Number.isNaN(r.start.getTime()) || Number.isNaN(r.end.getTime())) return setError("Choose the dates to block.");
    if (r.end <= r.start) return setError("The period must end after it starts.");
    if (!form.allDay && form.from !== form.to) return setError("A part-day block covers one date. Use all day for several dates.");

    setBusy(true);
    setError("");
    try {
      const clash = await blockConflicts(psychologistId, r.start, r.end);
      if (clash.length > 0) {
        setConflicts(clash);
        return;
      }
      await addBlock(psychologistId, r.start, r.end, form.reason);
      notify("Period blocked. No new bookings can be made in it.");
      setForm((current) => ({ ...current, reason: "" }));
      setReload((value) => value + 1);
    } catch (err) {
      setError(describeAppointmentError(err, "Could not block this period. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  async function remove(block) {
    setBusy(true);
    try {
      await removeBlock(block.id);
      notify("Blocked period removed");
      setReload((value) => value + 1);
    } catch (err) {
      notify(describeAppointmentError(err, "Could not remove the blocked period."), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section" aria-labelledby="blocked-title">
      <div className="section-head">
        <div>
          <h2 id="blocked-title">Blocked dates</h2>
          <p>Days or hours when you are away, for example leave or training. Nobody can be booked at these times. Existing appointments are never cancelled or moved for you.</p>
        </div>
      </div>

      <div className="panel">
        {state === "loading" && <p className="appt-empty">Loading blocked periods…</p>}
        {state === "error" && (
          <div className="state" role="alert">
            <strong>Could not load blocked periods</strong>
            <button type="button" className="btn btn-sm" onClick={() => setReload((value) => value + 1)}>
              Try again
            </button>
          </div>
        )}
        {state === "ready" && blocks.length === 0 && <p className="appt-empty">No blocked dates coming up.</p>}
        {state === "ready" && blocks.length > 0 && (
          <ul className="list">
            {blocks.map((block) => (
              <li key={block.id} className="list-row">
                <span className="grow">
                  <strong>
                    {formatDateTime(block.starts_at)} – {formatDateTime(block.ends_at)}
                  </strong>
                  <span>
                    {block.reason || "No reason given"}
                    {block.created_by_name ? ` · added by ${block.created_by_name}` : ""}
                  </span>
                </span>
                {canManage && (
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={() => remove(block)}>
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {canManage && (
          <form className="block-form" onSubmit={submit} noValidate>
            <div className="field-row">
              <div className="field">
                <label htmlFor="block-from">From</label>
                <input id="block-from" type="date" min={todayKey()} value={form.from} onChange={set("from")} />
              </div>
              <div className="field">
                <label htmlFor="block-to">To</label>
                <input id="block-to" type="date" min={form.from} value={form.to} onChange={set("to")} />
              </div>
            </div>
            <label className="check">
              <input type="checkbox" checked={form.allDay} onChange={set("allDay")} /> All day
            </label>
            {!form.allDay && (
              <div className="field-row">
                <div className="field">
                  <label htmlFor="block-start">Start time</label>
                  <input id="block-start" type="time" value={form.start} onChange={set("start")} />
                </div>
                <div className="field">
                  <label htmlFor="block-end">End time</label>
                  <input id="block-end" type="time" value={form.end} onChange={set("end")} />
                </div>
              </div>
            )}
            <div className="field">
              <label htmlFor="block-reason">Reason (optional)</label>
              <input id="block-reason" maxLength={200} value={form.reason} onChange={set("reason")} />
            </div>

            {conflicts.length > 0 && (
              <div className="notice warn" role="alert">
                <Icon name="alert" />
                <div>
                  <strong>
                    {conflicts.length} appointment{conflicts.length > 1 ? "s are" : " is"} booked in this period
                  </strong>
                  Cancel or reschedule {conflicts.length > 1 ? "them" : "it"} first. Nothing has been changed.
                  <ul className="conflict-list">
                    {conflicts.map((item) => (
                      <li key={item.appointment_id}>
                        {item.client_name}: {formatDate(item.starts_at)}, {formatTime(item.starts_at)}–{formatTime(item.ends_at)} ({item.status})
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
            {error && (
              <p className="field-error" role="alert">
                {error}
              </p>
            )}
            <div>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? "Checking…" : "Block these dates"}
              </button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
