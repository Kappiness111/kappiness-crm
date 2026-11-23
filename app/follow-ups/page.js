"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import FollowUpSessionsPanel from "../components/followups/FollowUpSessionsPanel";
import PsychologistShell from "../components/psychologists/PsychologistShell";
import Toast from "../components/Toast";
import useStaffContext from "../components/scheduling/useStaffContext";

function FollowUpsView() {
  const router = useRouter();
  const params = useSearchParams();
  const { viewer, psychologistNames, notify, toast } = useStaffContext();

  return (
    <PsychologistShell activeId="FollowUpSessions" crumbs={[{ label: "Follow-up Sessions" }]}>
      <header className="page-head">
        <div>
          <h1>Follow-up Sessions</h1>
          <p>
            Follow-ups recommended by psychologists, their bookings, and the two reminders for each booking. Record reminder
            delivery and client responses here; nothing is sent from the CRM.
          </p>
        </div>
      </header>
      <FollowUpSessionsPanel
        key={params.get("focus") || "all"}
        viewer={viewer}
        psychologistNames={psychologistNames}
        notify={notify}
        initialFocusId={params.get("focus")}
        onOpenClient={(id) => router.push(`/clients/${id}`)}
      />
      <Toast toast={toast} />
    </PsychologistShell>
  );
}

export default function FollowUpSessionsPage() {
  return (
    <Suspense fallback={null}>
      <FollowUpsView />
    </Suspense>
  );
}
