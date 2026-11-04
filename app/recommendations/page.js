"use client";

import { useRouter } from "next/navigation";
import { Suspense } from "react";
import PsychologistShell from "../components/psychologists/PsychologistShell";
import RecommendationsPanel from "../components/sessions/RecommendationsPanel";
import Toast from "../components/Toast";
import useStaffContext from "../components/scheduling/useStaffContext";

function RecommendationsView() {
  const router = useRouter();
  const { viewer, psychologistNames, notify, toast } = useStaffContext();

  return (
    <PsychologistShell activeId="Recommendations" crumbs={[{ label: "Follow-up recommendations" }]}>
      <header className="page-head">
        <div>
          <h1>Follow-up recommendations</h1>
          <p>Recommended by psychologists after sessions. Book them through the normal appointment process, then close them with an outcome.</p>
        </div>
      </header>
      <RecommendationsPanel viewer={viewer} psychologistNames={psychologistNames} notify={notify} onOpenClient={(id) => router.push(`/clients/${id}`)} />
      <Toast toast={toast} />
    </PsychologistShell>
  );
}

export default function RecommendationsPage() {
  return (
    <Suspense fallback={null}>
      <RecommendationsView />
    </Suspense>
  );
}
