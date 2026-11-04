"use client";

import { useRouter } from "next/navigation";
import { Suspense } from "react";
import PsychologistShell from "../components/psychologists/PsychologistShell";
import SessionsPanel from "../components/sessions/SessionsPanel";
import Toast from "../components/Toast";
import useStaffContext from "../components/scheduling/useStaffContext";

function SessionsView() {
  const router = useRouter();
  const { viewer, psychologistNames, notify, toast } = useStaffContext();

  return (
    <PsychologistShell activeId="Sessions" crumbs={[{ label: "Sessions" }]}>
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
