"use client";

import { useRouter } from "next/navigation";
import { Suspense } from "react";
import PageTabs from "../components/PageTabs";
import PsychologistShell from "../components/psychologists/PsychologistShell";
import { APPOINTMENT_TABS } from "../lib/navigation";
import SessionsPanel from "../components/sessions/SessionsPanel";
import Toast from "../components/Toast";
import useStaffContext from "../components/scheduling/useStaffContext";

function SessionsView() {
  const router = useRouter();
  const { viewer, psychologistNames, notify, toast } = useStaffContext();

  return (
    <PsychologistShell activeId="Appointments" crumbs={[{ label: "Appointments", href: "/?view=Appointments" }, { label: "Sessions" }]}>
      <PageTabs
        label="Appointments"
        activeId="Sessions"
        onSelect={(id) => router.push(id === "Sessions" ? "/sessions" : `/?view=${id}`)}
        items={APPOINTMENT_TABS}
      />
      <header className="page-head">
        <div>
          <h1>Sessions</h1>
          <p>What happened at each appointment. Record attendance after the start time; nothing is deleted.</p>
        </div>
      </header>
      <SessionsPanel viewer={viewer} psychologistNames={psychologistNames} notify={notify} onOpenClient={(id) => router.push(`/clients/${id}`)} />
      <Toast toast={toast} />
    </PsychologistShell>
  );
}

export default function SessionsPage() {
  return (
    <Suspense fallback={null}>
      <SessionsView />
    </Suspense>
  );
}
