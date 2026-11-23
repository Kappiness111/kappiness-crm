/* Staff notifications, built from real records each time the panel loads. There is no notifications table
   (backend dependency): nothing here is "delivered" anywhere. Read/unread is remembered in this browser only.

   Sources (all through RLS, staff access):
     appointments                  starting in the next 24 hours
     appointment_status_history    changes in the last 2 days (confirmed, cancelled, rescheduled, completed, missed)
     appointment_reminders         client asked to reschedule; reminders due to be sent
     follow_up_recommendations     recommended date passed and not booked yet
     leads                         call-back follow-ups due today or overdue */

import { createClient } from "../../utils/supabase/client";

export const NOTIFICATION_CATEGORIES = {
  reschedule: { label: "Reschedule request", tone: "warning" },
  reminder: { label: "Reminder due", tone: "warning" },
  appointment: { label: "Upcoming appointment", tone: "info" },
  followup: { label: "Follow-up", tone: "info" },
  lead: { label: "Lead call-back", tone: "info" },
  status: { label: "Status change", tone: "neutral" },
};

const HOUR = 3600000;
const READ_KEY = "kappiness-notifications-read";

function fmt(value) {
  const d = new Date(value);
  return d.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

// Each source is optional: one failing (for example no access) never hides the others.
async function safe(promise) {
  try {
    const { data, error } = await promise;
    if (error) {
      console.error("Notification source failed:", error);
      return [];
    }
    return data || [];
  } catch (error) {
    console.error("Notification source failed:", error);
    return [];
  }
}

export async function loadNotifications(now = new Date()) {
  const supabase = createClient();
  const soon = new Date(now.getTime() + 24 * HOUR).toISOString();
  const recent = new Date(now.getTime() - 48 * HOUR).toISOString();
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  const [upcoming, changes, rescheduleAsks, dueReminders, lateFollowUps, leadCalls] = await Promise.all([
    safe(
      supabase
        .from("appointments")
        .select("id, client_id, starts_at, status, service_type, client:clients(full_name)")
        .in("status", ["Scheduled", "Confirmed"])
        .gte("starts_at", now.toISOString())
        .lt("starts_at", soon)
        .order("starts_at", { ascending: true })
        .limit(50)
    ),
    safe(
      supabase
        .from("appointment_status_history")
        .select("id, appointment_id, previous_status, new_status, changed_at, changed_by_name, reason, appointment:appointments(client_id, starts_at, client:clients(full_name))")
        .gte("changed_at", recent)
        .not("previous_status", "is", null)
        .order("changed_at", { ascending: false })
        .limit(40)
    ),
    safe(
      supabase
        .from("appointment_reminders")
        .select("id, reminder_number, responded_at, response_note, appointment:appointments(id, status, starts_at, recommendation_id, client:clients(full_name))")
        .eq("client_response", "Wants to Reschedule")
        .gte("responded_at", new Date(now.getTime() - 14 * 24 * HOUR).toISOString())
        .order("responded_at", { ascending: false })
        .limit(40)
    ),
    safe(
      supabase
        .from("appointment_reminders")
        .select("id, reminder_number, due_at, appointment:appointments(id, status, starts_at, recommendation_id, client:clients(full_name))")
        .eq("delivery_status", "Pending")
        .lte("due_at", now.toISOString())
        .order("due_at", { ascending: true })
        .limit(40)
    ),
    safe(
      supabase
        .from("follow_up_recommendations")
        .select("id, client_id, recommended_date, client:clients(full_name)")
        .eq("status", "Open")
        .lt("recommended_date", todayKey)
        .order("recommended_date", { ascending: true })
        .limit(40)
    ),
    safe(
      supabase
        .from("leads")
        .select("id, full_name, next_follow_up_at, status")
        .not("next_follow_up_at", "is", null)
        .lt("next_follow_up_at", endOfToday)
        .not("status", "in", "(Confirmed,Lost)")
        .order("next_follow_up_at", { ascending: true })
        .limit(40)
    ),
  ]);

  const items = [];
  const name = (row) => (row && row.client && row.client.full_name) || "A client";

  rescheduleAsks.forEach((row) => {
    const appt = row.appointment;
    if (!appt || !["Scheduled", "Confirmed"].includes(appt.status)) return; // already moved or closed
    items.push({
      id: `reschedule-${row.id}-${row.responded_at}`,
      category: "reschedule",
      title: `${name(appt)} wants to reschedule`,
      message: `Answered reminder ${row.reminder_number} about the follow-up on ${fmt(appt.starts_at)}.${row.response_note ? ` “${row.response_note}”` : ""}`,
      at: row.responded_at,
      href: appt.recommendation_id ? `/follow-ups?focus=${appt.recommendation_id}` : "/follow-ups",
      action: "Choose a new time",
    });
  });
  dueReminders.forEach((row) => {
    const appt = row.appointment;
    if (!appt) return;
    items.push({
      id: `reminder-${row.id}`,
      category: "reminder",
      title: `Reminder ${row.reminder_number} is due for ${name(appt)}`,
      message: `Follow-up on ${fmt(appt.starts_at)}. Send it, then record the delivery.`,
      at: row.due_at,
      href: appt.recommendation_id ? `/follow-ups?focus=${appt.recommendation_id}` : "/follow-ups",
      action: "Open follow-up",
    });
  });
  upcoming.forEach((row) => {
    items.push({
      id: `upcoming-${row.id}-${row.starts_at}`,
      category: "appointment",
      title: `${name(row)} at ${new Date(row.starts_at).toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit" })}`,
      message: `${row.service_type || "Appointment"} on ${fmt(row.starts_at)} · ${row.status === "Confirmed" ? "Confirmed by client" : "Awaiting client confirmation"}`,
      at: row.starts_at,
      href: "/?view=Confirmed",
      action: "View appointments",
      upcoming: true,
    });
  });
  lateFollowUps.forEach((row) => {
    items.push({
      id: `followup-${row.id}`,
      category: "followup",
      title: `Follow-up for ${name(row)} is not booked`,
      message: `It was recommended for ${new Date(`${row.recommended_date}T00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}.`,
      at: `${row.recommended_date}T00:00:00`,
      href: `/follow-ups?focus=${row.id}`,
      action: "Book follow-up",
    });
  });
  leadCalls.forEach((row) => {
    const overdue = new Date(row.next_follow_up_at).getTime() < now.getTime();
    items.push({
      id: `lead-${row.id}-${row.next_follow_up_at}`,
      category: "lead",
      title: `${overdue ? "Overdue: call" : "Call"} ${row.full_name || "a lead"}`,
      message: `Follow-up call ${overdue ? "was due" : "is due"} ${fmt(row.next_follow_up_at)}.`,
      at: row.next_follow_up_at,
      href: "/?view=Follow Ups",
      action: "Open follow-up calls",
    });
  });
  changes.forEach((row) => {
    const appt = row.appointment;
    items.push({
      id: `status-${row.id}`,
      category: "status",
      title: `${name(appt)}: appointment ${String(row.new_status).toLowerCase()}`,
      message: `${appt ? `Appointment on ${fmt(appt.starts_at)}. ` : ""}${row.changed_by_name ? `By ${row.changed_by_name}.` : ""}${row.reason ? ` ${row.reason}` : ""}`,
      at: row.changed_at,
      href: appt && appt.client_id ? `/clients/${appt.client_id}` : "/?view=Confirmed",
      action: "View client",
    });
  });

  // Needs-action first (reschedule, reminders, overdue), then upcoming in time order, then recent changes.
  const order = { reschedule: 0, reminder: 1, followup: 2, lead: 3, appointment: 4, status: 5 };
  return items.sort((a, b) => order[a.category] - order[b.category] || (a.upcoming ? new Date(a.at) - new Date(b.at) : new Date(b.at) - new Date(a.at)));
}

export function readIds() {
  try {
    return new Set(JSON.parse(window.localStorage.getItem(READ_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

export function saveReadIds(ids) {
  try {
    // Keep the list short: only the most recent 500 ids matter.
    window.localStorage.setItem(READ_KEY, JSON.stringify([...ids].slice(-500)));
  } catch {
    // Storage can be unavailable (private mode); read state then lasts for this visit only.
  }
}
