"use client";

import { useRouter } from "next/navigation";
import AppShell from "../AppShell";
import useCurrentUser from "./useCurrentUser";
import NotificationCenter from "../notifications/NotificationCenter";
import { CRM_NAV, crmHref, roleLabel } from "../../lib/navigation";

/* Frame for the /psychologists routes: the same CRM shell and navigation as the rest of the staff workspace.
   Other CRM views open on "/" with ?view=..., so the sidebar behaves the same on every page. */

const NAV = CRM_NAV.map((item) => ({ ...item, href: crmHref(item.id) }));

export default function PsychologistShell({ crumbs = [], activeId = "Psychologists", children }) {
  const router = useRouter();
  const { name, email, role } = useCurrentUser();

  const trail = [
    { label: "Dashboard", onClick: () => router.push("/") },
    ...crumbs.map((crumb) => ({ label: crumb.label, onClick: crumb.href ? () => router.push(crumb.href) : undefined })),
  ];

  return (
    <AppShell
      nav={NAV}
      activeId={activeId}
      workspaceLabel="Client relations"
      crumbs={trail}
      headerActions={role === "psychologist" ? null : <NotificationCenter onNavigate={(href) => router.push(href)} />}
      user={{ name, email, roleLabel: roleLabel(role) }}
    >
      {children}
    </AppShell>
  );
}
