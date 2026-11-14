"use client";

import { useRouter } from "next/navigation";
import PageTabs from "../PageTabs";

// Psychologists | Services: Services (session length and buffer) lives under Psychologists.
export default function PsychologistsTabs({ active }) {
  const router = useRouter();
  return (
    <PageTabs
      label="Psychologists"
      activeId={active}
      onSelect={(id) => router.push(id === "services" ? "/services" : "/psychologists")}
      items={[
        { id: "psychologists", label: "Psychologists" },
        { id: "services", label: "Services" },
      ]}
    />
  );
}
