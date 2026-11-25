"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import DailyChecklist from "../components/checklist/DailyChecklist";
import SessionHistory from "../components/checklist/SessionHistory";
import PageTabs from "../components/PageTabs";
import PsychologistShell from "../components/psychologists/PsychologistShell";
import { APPOINTMENT_TABS } from "../lib/navigation";
import Toast from "../components/Toast";
import useStaffContext from "../components/scheduling/useStaffContext";

function SessionsView() {
  const router = useRouter();
  const params = useSearchParams();
  const { viewer, psychologistNames, notify, toast } = useStaffContext();
  const view = params.get("tab") === "history" ? "history" : "daily";
  const tabs = [
    { id: "daily", label: "Daily Sessions" },
    { id: "history", label: "Session History" },
  ];

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
          <h1>Session Management</h1>
          <p>{view === "history" ? "Find and review appointment records." : "Manage today’s sessions and progress."}</p>
        </div>
      </header>
      <PageTabs
        items={tabs}
        activeId={view}
        onSelect={(id) => router.push(id === "history" ? "/sessions?tab=history" : "/sessions")}
        label="Session views"
      />
      {view === "history" ? (
        <SessionHistory
          viewer={viewer}
          psychologistNames={psychologistNames}
          notify={notify}
          onOpenClient={(id) => router.push(`/clients/${id}`)}
        />
      ) : (
        <DailyChecklist
          viewer={viewer}
          psychologistNames={psychologistNames}
          notify={notify}
          onOpenClient={(id) => router.push(`/clients/${id}`)}
          sessionManagement
        />
      )}
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
