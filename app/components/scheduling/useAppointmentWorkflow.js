"use client";

import { useCallback, useState } from "react";
import BookingModal from "../BookingModal";
import ReasonDialog from "../ReasonDialog";
import {
  ACTIVE_APPOINTMENT_STATUSES,
  appointmentActions,
  bookAppointment,
  cancelAppointment,
  confirmAppointment,
  describeAppointmentError,
  listAppointments,
  recordAttendance,
  rescheduleAppointment,
} from "../../lib/appointmentsApi";
import { formatDateTime } from "../../lib/leads";
import { listAllAvailability, listPsychologists } from "../../lib/psychologistsApi";
import { listBlocks, listServices } from "../../lib/schedulingApi";

/* One appointment workflow for every screen outside the main CRM page (client details, sessions,
   recommendations, psychologist workspace): book, reschedule, cancel (with reason), confirm, attendance.

   viewer: { isStaff, ownPsychologist }   ownPsychologist = { id, name } for a psychologist login
   onChanged(appointment): called after any successful change so the screen can reload
   notify(message, tone): toast

   Returns { actionsFor, runAction, openBooking, openReschedule, dialogs } — render `dialogs` once. */
export default function useAppointmentWorkflow({ viewer, onChanged, notify }) {
  const [dialog, setDialog] = useState(null); // { mode, client?, appointment?, recommendation? }
  const [cancelTarget, setCancelTarget] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [data, setData] = useState(null); // scheduling data, loaded when a booking dialog opens

  const ownId = viewer.ownPsychologist ? viewer.ownPsychologist.id : null;

  const actionsFor = useCallback(
    (item) => appointmentActions(item, { isStaff: viewer.isStaff, ownPsychologistId: ownId, now: new Date() }),
    [viewer.isStaff, ownId]
  );

  async function loadSchedulingData() {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const [psychologists, availability, services, blocks, appointments] = await Promise.all([
      viewer.isStaff ? listPsychologists() : Promise.resolve(viewer.ownPsychologist ? [viewer.ownPsychologist] : []),
      listAllAvailability(),
      listServices({ activeOnly: true }),
      listBlocks({ from }),
      listAppointments({ from, statuses: ACTIVE_APPOINTMENT_STATUSES }),
    ]);
    const schedulable = viewer.isStaff ? psychologists.filter((item) => item.active) : psychologists;
    return { psychologists: schedulable, availability, services, blocks, appointments };
  }

  async function open(next) {
    try {
      setData(await loadSchedulingData());
      setDialog(next);
    } catch (error) {
      console.error("Failed to load scheduling data:", error);
      notify(describeAppointmentError(error, "We couldn't load the available times. Please try again."), "error");
    }
  }

  // client: { id, full_name, primary_psychologist_id, ... } or null to choose from `clients`; recommendation optional
  // preset (optional): { psychologistId, day: Date, slotStart: Date } from a schedule slot.
  const openBooking = (client, recommendation = null, clients = [], preset = null) => open({ mode: "book", client, recommendation, clients, preset });
  const openReschedule = (appointment) => open({ mode: "reschedule", appointment });

  async function submit(values) {
    try {
      let saved;
      if (dialog.mode === "reschedule") {
        saved = await rescheduleAppointment(dialog.appointment.id, {
          startsAt: values.starts_at,
          psychologistId: values.psychologist_id,
          reason: values.reason,
        });
        notify(`Moved to ${formatDateTime(saved.starts_at)}. The earlier time is now free.`);
      } else {
        saved = await bookAppointment({
          clientId: values.client_id,
          psychologistId: values.psychologist_id,
          serviceId: values.service_id,
          startsAt: values.starts_at,
          notes: values.notes,
          recommendationId: values.recommendation_id,
        });
        notify(`Appointment booked for ${formatDateTime(saved.starts_at)}`);
      }
      onChanged(saved);
      return { ok: true };
    } catch (error) {
      console.error("Failed to save appointment:", error);
      return { ok: false, message: describeAppointmentError(error) };
    }
  }

  async function runAction(item, action) {
    if (!actionsFor(item).includes(action)) {
      notify("That change is not allowed for this appointment.", "error");
      return;
    }
    if (action === "reschedule") return openReschedule(item);
    if (action === "cancel") return setCancelTarget(item);
    setBusyId(item.id);
    try {
      let saved;
      if (action === "confirm") saved = await confirmAppointment(item.id);
      else if (action === "attended") saved = await recordAttendance(item.id, true);
      else if (action === "missed") saved = await recordAttendance(item.id, false);
      else return;
      notify(
        saved.status === "Completed"
          ? "Session marked as completed."
          : saved.status === "Missed"
            ? "Session marked as missed."
            : "Client confirmation recorded."
      );
      onChanged(saved);
    } catch (error) {
      console.error("Failed to update appointment:", error);
      notify(describeAppointmentError(error), "error");
    } finally {
      setBusyId(null);
    }
  }

  async function submitCancel(reason) {
    try {
      const saved = await cancelAppointment(cancelTarget.id, reason);
      notify("Appointment cancelled. The time is free for other bookings.");
      onChanged(saved);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: describeAppointmentError(error) };
    }
  }

  const dialogs = (
    <>
      {dialog && data && (
        <BookingModal
          key={dialog.mode + (dialog.appointment ? dialog.appointment.id : dialog.client ? dialog.client.id : "")}
          mode={dialog.mode}
          lockedClient={dialog.client || null}
          clients={dialog.clients || []}
          preset={dialog.preset || null}
          appointment={dialog.appointment || null}
          recommendation={dialog.recommendation || null}
          psychologists={data.psychologists}
          services={data.services}
          availability={data.availability}
          blocks={data.blocks}
          appointments={data.appointments}
          now={new Date()}
          onClose={() => setDialog(null)}
          onSubmit={submit}
        />
      )}
      {cancelTarget && (
        <ReasonDialog
          title="Cancel appointment"
          subtitle={`${cancelTarget.client_name}, ${formatDateTime(cancelTarget.starts_at)}. The record and its original time are kept; the slot becomes free.`}
          label="Reason for cancellation"
          confirmLabel="Cancel appointment"
          danger
          onClose={() => setCancelTarget(null)}
          onSubmit={submitCancel}
        />
      )}
    </>
  );

  return { actionsFor, runAction, openBooking, openReschedule, busyId, dialogs };
}
