/* Supabase queries for the Psychologist Management module.
   Only the existing `psychologists` and `psychologist_availability` tables are used.
   Every call goes through the signed-in user's session, so Row Level Security decides access. */

import { createClient } from "../../utils/supabase/client";
import { mapPsychologist, resolveColumns, toHHMM, toPsychologistPayload } from "./psychologists";

const AVAILABILITY_COLUMNS = "id, psychologist_id, day_of_week, start_time, end_time, is_active, created_at";

function mapAvailability(row) {
  return { ...row, start_time: toHHMM(row.start_time), end_time: toHHMM(row.end_time), day_of_week: Number(row.day_of_week) };
}

export async function listPsychologists() {
  const supabase = createClient();
  const { data, error } = await supabase.from("psychologists").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error("Supabase returned an invalid psychologists response.");
  if (data.length > 0) resolveColumns(data[0]);
  return data.map(mapPsychologist);
}

export async function getPsychologist(id) {
  const supabase = createClient();
  const { data, error } = await supabase.from("psychologists").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  resolveColumns(data);
  return mapPsychologist(data);
}

export async function createPsychologist(values) {
  const supabase = createClient();
  const { data, error } = await supabase.from("psychologists").insert(toPsychologistPayload(values)).select("*").single();
  if (error) throw error;
  resolveColumns(data);
  return mapPsychologist(data);
}

// values may hold any subset of { name, phone, active }.
export async function updatePsychologist(id, values) {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("psychologists")
    .update(toPsychologistPayload(values))
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return mapPsychologist(data);
}

// Availability of every psychologist the user is allowed to read (used for the table summary).
export async function listAllAvailability() {
  const supabase = createClient();
  const { data, error } = await supabase.from("psychologist_availability").select(AVAILABILITY_COLUMNS);
  if (error) throw error;
  return (data || []).map(mapAvailability);
}

export async function listAvailability(psychologistId) {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("psychologist_availability")
    .select(AVAILABILITY_COLUMNS)
    .eq("psychologist_id", psychologistId)
    .order("day_of_week", { ascending: true })
    .order("start_time", { ascending: true });
  if (error) throw error;
  return (data || []).map(mapAvailability);
}

export async function createAvailability(psychologistId, values) {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("psychologist_availability")
    .insert({
      psychologist_id: psychologistId,
      day_of_week: Number(values.day_of_week),
      start_time: values.start_time,
      end_time: values.end_time,
      is_active: Boolean(values.is_active),
    })
    .select(AVAILABILITY_COLUMNS)
    .single();
  if (error) throw error;
  return mapAvailability(data);
}

// values may hold any subset of { day_of_week, start_time, end_time, is_active }.
export async function updateAvailability(id, values) {
  const payload = {};
  if ("day_of_week" in values) payload.day_of_week = Number(values.day_of_week);
  if ("start_time" in values) payload.start_time = values.start_time;
  if ("end_time" in values) payload.end_time = values.end_time;
  if ("is_active" in values) payload.is_active = Boolean(values.is_active);

  const supabase = createClient();
  const { data, error } = await supabase
    .from("psychologist_availability")
    .update(payload)
    .eq("id", id)
    .select(AVAILABILITY_COLUMNS)
    .single();
  if (error) throw error;
  return mapAvailability(data);
}