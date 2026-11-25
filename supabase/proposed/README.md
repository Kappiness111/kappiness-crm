# Proposed database changes (not applied)

Files here are **not** live and are kept out of `supabase/migrations/` so the Supabase CLI never treats them as
pending. Each one needs review by the backend owner before it is applied, and then moves into `migrations/` with
the status table in `migrations/README.md` updated.

| File | Owner | Reviewer | What it does |
|------|-------|----------|--------------|
| `202611240001_dashboard_views.sql` | Aavani | Aswathy | Four read-only, SECURITY INVOKER views for the main dashboard counts: `dashboard_appointment_daily`, `dashboard_lead_daily`, `dashboard_follow_up_calls`, `dashboard_leave_daily`. No tables, columns, policies or functions change. Select is granted to `authenticated` only. |

Until the views are applied, the dashboard calculates the same counts in the browser (`app/lib/dashboardApi.js`
returns null when a view is missing). Tested on a local Postgres with sample rows: clinic-day (Asia/Kolkata)
rollover, Lost leads excluded from follow-up calls, full-day vs part-day leave, `security_invoker=true` on all four.
