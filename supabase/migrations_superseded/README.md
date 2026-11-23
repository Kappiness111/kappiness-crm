# Superseded migrations: never apply these

These four files were moved here from `supabase/migrations/` on 13 Nov 2026, with their contents unchanged (identical git blobs). **None of them was ever executed on the MAIN project.** They live outside `supabase/migrations/` so that the Supabase CLI (`supabase migration list`, `supabase db push`) no longer sees them as pending, and so they can never be recorded in migration history by mistake.

They are kept only as history and for reference. Do not run them anywhere connected to production, do not move them back, and do not record them with `supabase migration repair`.

| File | Status | Why |
|---|---|---|
| `202611040002_restrict_lead_access_to_staff.sql` | **Redundant, not applied** | Adds `leads_staff_only` / `lead_activities_staff_only` (RESTRICTIVE, `is_crm_staff()`). Production already enforces the same rule with the RESTRICTIVE "Require active CRM staff membership" policies from `202611030001`, which check `crm_staff_members` directly. Applying it now would only add duplicate policies. |
| `202611040003_role_helpers_use_staff_membership.sql` | **Superseded by `202611130001`, not applied** | Membership-based `is_crm_staff()` / `is_crm_admin()`. `202611130001` installed byte-identical function bodies, settings and grants (production md5 `118729f2…` / `ffeeb94c…`, the same as this file produces); only the function comments differ. |
| `202611040004_preserve_live_lead_function.sql` | **MUST NEVER BE APPLIED** | Replaces production's `update_lead_with_history` (md5 `2dc29d7e…`, from `202611030002`) with an older body (`0d07f2cc…`) that allows at most **4** history events. The lead drawer (`app/components/LeadDetailsModal.js`, `describeChanges`) can send **5**, so applying it would break lead saves. Its stricter checks are already enforced on every write path by the `enforce_lead_workflow` trigger from `202611040001`. |
| `202611040005_psychologist_availability_security.sql` | **Superseded by `202611130001`, not applied** | `is_own_psychologist(uuid)`, the restrictive `availability_require_staff_or_owner` policy and the availability privilege revokes. `202611130001` installed the same function (production md5 `09629c62…`, the same as this file produces), the same policy and the same revokes, plus extra hardening on `psychologists` and `services`; only the function comment differs. |

## Related retired file

`supabase/deploy/retired/202611040005_atomic_bundle.sql` combined `202611030002`, `202611040001`, `202611040003`, `202611040004` and `202611040005` into one transaction. It is retired: production received `202611030002` and `202611040001` by hand, and the remaining fixes through `supabase/deploy/202611130003_02_production_deploy.sql`. The retired bundle now aborts as its first action inside its transaction, and `scripts/build-deploy-bundle.mjs` refuses to rebuild it.

## Production migration history (to be reconciled separately)

Only `202610240001`, `202611030001`, `202611030002`, `202611040001`, `202611130001` and `202611130002` belong in production's migration history. See the reconciliation in `supabase/migrations/README.md`.
