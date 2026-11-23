# Superseded test suites: kept for history, not run

Moved here from `supabase/tests/` with their contents unchanged, following the same convention as
`supabase/migrations_superseded/`.

| File | Moved | Why |
|---|---|---|
| `lead_workflow_test.sql` | 23 Nov 2026 (Day 21) | It pins the pre-Day-21 lead workflow: the five statuses (Enquiry, Yet to Confirm, Will Inform, Confirmed, Lost), their transition matrix, and the md5 fingerprints of `update_lead_with_history` from `202611030002` (`2dc29d7e…`) and `enforce_lead_workflow` from `202611040001` (`a1a07bca…`). After `20261123161850_lead_status_workflow_eight_statuses.sql`, its T0 always fails by design. `supabase/tests/lead_status_workflow_test.sql` replaces it. That suite also took over the old checks that are not about statuses: the five-event limit, follow-up date set, clear and invalid, malformed `changes` / `events`, the status-event rules and non-member / psychologist access. |

The retired suite is still the right check for a database **before** Day 21, or after the Day 21 rollback
(`supabase/deploy/20261123150448_ROLLBACK_reference.sql`): there it passes and proves that the original function
bodies were restored byte-for-byte. Run it only on a disposable database, like every suite here.
