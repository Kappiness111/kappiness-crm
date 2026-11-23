/* Navigation for the two workspaces. One definition per workspace, used by every page that renders it. */

// Staff CRM: the eight top-level sections. Views without an href live on "/" and are opened with ?view=<id>.
// `views` lists extra "/" views that belong to a section (shown as tabs inside it, highlighted under it).
export const CRM_NAV = [
  { id: "Dashboard", label: "Dashboard", icon: "dashboard", section: "Workspace" },
  { id: "Leads", label: "Leads", icon: "users", section: "Workspace", views: ["Follow Ups"] },
  { id: "Appointments", label: "Appointments", icon: "calendar", section: "Scheduling", views: ["Confirmed"] },
  { id: "Clients", label: "Confirmed Clients", icon: "user", section: "Scheduling", href: "/clients" },
  { id: "Sessions", label: "Sessions", icon: "clipboard", section: "Scheduling", href: "/sessions" },
  { id: "FollowUpSessions", label: "Follow-up Sessions", icon: "note", section: "Scheduling", href: "/follow-ups" },
  { id: "Psychologists", label: "Psychologists", icon: "userCheck", section: "Management", href: "/psychologists" },
  { id: "Reports", label: "Reports", icon: "chart", section: "Management" },
];

// Every view the "/" page can show: the sections without an href plus their extra views.
export const CRM_VIEWS = CRM_NAV.filter((item) => !item.href).flatMap((item) => [item.id, ...(item.views || [])]);

// The sidebar item to highlight for a "/" view (for example "Follow Ups" -> "Leads").
export function crmSectionOf(view) {
  const owner = CRM_NAV.find((item) => item.id === view || (item.views || []).includes(view));
  return owner ? owner.id : view;
}

// Where a CRM nav item or view lives when you are on another route (for example /psychologists).
export function crmHref(id) {
  const item = CRM_NAV.find((entry) => entry.id === id);
  if (item && item.href) return item.href;
  return id === "Dashboard" ? "/" : `/?view=${encodeURIComponent(id)}`;
}

// Psychologist workspace (/psychologist). Sections switch in place (?section=<id>).
export const PSYCHOLOGIST_NAV = [
  { id: "dashboard", label: "My day", icon: "dashboard", section: "My workspace" },
  { id: "clients", label: "My clients", icon: "user", section: "My workspace" },
  { id: "calendar", label: "Calendar", icon: "calendar", section: "My workspace" },
  { id: "sessions", label: "Sessions", icon: "clipboard", section: "My workspace" },
  { id: "recommendations", label: "Follow-ups", icon: "note", section: "My workspace" },
  { id: "availability", label: "My availability", icon: "clock", section: "My workspace" },
  { id: "profile", label: "My profile", icon: "user", section: "Account" },
];

export function roleLabel(role) {
  if (role === "admin") return "Administrator";
  if (role === "psychologist") return "Psychologist";
  return "Staff";
}
