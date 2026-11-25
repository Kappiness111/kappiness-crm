"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import FollowUpsList from "../components/followups/FollowUpsList";
import ReceptionContactList from "../components/followups/ReceptionContactList";
import PageTabs from "../components/PageTabs";
import PsychologistShell from "../components/psychologists/PsychologistShell";
import Toast from "../components/Toast";
import useStaffContext from "../components/scheduling/useStaffContext";

function FollowUpsView() {
  const router = useRouter();
  const params = useSearchParams();
  const { viewer, psychologistNames, notify, toast } = useStaffContext();
  // Two views: the Type A / B follow-ups list (default) and, for staff, reception's contact list (?tab=contacts).
  // FollowUpSessionsPanel (recommendation-based view) is no longer shown here but is kept in the codebase.
  const tabs = [{ id: "follow-ups", label: "Follow-ups" }, ...(viewer.isStaff ? [{ id: "contacts", label: "Reception contacts" }] : [])];
  const requested = params.get("tab");
  const tab = tabs.some((item) => item.id === requested) ? requested : "follow-ups";
  const selectTab = (id) => router.push(id === "follow-ups" ? "/follow-ups" : `/follow-ups?tab=${id}`);
  const openClient = (id) => router.push(`/clients/${id}`);

  return (
    <PsychologistShell activeId="FollowUpSessions" crumbs={[{ label: "Follow-ups" }]}>
      <header className="page-head">
        <div>
          <h1>Follow-ups</h1>
          <p>
            Next sessions and client calls in one place. Overdue items come first. Record calls, messages and reminders here;
            nothing is sent from the CRM.
          </p>
        </div>
      </header>
      <PageTabs items={tabs} activeId={tab} onSelect={selectTab} label="Follow-up views" />
      {tab === "follow-ups" && (
        <FollowUpsList
          key={params.get("focus") || "all"}
          viewer={viewer}
          psychologistNames={psychologistNames}
          notify={notify}
          onOpenClient={openClient}
          initialFocusId={params.get("focus")}
        />
      )}
      {tab === "contacts" && viewer.isStaff && <ReceptionContactList viewer={viewer} psychologistNames={psychologistNames} notify={notify} onOpenClient={openClient} />}
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
