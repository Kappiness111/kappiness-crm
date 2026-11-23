/* Plain-language labels for the psychologist workspace. The stored statuses do not change; only how they read.

   Appointment = a booked meeting.   Session = what happened at it (completed after the client attends).
   Follow-up recommended = suggested by the psychologist, not booked yet.
   Follow-up scheduled   = a date and time are booked.
   Awaiting confirmation = booked, but the client has not confirmed yet. */

export const APPOINTMENT_STATUS_LABEL = {
  Scheduled: "Awaiting confirmation",
  Confirmed: "Confirmed",
  Completed: "Completed",
  Missed: "Missed",
  Cancelled: "Cancelled",
  Rescheduled: "Rescheduled",
};

export const SESSION_STATUS_LABEL = {
  Scheduled: "Upcoming",
  Completed: "Completed",
  Missed: "Missed",
  Cancelled: "Cancelled",
};

export function appointmentStatusLabel(status) {
  return APPOINTMENT_STATUS_LABEL[status] || status;
}

export function sessionStatusLabel(status) {
  return SESSION_STATUS_LABEL[status] || status;
}

// "Individual counselling · Follow-up session" for follow-ups, otherwise just the service.
export function sessionTypeLabel(appointment) {
  const service = appointment.service_type || appointment.serviceType || "Session";
  return appointment.recommendation_id ? `${service} · Follow-up session` : service;
}
