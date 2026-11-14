"use client";

import { useRouter } from "next/navigation";
import { Suspense } from "react";
import ClientList from "../components/clients/ClientList";
import PsychologistShell from "../components/psychologists/PsychologistShell";
import Toast from "../components/Toast";
import useStaffContext from "../components/scheduling/useStaffContext";

function ClientsView() {
  const router = useRouter();
  const { psychologistNames, toast } = useStaffContext();

  return (
    <PsychologistShell activeId="Clients" crumbs={[{ label: "Confirmed Clients" }]}>
      <header className="page-head">
        <div>
          <h1>Confirmed Clients</h1>
          <p>
            Everyone who has become a client (a lead set to Confirmed with a psychologist). Open a client to see their appointments,
            sessions and follow-ups. A client being confirmed is separate from an appointment being confirmed by the client.
          </p>
        </div>
      </header>
      <ClientList psychologistNames={psychologistNames} onOpen={(client) => router.push(`/clients/${client.id}`)} />
      <Toast toast={toast} />
    </PsychologistShell>
  );
}

export default function ClientsPage() {
  return (
    <Suspense fallback={null}>
      <ClientsView />
    </Suspense>
  );
}
