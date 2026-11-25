import { createClient } from "../../utils/supabase/client";

export async function listSessionFollowUpFlags(sessionIds) {
  const ids = [...new Set(sessionIds.filter(Boolean))];
  if (!ids.length) return {};
  const supabase = createClient();
  const flags = {};
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await supabase
      .from("session_follow_up_decisions")
      .select("session_id, follow_up_required, follow_up_date")
      .in("session_id", ids.slice(i, i + 150));
    if (error) throw error;
    (data || []).forEach((row) => {
      flags[row.session_id] = { required: row.follow_up_required, date: row.follow_up_date };
    });
  }
  return flags;
}

export async function listAppointmentSessionNumbers(appointmentIds) {
  const ids = [...new Set(appointmentIds.filter(Boolean))];
  if (!ids.length) return {};
  const supabase = createClient();
  const numbers = {};
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await supabase
      .from("follow_ups")
      .select("appointment_id, session_number")
      .in("appointment_id", ids.slice(i, i + 150));
    if (error) throw error;
    (data || []).forEach((row) => {
      if (row.appointment_id && row.session_number) numbers[row.appointment_id] = row.session_number;
    });
  }
  return numbers;
}

export async function getSessionFollowUpDecision(sessionId) {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("get_session_follow_up_decision", { p_session_id: sessionId });
  if (error) throw error;
  return Array.isArray(data) ? data[0] || null : data;
}

export async function saveSessionFollowUpDecision(sessionId, values) {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("record_session_follow_up_decision", {
    p_session_id: sessionId,
    p_follow_up_required: values.followUpRequired,
    p_follow_up_purpose: values.purpose || null,
    p_follow_up_date: values.date || null,
    p_follow_up_details: values.details || null,
  });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

export async function setChecklistNotApplicable(appointmentId, stepId, reason) {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("set_session_checklist_not_applicable", {
    p_appointment_id: appointmentId,
    p_step_id: stepId,
    p_reason: reason || null,
  });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}
