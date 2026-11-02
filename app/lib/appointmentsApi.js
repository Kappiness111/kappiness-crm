/* UI-ONLY appointments. Nothing here talks to Supabase: bookings live in React state and reset on refresh.
   Availability and psychologists come from the existing psychologists / psychologist_availability tables.
   When the backend is ready, replace the bodies of the three functions below with real queries. */

export const APPOINTMENT_STATUSES = ["Scheduled", "Completed", "Cancelled", "Missed"];

// Agreed permission: may a psychologist schedule and manage their own appointments? Change when confirmed.
export const PSYCHOLOGIST_CAN_SCHEDULE = true;

export function describeAppointmentError() {
  return "Could not save the appointment. Please try again.";
}

// Resolves to the saved appointment.
export async function createAppointment({ id, lead_id, psychologist_id, starts_at, ends_at, notes, booked_by }) {
  const now = new Date().toISOString();
  return {
    id,
    lead_id,
    psychologist_id,
    starts_at: new Date(starts_at).toISOString(),
    ends_at: ends_at ? new Date(ends_at).toISOString() : "",
    status: "Scheduled",
    notes: notes || "",
    booked_by: booked_by || "",
    created_at: now,
    updated_at: now,
  };
}

// New time (and possibly psychologist) for an existing appointment. Resolves to the updated appointment.
export async function rescheduleAppointment(appointment, { psychologist_id, starts_at, ends_at, notes }) {
  return {
    ...appointment,
    psychologist_id,
    starts_at: new Date(starts_at).toISOString(),
    ends_at: ends_at ? new Date(ends_at).toISOString() : "",
    notes: notes ?? appointment.notes,
    updated_at: new Date().toISOString(),
  };
}

// Resolves to the updated appointment.
export async function updateAppointmentStatus(appointment, status) {
  return { ...appointment, status, updated_at: new Date().toISOString() };
}