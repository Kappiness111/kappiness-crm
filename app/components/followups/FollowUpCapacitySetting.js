"use client";

import { useEffect, useState } from "react";
import { describeFollowUpError, getSlotCapacity, listSlotStatus, setSlotCapacity, todayInputValue } from "../../lib/followUpsApi";

/* Daily follow-up limit for one psychologist (follow_up_slot_capacity, via set_follow_up_slot_capacity).
   "No extra limit" = as many follow-ups as free working-hour slots allow. Staff only (canManage); the database
   checks again. notify(message, tone). */
export default function FollowUpCapacitySetting({ psychologistId, canManage, notify }) {
  const [data, setData] = useState({ key: "", capacity: null, today: null, error: "" });
  const [reload, setReload] = useState(0);
  const [mode, setMode] = useState(null); // "none" | "limit", null until loaded
  const [max, setMax] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = `${psychologistId}|${reload}`;

  useEffect(() => {
    if (!canManage) return undefined;
    let cancelled = false;
    const today = todayInputValue();
    Promise.all([getSlotCapacity(psychologistId), listSlotStatus({ psychologistId, dateFrom: today, dateTo: today })])
      .then(([capacity, slots]) => {
        if (cancelled) return;
        const first = slots[0] || null;
        setData({
          key,
          capacity: capacity ? capacity.max_follow_up_slots_per_day : null,
          today: first ? { remaining: first.day_remaining_slots, used: first.day_follow_up_slots_used } : null,
          error: "",
        });
        const limit = capacity ? capacity.max_follow_up_slots_per_day : null;
        setMode(limit === null ? "none" : "limit");
        setMax(limit === null ? "" : String(limit));
      })
      .catch((err) => {
        if (!cancelled) setData({ key, capacity: null, today: null, error: describeFollowUpError(err, "Could not load the follow-up limit.") });
      });
    return () => {
      cancelled = true;
    };
  }, [psychologistId, canManage, key]);

  if (!canManage) return null;
  const loading = data.key !== key;

  async function save(event) {
    event.preventDefault();
    if (busy) return;
    let value = null;
    if (mode === "limit") {
      value = Number(max);
      if (max === "" || !Number.isInteger(value) || value < 0 || value > 48) return setError("Enter a whole number from 0 to 48.");
    }
    setBusy(true);
    setError("");
    try {
      await setSlotCapacity(psychologistId, value);
      notify(value === null ? "Follow-up limit removed: no extra limit." : `Follow-up limit set to ${value} per day.`);
      setReload((current) => current + 1);
    } catch (err) {
      setError(describeFollowUpError(err, "Could not save the follow-up limit."));
    } finally {
      setBusy(false);
    }
  }

  const unchanged = mode === (data.capacity === null ? "none" : "limit") && (mode === "none" || String(data.capacity) === max);

  return (
    <section className="section" aria-labelledby="fu-capacity-title">
      <div className="section-head">
        <div>
          <h2 id="fu-capacity-title">Follow-up sessions per day</h2>
          <p>The most follow-up sessions (held or booked) this psychologist can take in one day. Visible to clinic staff only.</p>
        </div>
      </div>
      <div className="panel" style={{ padding: 16 }}>
        {loading ? (
          <p className="appt-empty">Loading…</p>
        ) : data.error ? (
          <div className="state" role="alert">
            <strong>{data.error}</strong>
            <button type="button" className="btn btn-sm" onClick={() => setReload((current) => current + 1)}>
              Try again
            </button>
          </div>
        ) : (
          <form onSubmit={save} noValidate style={{ display: "grid", gap: 12 }}>
            <p style={{ margin: 0 }}>
              Current: <strong>{data.capacity === null ? "No extra limit" : `${data.capacity} per day`}</strong>
              {" · "}
              Today:{" "}
              <strong>
                {data.today ? `${data.today.remaining} follow-up slot${data.today.remaining === 1 ? "" : "s"} left` : "no working hours left today"}
              </strong>
              {data.today ? <span className="muted"> ({data.today.used} used)</span> : null}
            </p>
            <fieldset className="field">
              <legend className="field-label">Limit</legend>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center" }}>
                <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                  <input type="radio" name="fu-capacity-mode" checked={mode === "none"} onChange={() => setMode("none")} />
                  No extra limit
                </label>
                <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                  <input type="radio" name="fu-capacity-mode" checked={mode === "limit"} onChange={() => setMode("limit")} />
                  Up to
                </label>
                {mode === "limit" && (
                  <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                    <span className="sr-only">Follow-up sessions per day</span>
                    <input type="number" min={0} max={48} step={1} inputMode="numeric" value={max} onChange={(event) => setMax(event.target.value)} style={{ width: 80 }} />
                    per day
                  </label>
                )}
              </div>
            </fieldset>
            {error && (
              <p className="field-error" role="alert">
                {error}
              </p>
            )}
            <div>
              <button type="submit" className="btn btn-primary btn-sm" disabled={busy || unchanged}>
                {busy ? "Saving…" : "Save limit"}
              </button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
