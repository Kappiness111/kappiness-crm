/* One row per follow-up session, built from real records:
     follow_up_recommendations  what the psychologist recommended (date, time, priority, status)
     appointments               every booking made for it (recommendation_id); the current one is
                                recommendation.appointment_id, earlier ones are Rescheduled / Cancelled history
     appointment_reminders      reminder 1 and reminder 2 of the current appointment (staff only)
   The database decides all of these; this file only arranges them for the screen. */

import { ACTIVE_APPOINTMENT_STATUSES } from "./appointmentsApi";
import { isReminderDue } from "./remindersApi";

// Follow-up status shown in the list (separate from appointment status and from reminder statuses).
export const FOLLOW_UP_STATES = {
  // Wording: "recommended" = suggested, not booked; "scheduled" = date and time booked and confirmed;
  // "awaiting confirmation" = booked, the client has not confirmed yet.
  open: { label: "Follow-up recommended", tone: "info" },
  overdue: { label: "Recommended date passed", tone: "danger" },
  reschedule: { label: "Client wants to reschedule", tone: "warning" },
  scheduled: { label: "Awaiting confirmation", tone: "info" },
  confirmed: { label: "Follow-up scheduled", tone: "success" },
  attendance: { label: "Started: update needed", tone: "warning" },
  completed: { label: "Follow-up completed", tone: "success" },
  missed: { label: "Missed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  closed: { label: "Closed", tone: "neutral" },
  dismissed: { label: "Not needed", tone: "neutral" },
};

function recommendedAt(rec) {
  return new Date(`${rec.recommended_date}T${rec.recommended_time ? String(rec.recommended_time).slice(0, 5) : "23:59"}`);
}

export function buildFollowUpSessions({ recommendations, appointments, reminders = [], now = new Date() }) {
  const byRecommendation = new Map();
  appointments.forEach((appt) => {
    if (!appt.recommendation_id) return;
    const list = byRecommendation.get(appt.recommendation_id) || [];
    list.push(appt);
    byRecommendation.set(appt.recommendation_id, list);
  });
  const remindersByAppointment = new Map();
  reminders.forEach((row) => {
    const list = remindersByAppointment.get(row.appointment_id) || [];
    list.push(row);
    remindersByAppointment.set(row.appointment_id, list);
  });

  return recommendations.map((rec) => {
    const chain = (byRecommendation.get(rec.id) || []).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const current = rec.appointment_id ? chain.find((item) => item.id === rec.appointment_id) || null : null;
    const previous = chain.filter((item) => item !== current).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const ownReminders = current ? remindersByAppointment.get(current.id) || [] : [];
    const reminder1 = ownReminders.find((row) => row.reminder_number === 1) || null;
    const reminder2 = ownReminders.find((row) => row.reminder_number === 2) || null;

    const active = current && ACTIVE_APPOINTMENT_STATUSES.includes(current.status);
    const started = current && new Date(current.starts_at).getTime() <= now.getTime();
    // The most recent response wins when both reminders were answered.
    const answered = [reminder1, reminder2].filter((row) => row && row.client_response).sort((a, b) => new Date(b.responded_at) - new Date(a.responded_at));
    const latestResponse = answered[0] ? answered[0].client_response : null;
    const rescheduleRequested = Boolean(active && latestResponse === "Wants to Reschedule");

    let state;
    if (rec.status === "Completed") state = "closed";
    else if (rec.status === "Dismissed") state = "dismissed";
    else if (current) {
      if (rescheduleRequested) state = "reschedule";
      else if (active && started) state = "attendance";
      else if (active) state = current.status === "Confirmed" ? "confirmed" : "scheduled";
      else state = String(current.status).toLowerCase(); // completed | missed | cancelled
    } else state = recommendedAt(rec).getTime() < now.getTime() ? "overdue" : "open";

    const remindersDue = [reminder1, reminder2].filter((row) => row && isReminderDue(row, now)).length;
    const needsAction =
      state === "reschedule" || state === "overdue" || state === "attendance" || remindersDue > 0 || (state === "open" && rec.priority !== "Normal");

    return {
      id: rec.id,
      recommendation: rec,
      clientId: rec.client_id,
      clientName: rec.client_name,
      clientPhone: rec.client_phone,
      leadId: rec.lead_id,
      psychologistId: rec.psychologist_id,
      recommendedAt: recommendedAt(rec),
      current,
      previous,
      reminder1,
      reminder2,
      latestResponse,
      rescheduleRequested,
      remindersDue,
      state,
      needsAction,
      // Sort key: what happens next (booked time, else the recommended time).
      when: current ? new Date(current.starts_at) : recommendedAt(rec),
    };
  });
}

export function followUpCounts(rows) {
  const count = (fn) => rows.filter(fn).length;
  return {
    needsAction: count((row) => row.needsAction),
    reschedule: count((row) => row.state === "reschedule"),
    open: count((row) => row.state === "open" || row.state === "overdue"),
    upcoming: count((row) => ["scheduled", "confirmed", "reschedule"].includes(row.state)),
    remindersDue: rows.reduce((sum, row) => sum + row.remindersDue, 0),
    done: count((row) => ["completed", "closed", "dismissed", "missed", "cancelled"].includes(row.state)),
    all: rows.length,
  };
}
