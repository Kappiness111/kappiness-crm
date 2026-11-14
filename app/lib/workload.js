/* Psychologist workload, counted from real records (staff access through RLS):
     clients    active clients whose primary psychologist this is
     upcoming   booked appointments (Scheduled or Confirmed) from now on
     followUps  follow-ups recommended or booked and still open (Open or Scheduled) */

import { ACTIVE_APPOINTMENT_STATUSES, listAppointments } from "./appointmentsApi";
import { listClients } from "./clientsApi";
import { listRecommendations } from "./sessionsApi";

export async function loadWorkload({ psychologistId = null } = {}) {
  const [clients, upcoming, followUps] = await Promise.all([
    listClients({ psychologistId }),
    listAppointments({ from: new Date(), statuses: ACTIVE_APPOINTMENT_STATUSES, psychologistId }),
    listRecommendations({ psychologistId, statuses: ["Open", "Scheduled"] }),
  ]);
  const byId = {};
  const entry = (id) => (byId[id] = byId[id] || { clients: 0, upcoming: 0, followUps: 0 });
  clients.filter((item) => item.is_active).forEach((item) => (entry(item.primary_psychologist_id).clients += 1));
  upcoming.forEach((item) => (entry(item.psychologist_id).upcoming += 1));
  followUps.forEach((item) => (entry(item.psychologist_id).followUps += 1));
  return { byId, clients, upcoming, followUps };
}
