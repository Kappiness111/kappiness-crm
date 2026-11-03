/* Scheduling configuration: services (duration + buffer) and blocked periods (psychologist_availability_exceptions). */

import { createClient } from "../../utils/supabase/client";

export async function listServices({ activeOnly = false } = {}) {
  const supabase = createClient();
  let query = supabase.from("services").select("*").order("name", { ascending: true });
  if (activeOnly) query = query.eq("is_active", true);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

function servicePayload(values) {
  const payload = {};
  if ("name" in values) payload.name = String(values.name || "").trim();
  if ("duration_minutes" in values) payload.duration_minutes = Number(values.duration_minutes);
  if ("buffer_minutes" in values) payload.buffer_minutes = Number(values.buffer_minutes);
  if ("is_active" in values) payload.is_active = Boolean(values.is_active);
  return payload;
}

export function validateService(values) {
  const errors = {};
  const name = String(values.name || "").trim();
  const duration = Number(values.duration_minutes);
  const buffer = Number(values.buffer_minutes);
  if (name.length < 2) errors.name = "Enter a service name.";
  if (!Number.isInteger(duration) || duration < 10 || duration > 480) errors.duration_minutes = "Use 10 to 480 minutes.";
  if (!Number.isInteger(buffer) || buffer < 0 || buffer > 120) errors.buffer_minutes = "Use 0 to 120 minutes.";
  return errors;
}

export async function createService(values) {
  const supabase = createClient();
  const { data, error } = await supabase.from("services").insert(servicePayload(values)).select("*").single();
  if (error) throw error;
  return data;
}

export async function updateService(id, values) {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("services")
    .update({ ...servicePayload(values), updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

/* ----- blocked periods ----- */

export async function listBlocks({ psychologistId = null, from = null } = {}) {
  const supabase = createClient();
  let query = supabase.from("psychologist_availability_exceptions").select("*").order("starts_at", { ascending: true });
  if (psychologistId) query = query.eq("psychologist_id", psychologistId);
  if (from) query = query.gte("ends_at", new Date(from).toISOString());
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

// Active appointments inside the period. Shown before blocking; the database refuses the block while any exist.
export async function blockConflicts(psychologistId, startsAt, endsAt) {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("availability_block_conflicts", {
    p_psychologist_id: psychologistId,
    p_starts_at: new Date(startsAt).toISOString(),
    p_ends_at: new Date(endsAt).toISOString(),
  });
  if (error) throw error;
  return data || [];
}

export async function addBlock(psychologistId, startsAt, endsAt, reason = "") {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("add_availability_block", {
    p_psychologist_id: psychologistId,
    p_starts_at: new Date(startsAt).toISOString(),
    p_ends_at: new Date(endsAt).toISOString(),
    p_reason: reason || null,
  });
  if (error) throw error;
  return data;
}

export async function removeBlock(id) {
  const supabase = createClient();
  const { error } = await supabase.from("psychologist_availability_exceptions").delete().eq("id", id);
  if (error) throw error;
}
