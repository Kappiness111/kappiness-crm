-- Kappiness CRM production deployment 202611130003: ADMIN ACCESS FOR THE ACTIVE STAFF MEMBERS.
-- Statements only (no transaction control). Edit here, then run  node scripts/build-production-deploy.mjs
-- Embedded in 202611130003_02_production_deploy.sql right after the 202611130001 remediation (so is_crm_admin()
-- is already membership-based), inside the single deployment transaction.
--
-- DECISION (13 Nov 2026): all 4 active staff members get access_level = 'admin'.
-- Changes ONLY public.crm_staff_members.access_level of ACTIVE rows. user_id, is_active, created_at, created_by,
-- inactive rows, psychologist profiles and every other table are untouched; the deployment verifies that with a
-- before/after content fingerprint of all 15 existing tables and rolls everything back on any difference.
--
-- Effect of admin (membership-based is_crm_admin()): read and write clinical session notes of every session,
-- and change reminder timing (set_reminder_offsets).

-- Block concurrent membership writes (reads continue) until COMMIT, so the count below cannot change underneath.
LOCK TABLE public.crm_staff_members IN SHARE ROW EXCLUSIVE MODE;

DO $admin$
DECLARE
  n_active integer;
  n_inactive integer;
  n_changed integer;
  n_admin integer;
BEGIN
  SELECT count(*) FILTER (WHERE is_active), count(*) FILTER (WHERE NOT is_active)
    INTO n_active, n_inactive
  FROM public.crm_staff_members;

  IF n_active IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'ADMIN ASSIGNMENT ABORTED: expected exactly 4 active staff memberships, found %. The whole deployment is rolled back.',
      n_active;
  END IF;

  UPDATE public.crm_staff_members
     SET access_level = 'admin'
   WHERE is_active = true
     AND access_level IS DISTINCT FROM 'admin';
  GET DIAGNOSTICS n_changed = ROW_COUNT;

  SELECT count(*) INTO n_admin FROM public.crm_staff_members WHERE is_active = true AND access_level = 'admin';
  IF n_admin IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'ADMIN ASSIGNMENT FAILED: % of 4 active memberships are admin after the update.', n_admin;
  END IF;

  RAISE NOTICE 'Admin access: 4 active memberships are admin (% changed, % already admin); % inactive membership(s) untouched.',
    n_changed, 4 - n_changed, n_inactive;
END
$admin$;
