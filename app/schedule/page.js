"use client";

import { useRouter } from "next/navigation";
import { Suspense } from "react";
import "./schedule.css";
import PageTabs from "../components/PageTabs";
import PsychologistShell from "../components/psychologists/PsychologistShell";
import Toast from "../components/Toast";
import ScheduleBoard from "../components/schedule/ScheduleBoard";
import useStaffContext from "../components/scheduling/useStaffContext";

function ScheduleView() {
  const router = useRouter();
  const { viewer, notify, toast } = useStaffContext();

  return (
    <PsychologistShell activeId="Appointments" crumbs={[{ label: "Appointments", href: "/?view=Appointments" }, { label: "Schedule & capacity" }]}>
      <PageTabs
        label="Appointments"
        activeId="Schedule"
        onSelect={(id) => router.push(id === "Schedule" ? "/schedule" : `/?view=${id}`)}
        items={[
          { id: "Appointments", label: "Calendar" },
          { id: "Confirmed", label: "Appointment list" },
          { id: "Schedule", label: "Schedule & capacity" },
        ]}
      />
      <header className="page-head">
        <div>
          <h1>Psychologist Schedule &amp; Capacity</h1>
          <p>
            Each psychologist&apos;s day as numbered slots: who is booked, which slots are free, who is on leave and how full the
            clinic is. Select a free slot to book it, or a booking to confirm, reschedule or update it.
          </p>
        </div>
      </header>
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
