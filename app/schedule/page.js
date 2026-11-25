"use client";

import { useRouter } from "next/navigation";
import { Suspense } from "react";
import PageHeader from "../components/ui/PageHeader";
import PsychologistShell from "../components/psychologists/PsychologistShell";
import Toast from "../components/Toast";
import ScheduleBoard from "../components/schedule/ScheduleBoard";
import useStaffContext from "../components/scheduling/useStaffContext";

function ScheduleView() {
  const router = useRouter();
  const { viewer, notify, toast } = useStaffContext();

  return (
    <PsychologistShell activeId="Availability" crumbs={[{ label: "Availability & Leave" }]}>
      <PageHeader
        title="Availability, Leave & Capacity"
        description="Each psychologist's day as numbered slots: who is booked, which slots are free, who is on leave and how full the clinic is. Select a free slot to book it, a booking to confirm or reschedule it, or a psychologist to mark leave. Weekly working hours are set on each psychologist's profile."
      />
      <ScheduleBoard viewer={viewer} notify={notify} onOpenClient={(id) => router.push(`/clients/${id}`)} />
      <Toast toast={toast} />
    </PsychologistShell>
  );
}

export default function SchedulePage() {
  return (
    <Suspense fallback={null}>
      <ScheduleView />
    </Suspense>
  );
}
