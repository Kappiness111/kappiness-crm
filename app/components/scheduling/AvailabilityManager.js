"use client";

import { useCallback, useEffect, useState } from "react";
import AvailabilityForm from "../psychologists/AvailabilityForm";
import AvailabilitySchedule from "../psychologists/AvailabilitySchedule";
import BlockedPeriods from "./BlockedPeriods";
import { findOverlappingPeriod } from "../../lib/appointmentSlots";
import { describeError } from "../../lib/psychologists";
import { createAvailability, listAvailability, updateAvailability } from "../../lib/psychologistsApi";

/* Weekly availability (several periods per day, with breaks between them) and blocked dates for one
   psychologist. Used by a psychologist for their own schedule; RLS allows them to manage only their own rows,
   and the database rejects overlapping active periods. onChanged() lets the caller refresh calendar shading. */
export default function AvailabilityManager({ psychologistId, notify, onChanged }) {
  const [periods, setPeriods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [form, setForm] = useState(null); // null | { period } | { defaultDay }
  const [busyIds, setBusyIds] = useState([]);

  const load = useCallback(async () => {
    try {
      setPeriods(await listAvailability(psychologistId));
      setError("");
    } catch (err) {
      console.error("Failed to load availability:", err);
      setError(describeError(err, "Could not load your availability."));
    } finally {
      setLoading(false);
    }
  }, [psychologistId]);

  useEffect(() => {
    // Initial fetch: state only changes after the request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function save(values) {
    const editing = form && form.period;
    const clash = values.is_active && findOverlappingPeriod(periods, values, editing ? editing.id : null);
    if (clash) return { ok: false, message: "This period overlaps another active period on the same day." };
    try {
      if (editing) {
        const saved = await updateAvailability(editing.id, values);
        setPeriods((current) => current.map((item) => (item.id === saved.id ? saved : item)));
        notify("Availability updated");
      } else {
        const saved = await createAvailability(psychologistId, values);
        setPeriods((current) => [...current, saved]);
        notify("Availability added");
      }
      setForm(null);
      if (onChanged) onChanged();
      return { ok: true };
    } catch (err) {
      console.error("Failed to save availability:", err);
      return { ok: false, message: describeError(err, "Could not save this availability. Please try again.") };
    }
  }

  async function toggle(period) {
    if (busyIds.includes(period.id)) return;
    if (!period.is_active && findOverlappingPeriod(periods, { ...period, is_active: true }, period.id)) {
      notify("This period overlaps another active period on the same day. Edit one of them first.", "error");
      return;
    }
    setBusyIds((ids) => [...ids, period.id]);
    try {
      const saved = await updateAvailability(period.id, { is_active: !period.is_active });
      setPeriods((current) => current.map((item) => (item.id === saved.id ? saved : item)));
      notify(saved.is_active ? "Availability activated" : "Availability deactivated");
      if (onChanged) onChanged();
    } catch (err) {
      notify(describeError(err, "Could not change the availability."), "error");
    } finally {
      setBusyIds((ids) => ids.filter((id) => id !== period.id));
    }
  }

  return (
    <>
      <AvailabilitySchedule
        periods={periods}
        loading={loading}
        error={error}
        canManage
        busyIds={busyIds}
        onRetry={() => {
          setLoading(true);
          load();
        }}
        onAdd={(day) => setForm({ defaultDay: day })}
        onEdit={(period) => setForm({ period })}
        onToggle={toggle}
      />

      <BlockedPeriods psychologistId={psychologistId} notify={notify} />

      {form && (
        <AvailabilityForm period={form.period} defaultDay={form.defaultDay} existingPeriods={periods} onSubmit={save} onClose={() => setForm(null)} />
      )}
    </>
  );
}
