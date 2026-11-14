import { redirect } from "next/navigation";

// Recommendations are now part of Follow-up Sessions.
export default function RecommendationsPage() {
  redirect("/follow-ups");
}
