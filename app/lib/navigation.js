/* Navigation for the two workspaces. One definition per workspace, used by every page that renders it. */

// Staff CRM. Views without an href live on "/" and are opened with ?view=<id>.
export const CRM_NAV = [
  { id: "Dashboard", label: "Dashboard", icon: "dashboard", section: "Workspace" },
  { id: "Leads", label: "Leads", icon: "users", section: "Workspace" },
  { id: "Clients", label: "Clients", icon: "user", section: "Workspace", href: "/clients" },
  { id: "Follow Ups", label: "Follow-ups", icon: "clock", section: "Workspace" },
  { id: "Appointments", label: "Appointments", icon: "calendar", section: "Scheduling" },
  { id: "Confirmed", label: "Confirmed", icon: "calendarCheck", section: "Scheduling" },
  { id: "Sessions", label: "Sessions", icon: "clipboard", section: "Scheduling", href: "/sessions" },
  { id: "Recommendations", label: "Recommendations", icon: "note", section: "Scheduling", href: "/recommendations" },
  { id: "Psychologists", label: "Psychologists", icon: "userCheck", section: "Management", href: "/psychologists" },
  { id: "Services", label: "Services", icon: "settings", section: "Management", href: "/services" },
  { id: "Reports", label: "Reports", icon: "chart", section: "Management" },
];

export const CRM_VIEWS = CRM_NAV.filter((item) => !item.href).map((item) => item.id);

// Where a CRM nav item lives when you are on another route (for example /psychologists).
export function crmHref(id) {
  const item = CRM_NAV.find((entry) => entry.id === id);
  if (item && item.href) return item.href;
  return id === "Dashboard" ? "/" : `/?view=${encodeURIComponent(id)}`;
}

// Psychologist workspace (/psychologist). Sections switch in place (?section=<id>).
export const PSYCHOLOGIST_NAV = [
  { id: "dashboard", label: "Overview", icon: "dashboard", section: "My workspace" },
  { id: "clients", label: "My clients", icon: "user", section: "My workspace" },
  { id: "calendar", label: "Appointments", icon: "calendar", section: "My workspace" },
  { id: "sessions", label: "Sessions", icon: "clipboard", section: "My workspace" },
  { id: "availability", label: "My availability", icon: "clock", section: "My workspace" },
  { id: "recommendations", label: "Recommendations", icon: "note", section: "My workspace" },
  { id: "profile", label: "Profile", icon: "user", section: "Account" },
];

export function roleLabel(role) {
  if (role === "admin") return "Administrator";
  if (role === "psychologist") return "Psychologist";
  return "Staff";
}
