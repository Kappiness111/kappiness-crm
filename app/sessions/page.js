"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import DailyChecklist from "../components/checklist/DailyChecklist";
import PageTabs from "../components/PageTabs";
import PsychologistShell from "../components/psychologists/PsychologistShell";
import SessionsPanel from "../components/sessions/SessionsPanel";
import Toast from "../components/Toast";
import useStaffContext from "../components/scheduling/useStaffContext";

function SessionsView() {
  const router = useRouter();
  const params = useSearchParams();
  const { viewer, psychologistNames, notify, toast } = useStaffContext();
  // ?tab=checklist shows the daily session checklist; the sessions list stays the default.
  const tab = params.get("tab") === "checklist" ? "checklist" : "sessions";
  const tabs = [
    { id: "sessions", label: "Sessions" },
    { id: "checklist", label: "Daily checklist" },
  ];

  return (
    <PsychologistShell activeId="Sessions" crumbs={[{ label: "Sessions" }]}>
      <header className="page-head">
        <div>
          <h1>Sessions</h1>
          <p>What happened at each appointment. Record attendance after the start time; nothing is deleted.</p>
        </div>
      </header>
      <PageTabs items={tabs} activeId={tab} onSelect={(id) => router.push(id === "checklist" ? "/sessions?tab=checklist" : "/sessions")} label="Session views" />
      {tab === "sessions" && (
        <SessionsPanel viewer={viewer} psychologistNames={psychologistNames} notify={notify} onOpenClient={(id) => router.push(`/clients/${id}`)} />
      )}
      {tab === "checklist" && <DailyChecklist viewer={viewer} psychologistNames={psychologistNames} notify={notify} />}
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
