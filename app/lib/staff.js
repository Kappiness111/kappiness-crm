// Works out a display name for the logged-in Supabase user.
export function getStaffName(user) {
  if (!user) return "";
  const meta = user.user_metadata || {};
  const fromMeta = (meta.full_name || meta.name || "").trim();
  if (fromMeta) return fromMeta;

  const local = (user.email || "").split("@")[0].replace(/[._-]+/g, " ").trim();
  return local
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// Role comes from app_metadata.role, which users cannot edit. Row Level Security is the real enforcement.
export function getStaffRole(user) {
  const role = user && user.app_metadata && user.app_metadata.role;
  return typeof role === "string" ? role.trim().toLowerCase() : "";
}

// Who may change lead and appointment statuses. Psychologists are read-only here.
export function canUpdateStatuses(role) {
  return role !== "psychologist";
}