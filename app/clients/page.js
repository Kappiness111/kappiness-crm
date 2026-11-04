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
    <PsychologistShell activeId="Clients" crumbs={[{ label: "Clients" }]}>
      <header className="page-head">
        <div>
          <h1>Clients</h1>
          <p>Confirmed leads become clients automatically. Each client has one primary psychologist.</p>
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
