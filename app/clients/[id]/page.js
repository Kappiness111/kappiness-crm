"use client";

import { useParams, useRouter } from "next/navigation";
import { Suspense } from "react";
import ClientDetails from "../../components/clients/ClientDetails";
import PsychologistShell from "../../components/psychologists/PsychologistShell";
import Toast from "../../components/Toast";
import useStaffContext from "../../components/scheduling/useStaffContext";

function ClientView() {
  const router = useRouter();
  const params = useParams();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const { viewer, psychologists, notify, toast } = useStaffContext();

  return (
    <PsychologistShell activeId="Clients" crumbs={[{ label: "Confirmed Clients", href: "/clients" }, { label: "Client profile" }]}>
      <ClientDetails
        key={id}
        clientId={id}
        viewer={viewer}
        psychologists={psychologists}
        notify={notify}
        onBack={() => router.push("/clients")}
        onOpenLead={(leadId) => router.push(`/?view=Leads&lead=${encodeURIComponent(leadId)}`)}
      />
      <Toast toast={toast} />
    </PsychologistShell>
  );
}

export default function ClientPage() {
  return (
    <Suspense fallback={null}>
      <ClientView />
    </Suspense>
  );
}
