-- Kappiness CRM: PRODUCTION DEPLOYMENT 202611130003 = security remediation + admin access for the 4 active
-- staff members + appointment reminder tracking.
-- GENERATED FILE: DO NOT EDIT. Regenerate with: node scripts/build-production-deploy.mjs (verify with --check)
-- Sources (sha256 with LF line endings):
--   supabase/migrations/202611130001_remediate_role_helpers_and_availability.sql  c4a81f279e2636a13301a88aea0357727e467afadb0678a1454fce3510ad7040
--   supabase/migrations/202611130002_appointment_reminders.sql  7db1cb568e5a80065e5d817fcd504240e36121958637b484f139cf6277203d52
--   supabase/deploy/parts/202611130003_preflight_checks.sql  549cb938eadd218627ebb5395c296242cc561e27a9416c8ab618705e949088a1
--   supabase/deploy/parts/202611130003_admin_assignment.sql  a779e02558ab32668a6213aec7edb8aaf31ecaf14fe55f133041fc0faf8ec2f5
--   supabase/deploy/parts/202611130003_behaviour_checks.sql  694c8d5c93828477e0248443391e89e853b6f9d540ceebf42b7fca126e19975a
--   supabase/deploy/parts/202611130003_postdeploy_checks.sql  5af5882929f3d73bb5c2b09d19409ec0ec266d96e203b55cab61444d34dfb9c2
--
-- WHAT IT DOES (one transaction; any error rolls back EVERYTHING, so production is either fully deployed or
-- exactly as before):
--   PART 0  strict preflight: fingerprints of 15 functions, exact table/trigger/policy/column sets, status
--           vocabulary, no FORCE RLS, owners, EXACTLY 4 active staff, 0 accounts losing access, not deployed.
--           Then a content fingerprint of the 15 existing tables.
--   PART 1  supabase/migrations/202611130001_remediate_role_helpers_and_availability.sql
--   PART 2  supabase/deploy/parts/202611130003_admin_assignment.sql (4 active memberships -> admin)
--   PART 3  supabase/migrations/202611130002_appointment_reminders.sql
--   PART 4  behaviour checks with simulated logins (anon, stranger, staff, admins, psychologist). Writes nothing.
--   PART 5  strict post-deployment checks + content of the 15 existing tables unchanged (except active
--           crm_staff_members.access_level).
--
-- HOW TO RUN: supabase/migrations/README.md, section "Production deployment 202611130003".
--   Supabase Dashboard > MAIN project > SQL Editor > New query > paste this WHOLE file > Run (whole script,
--   nothing selected). Confirm the destructive-operation prompt (DROP POLICY IF EXISTS / REVOKE).
--   Success: "Success. No rows returned". Any red error: nothing was changed.
-- Do NOT run twice: the preflight refuses a second run (is_crm_staff fingerprint, objects already present).
-- Do NOT use supabase db push.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ====================================================================================================
-- PART 0: PREFLIGHT (strict). Source: supabase/deploy/parts/202611130003_preflight_checks.sql
-- ====================================================================================================

DO $preflight$
DECLARE
  deploy_check record;  -- name chosen so it cannot collide with aliases inside the query
  failures text := '';
  passed integer := 0;
BEGIN
  FOR deploy_check IN
    -- Kappiness CRM production deployment 202611130003: PREFLIGHT CHECKS.
    -- ONE read-only SELECT returning (check_name, expected, actual, ok). Edit here, then run
    --   node scripts/build-production-deploy.mjs
    -- It is embedded twice: as a table in 202611130003_01_preflight_report.sql, and as a strict check at the top of
    -- 202611130003_02_production_deploy.sql (any ok = false aborts the transaction before anything changes).
    -- No client or patient record content is read: only catalog data, function fingerprints and counts.
    --
    -- Fingerprint = md5 of pg_proc.prosrc with carriage returns removed.
    --   AUDITED  values were read from production on 13 Nov 2026.
    --   REPO     values come from 202611040001 as committed; the four audited ones match the repo exactly, which
    --            shows production was built from these files. A mismatch means production changed: stop and review.
    WITH expected_fp(fn, md5, source) AS (
      VALUES
        ('public.is_crm_staff()',                                                   '927078351f956d8e482743322e0f2b22', 'AUDITED'),
        ('public.is_crm_admin()',                                                   'f1e062ddce8e0265fc72a7d662e0e0ee', 'AUDITED'),
        ('public.update_lead_with_history(uuid, text, jsonb, jsonb)',               '2dc29d7ea4dade1797b141a2b86c408c', 'AUDITED'),
        ('public.enforce_lead_workflow()',                                          'a1a07bca19718034c78c824014060747', 'AUDITED'),
        ('public.crm_role()',                                                       '8b7bb33b96afb015b6af4c62d1ab2b53', 'REPO'),
        ('public.current_psychologist_id()',                                        '6a5e058441a5d4257c1b7d695947ac0a', 'REPO'),
        ('public.current_actor_name()',                                             '3bcf440ff185b01884a4bd608445b380', 'REPO'),
        ('public._can_manage_psychologist(uuid)',                                   '909bbbcea4ee38fbb66dc1790d3a0217', 'REPO'),
        ('public.book_appointment(uuid, uuid, uuid, timestamptz, text, uuid, text)', '0c25ffb3cfa622fdeb53041a496b7ade', 'REPO'),
        ('public.reschedule_appointment(uuid, timestamptz, uuid, text)',            'b2dfe8c23125444174baece37fdc9bb1', 'REPO'),
        ('public.cancel_appointment(uuid, text)',                                   'ac4778a4b105e7e242dc6db37bbdfd37', 'REPO'),
        ('public.confirm_appointment(uuid)',                                        '885bf2ed11541f4bc5b51bbdb48da11f', 'REPO'),
        ('public.record_attendance(uuid, boolean, text)',                           'b5acfeb14dad087caf5c38438d612a48', 'REPO'),
        ('public.appointments_before_write()',                                      '93261248f0492e3dbf7f5a9171ddde52', 'REPO'),
        ('public.log_appointment_status()',                                         'e0d2d13fcb9f9f0537d86226bac65fb8', 'REPO')
    ),
    status_def AS (
      SELECT coalesce(string_agg(pg_get_constraintdef(c.oid), ' '), '') AS def
      FROM pg_constraint AS c
      WHERE c.conrelid = 'public.appointments'::regclass AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) LIKE '%status%'
    ),
    checks(check_name, expected, actual, ok) AS (
      SELECT '01 connected role', 'postgres', current_user::text, current_user = 'postgres'

      UNION ALL
      SELECT '02 fingerprint ' || f.fn || ' [' || f.source || ']', f.md5, coalesce(a.m, 'MISSING'), a.m IS NOT DISTINCT FROM f.md5
      FROM expected_fp AS f
      LEFT JOIN LATERAL (SELECT md5(replace(p.prosrc, E'\r', '')) AS m FROM pg_proc AS p
                         WHERE p.oid = to_regprocedure(f.fn)) AS a ON true

      UNION ALL
      SELECT '03 public tables (exact set)', x.e, x.a, x.e = x.a
      FROM (SELECT 'appointment_status_history,appointments,clients,crm_staff_members,follow_up_recommendations,'
                   || 'lead_activities,leads,leads_status_backup_202611030002,psychologist_availability,'
                   || 'psychologist_availability_exceptions,psychologists,services,session_notes,session_status_history,sessions' AS e,
                   (SELECT coalesce(string_agg(relname, ',' ORDER BY relname), '') FROM pg_class
                    WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p')) AS a) AS x

      UNION ALL
      SELECT '04 objects this deployment creates are absent', 'none', coalesce(string_agg(o, ', '), 'none'), count(*) = 0
      FROM (VALUES
              (to_regclass('public.appointment_reminders')::text),
              (to_regclass('public.appointment_reminder_events')::text),
              (to_regclass('public.appointment_reminder_settings')::text),
              (to_regprocedure('public.is_own_psychologist(uuid)')::text),
              (to_regprocedure('public._assert_crm_staff_member(boolean)')::text),
              (to_regprocedure('public._create_appointment_reminders(uuid)')::text),
              (to_regprocedure('public.record_reminder_delivery(uuid, text, timestamptz, text)')::text),
              (to_regprocedure('public.record_reminder_response(uuid, text, text, timestamptz)')::text),
              (to_regprocedure('public.update_reminder_due_at(uuid, timestamptz, text)')::text),
              (to_regprocedure('public.set_reminder_offsets(interval, interval)')::text),
              ((SELECT 'policy availability_require_staff_or_owner' FROM pg_policy
                WHERE polrelid = 'public.psychologist_availability'::regclass AND polname = 'availability_require_staff_or_owner'))
           ) AS v(o)
      WHERE o IS NOT NULL

      UNION ALL
      SELECT '05 psychologist_availability policies (exact set)', x.e, x.a, x.e = x.a
      FROM (SELECT 'Active CRM staff can view psychologist availability,availability_delete_scoped,availability_insert_scoped,'
                   || 'availability_read_scoped,availability_update_scoped,psychologists_delete_own_availability,'
                   || 'psychologists_insert_own_availability,psychologists_read_own_availability,psychologists_update_own_availability' AS e,
                   (SELECT coalesce(string_agg(polname, ',' ORDER BY polname), '') FROM pg_policy
                    WHERE polrelid = 'public.psychologist_availability'::regclass) AS a) AS x

      UNION ALL
      SELECT '06 triggers on public tables (exact set)', x.e, x.a, x.e = x.a
      FROM (SELECT 'appointments.appointments_before_write,appointments.appointments_log_status,leads.leads_enforce_workflow,'
                   || 'leads.leads_sync_client,leads.set_lead_code,psychologist_availability.availability_no_overlap,'
                   || 'sessions.sessions_log_status,sessions.sessions_log_status_insert' AS e,
                   (SELECT coalesce(string_agg(c.relname || '.' || t.tgname, ',' ORDER BY c.relname, t.tgname), '')
                    FROM pg_trigger AS t JOIN pg_class AS c ON c.oid = t.tgrelid
                    WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal) AS a) AS x

      UNION ALL
      SELECT '07 appointments.status allows', 'Scheduled,Confirmed,Rescheduled,Cancelled,Completed,Missed',
             coalesce((SELECT string_agg(u.status, ',' ORDER BY u.n) FROM unnest(ARRAY['Scheduled', 'Confirmed', 'Rescheduled',
                        'Cancelled', 'Completed', 'Missed']) WITH ORDINALITY AS u(status, n)
                       WHERE position(quote_literal(u.status) IN d.def) > 0), ''),
             (SELECT count(*) FROM unnest(ARRAY['Scheduled', 'Confirmed', 'Rescheduled', 'Cancelled', 'Completed', 'Missed']) AS u(status)
              WHERE position(quote_literal(u.status) IN d.def) > 0) = 6
      FROM status_def AS d

      UNION ALL
      SELECT '08 appointments columns used', 'id,recommendation_id,rescheduled_from_id,starts_at,status,cancellation_reason',
             coalesce(string_agg(column_name, ',' ORDER BY array_position(ARRAY['id', 'recommendation_id', 'rescheduled_from_id',
               'starts_at', 'status', 'cancellation_reason']::text[], column_name::text)), ''),
             count(*) = 6
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'appointments'
        AND column_name IN ('id', 'recommendation_id', 'rescheduled_from_id', 'starts_at', 'status', 'cancellation_reason')

      UNION ALL
      SELECT '09 tables with FORCE ROW LEVEL SECURITY', 'none',
             coalesce(string_agg(relname, ','), 'none'), count(*) = 0
      FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relforcerowsecurity

      UNION ALL
      SELECT '10 owner of tables read by definer functions', 'postgres',
             string_agg(DISTINCT pg_get_userbyid(relowner), ','), bool_and(relowner = 'postgres'::regrole::oid)
      FROM pg_class
      WHERE oid IN ('public.crm_staff_members'::regclass, 'public.psychologists'::regclass,
                    'public.psychologist_availability'::regclass, 'public.appointments'::regclass)

      UNION ALL
      SELECT '11 active staff memberships (exactly 4: all become admin)', '4', count(*)::text, count(*) = 4
      FROM public.crm_staff_members WHERE is_active

      UNION ALL
      SELECT '12 accounts that would LOSE staff access', '0', count(*)::text, count(*) = 0
      FROM auth.users AS u
      WHERE NOT EXISTS (SELECT 1 FROM public.crm_staff_members AS m WHERE m.user_id = u.id AND m.is_active)
        AND NOT EXISTS (SELECT 1 FROM public.psychologists AS p WHERE p.auth_user_id = u.id)

      UNION ALL
      SELECT '13 psychologists who also have active staff membership (info: they become staff)', 'info',
             count(*)::text, true
      FROM public.psychologists AS p JOIN public.crm_staff_members AS m ON m.user_id = p.auth_user_id AND m.is_active

      UNION ALL
      SELECT '14 migration history has no 202611130001/202611130002', 'none',
             coalesce(string_agg(version, ','), 'none'), count(*) = 0
      FROM supabase_migrations.schema_migrations WHERE version IN ('202611130001', '202611130002')

      UNION ALL
      SELECT '15 follow-up appointments the reminder backfill will cover (info)', 'info', count(*)::text, true
      FROM public.appointments
      WHERE recommendation_id IS NOT NULL AND status IN ('Scheduled', 'Confirmed') AND starts_at > now()

      UNION ALL
      SELECT '16 crm_staff_members columns (exact set)', 'access_level,created_at,created_by,is_active,user_id',
             coalesce(string_agg(column_name::text, ',' ORDER BY column_name), ''),
             coalesce(string_agg(column_name::text, ',' ORDER BY column_name), '') = 'access_level,created_at,created_by,is_active,user_id'
      FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'crm_staff_members'

      UNION ALL
      SELECT '17 crm_staff_members.access_level CHECK allows staff and admin only', '(staff, admin)',
             coalesce(string_agg(pg_get_constraintdef(c.oid), ' '), 'MISSING'),
             count(*) = 1 AND bool_and(pg_get_constraintdef(c.oid) LIKE '%''staff''%'
                                       AND pg_get_constraintdef(c.oid) LIKE '%''admin''%')
      FROM pg_constraint AS c
      WHERE c.conrelid = 'public.crm_staff_members'::regclass AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) LIKE '%access_level%'

      UNION ALL
      SELECT '18 access levels now (info: active staff become admin, inactive untouched)', 'info',
             coalesce((SELECT string_agg(k || '=' || n, ', ' ORDER BY k)
                       FROM (SELECT CASE WHEN is_active THEN 'active ' ELSE 'inactive ' END || access_level AS k, count(*) AS n
                             FROM public.crm_staff_members GROUP BY 1) AS x), 'none'),
             true
    )
    SELECT check_name, expected, actual, ok FROM checks ORDER BY ok, check_name
  LOOP
    IF deploy_check.ok IS DISTINCT FROM true THEN
      failures := failures || format(E'\n  %s | expected: %s | actual: %s', deploy_check.check_name, deploy_check.expected, deploy_check.actual);
    ELSE
      passed := passed + 1;
    END IF;
  END LOOP;
  IF failures <> '' THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED - nothing was changed:%', failures;
  END IF;
  RAISE NOTICE 'PREFLIGHT PASSED: % checks passed', passed;
END
$preflight$;

-- Content fingerprint (row count + md5 of all rows) of the 15 existing tables before any change.
DO $snap$
DECLARE
  t text;
  sql text;
  n bigint;
  h text;
  fp jsonb := '{}'::jsonb;
BEGIN
  FOREACH t IN ARRAY ARRAY['appointment_status_history', 'appointments', 'clients', 'crm_staff_members', 'follow_up_recommendations', 'lead_activities', 'leads', 'leads_status_backup_202611030002', 'psychologist_availability', 'psychologist_availability_exceptions', 'psychologists', 'services', 'session_notes', 'session_status_history', 'sessions'] LOOP
    -- (shared by the before/after blocks)
    sql := CASE WHEN t = 'crm_staff_members' THEN
        'SELECT count(*), md5(coalesce(string_agg(x::text, E''\n'' ORDER BY x::text), '''')) FROM ('
        || 'SELECT user_id, is_active, created_at, created_by, CASE WHEN is_active THEN NULL ELSE access_level END'
        || ' AS inactive_access_level FROM public.crm_staff_members) AS x'
      ELSE format('SELECT count(*), md5(coalesce(string_agg(x::text, E''\n'' ORDER BY x::text), '''')) FROM public.%I AS x', t)
    END;
    EXECUTE sql INTO n, h;
    fp := fp || jsonb_build_object(t, jsonb_build_object('rows', n, 'md5', h));
  END LOOP;
  PERFORM set_config('deploy.content_before', fp::text, true);
END
$snap$;

-- ====================================================================================================
-- PART 1: supabase/migrations/202611130001_remediate_role_helpers_and_availability.sql  (its outer BEGIN; line 30 and COMMIT; line 371 removed)
-- ====================================================================================================

SET LOCAL lock_timeout = '5s';        -- never queue behind app traffic; fail and retry instead
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------------------------
-- 0. Pre-flight. Any surprise aborts the whole transaction before anything changes.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  v_active_staff integer;
  v_losing       integer;
  v_allowed      integer := coalesce(nullif(current_setting('kappiness.allowed_staff_loss', true), '')::integer, 0);
BEGIN
  IF to_regclass('public.crm_staff_members') IS NULL
     OR to_regclass('public.psychologists') IS NULL
     OR to_regclass('public.psychologist_availability') IS NULL
     OR to_regclass('public.services') IS NULL
     OR to_regclass('public.appointments') IS NULL THEN
    RAISE EXCEPTION 'Expected tables are missing: this database is not in the audited production state.';
  END IF;

  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'crm_staff_members'
        AND column_name IN ('user_id', 'is_active', 'access_level')) <> 3 THEN
    RAISE EXCEPTION 'public.crm_staff_members must have user_id, is_active and access_level.';
  END IF;

  IF to_regprocedure('public.is_crm_staff()') IS NULL
     OR to_regprocedure('public.is_crm_admin()') IS NULL
     OR to_regprocedure('public.current_psychologist_id()') IS NULL
     OR to_regprocedure('public._can_manage_psychologist(uuid)') IS NULL THEN
    RAISE EXCEPTION '202611040001 helpers are missing: this database is not in the audited production state.';
  END IF;

  -- No other overload of is_own_psychologist may exist (would make policy resolution ambiguous to readers).
  IF EXISTS (SELECT 1 FROM pg_proc
             WHERE pronamespace = 'public'::regnamespace AND proname = 'is_own_psychologist'
               AND oid IS DISTINCT FROM to_regprocedure('public.is_own_psychologist(uuid)')) THEN
    RAISE EXCEPTION 'An unexpected overload of public.is_own_psychologist exists. Investigate first.';
  END IF;

  -- SECURITY DEFINER helpers read these tables past RLS only if RLS is not FORCED and the definer owns them.
  IF EXISTS (SELECT 1 FROM pg_class
             WHERE oid IN ('public.crm_staff_members'::regclass, 'public.psychologists'::regclass,
                           'public.psychologist_availability'::regclass)
               AND (relforcerowsecurity OR relowner <> 'postgres'::regrole::oid)) THEN
    RAISE EXCEPTION 'crm_staff_members/psychologists/psychologist_availability: FORCE RLS is on or owner is not postgres.';
  END IF;
  IF (SELECT proowner FROM pg_proc WHERE oid = to_regprocedure('public.is_crm_staff()')) <> 'postgres'::regrole::oid THEN
    RAISE EXCEPTION 'public.is_crm_staff() is not owned by postgres.';
  END IF;

  -- The helper being replaced must be a KNOWN version: the audited 202611040001 body (md5 of prosrc with CR
  -- removed, confirmed on live 13 Nov 2026) or an already membership-based one (re-run). Anything else means
  -- someone changed production since the audit: stop and look.
  IF md5(replace((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.is_crm_staff()')), E'\r', ''))
       IS DISTINCT FROM '927078351f956d8e482743322e0f2b22'
     AND position('crm_staff_members' IN (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.is_crm_staff()'))) = 0 THEN
    RAISE EXCEPTION 'public.is_crm_staff() is neither the audited 202611040001 version nor membership-based. Investigate first.';
  END IF;

  -- Lock-out guard: the new rule must leave at least one working staff login.
  SELECT count(*) INTO v_active_staff FROM public.crm_staff_members WHERE is_active;
  IF v_active_staff = 0 THEN
    RAISE EXCEPTION 'No active crm_staff_members rows: every staff user would be locked out.';
  END IF;

  -- Accounts that are "staff" today (no psychologist profile) but have no ACTIVE membership lose access.
  SELECT count(*) INTO v_losing
  FROM auth.users AS u
  WHERE NOT EXISTS (SELECT 1 FROM public.crm_staff_members AS m WHERE m.user_id = u.id AND m.is_active)
    AND NOT EXISTS (SELECT 1 FROM public.psychologists AS p WHERE p.auth_user_id = u.id);
  RAISE NOTICE 'Active staff memberships: %. Accounts losing staff access: % (allowed: %).',
    v_active_staff, v_losing, v_allowed;
  IF v_losing > v_allowed THEN
    RAISE EXCEPTION '% account(s) would lose staff access; expected at most %. Review pre-check P3.', v_losing, v_allowed;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- 1. is_crm_staff(): active crm_staff_members row, nothing else. (= 202611040003 step 1)
--    CREATE OR REPLACE keeps the oid, owner, ACL and every dependent policy/function.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_crm_staff()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.crm_staff_members AS m
    WHERE m.user_id = (SELECT auth.uid())
      AND m.is_active = true
  );
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. is_crm_admin(): active membership with access_level = 'admin'. (= 202611040003 step 2)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_crm_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.crm_staff_members AS m
    WHERE m.user_id = (SELECT auth.uid())
      AND m.is_active = true
      AND m.access_level = 'admin'
  );
$$;

COMMENT ON FUNCTION public.is_crm_staff() IS
  'True only when the caller has an active public.crm_staff_members row. Ignores JWT roles and psychologist profiles. (202611130001)';
COMMENT ON FUNCTION public.is_crm_admin() IS
  'True only when the caller has an active public.crm_staff_members row with access_level = admin. (202611130001)';
COMMENT ON FUNCTION public.crm_role() IS
  'Reads app_metadata.role from the JWT. NOT an authorization source: use is_crm_staff() / is_crm_admin(). (202611130001)';

-- 3. Execute rights (already like this on live; re-asserted so the self-check is authoritative).
REVOKE ALL ON FUNCTION public.is_crm_staff(), public.is_crm_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_crm_staff(), public.is_crm_admin() TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- 4. Ownership helper. (= 202611040005 step 1)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_own_psychologist(p_psychologist_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_psychologist_id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.psychologists AS p
       WHERE p.id = p_psychologist_id
         AND p.auth_user_id = (SELECT auth.uid())
     );
$$;

COMMENT ON FUNCTION public.is_own_psychologist(uuid) IS
  'True when the psychologist profile is linked to the caller''s login (psychologists.auth_user_id). (202611130001)';

REVOKE ALL ON FUNCTION public.is_own_psychologist(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_own_psychologist(uuid) TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- 5. Restrictive guard on availability, AND-ed with all 9 existing permissive policies. (= 040005 step 2)
--    RLS is already enabled on live, so ALTER TABLE ... ENABLE ROW LEVEL SECURITY is not repeated.
-- ---------------------------------------------------------------------------------------------
DROP POLICY IF EXISTS availability_require_staff_or_owner ON public.psychologist_availability;
CREATE POLICY availability_require_staff_or_owner ON public.psychologist_availability
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING ((SELECT public.is_crm_staff()) OR public.is_own_psychologist(psychologist_id))
  WITH CHECK ((SELECT public.is_crm_staff()) OR public.is_own_psychologist(psychologist_id));

-- ---------------------------------------------------------------------------------------------
-- 6. Privileges. (= 040005 steps 3-4, extended to psychologists and services)
--    authenticated keeps SELECT/INSERT/UPDATE/DELETE (already granted on live; RLS decides rows),
--    so no GRANT is repeated here.
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON TABLE public.psychologist_availability FROM PUBLIC, anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.psychologist_availability FROM authenticated;

REVOKE ALL ON TABLE public.psychologists FROM PUBLIC, anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.psychologists FROM authenticated;

REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.services FROM authenticated;

-- ---------------------------------------------------------------------------------------------
-- 7. Structural self-check (NULL-safe: a missing value is a failure, never a pass).
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  fn  text;
  def record;
  t   text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['public.is_crm_staff()', 'public.is_crm_admin()', 'public.is_own_psychologist(uuid)'] LOOP
    SELECT p.prosecdef, p.provolatile, p.prorettype, p.prosrc, p.proconfig, p.proowner INTO def
    FROM pg_proc AS p WHERE p.oid = to_regprocedure(fn);
    IF def.prosecdef IS DISTINCT FROM true
       OR def.provolatile IS DISTINCT FROM 's'
       OR def.prorettype IS DISTINCT FROM 'boolean'::regtype
       OR def.proowner IS DISTINCT FROM 'postgres'::regrole::oid
       OR NOT ('search_path=""' = ANY (coalesce(def.proconfig, ARRAY[]::text[])))
       OR position('crm_role' IN coalesce(def.prosrc, 'crm_role')) > 0
       OR position('app_metadata' IN coalesce(def.prosrc, 'app_metadata')) > 0 THEN
      RAISE EXCEPTION '% does not have the expected definition.', fn;
    END IF;
    IF has_function_privilege('anon', to_regprocedure(fn), 'EXECUTE') IS DISTINCT FROM false
       OR has_function_privilege('authenticated', to_regprocedure(fn), 'EXECUTE') IS DISTINCT FROM true
       OR EXISTS (SELECT 1 FROM pg_proc AS p, aclexplode(p.proacl) AS a
                  WHERE p.oid = to_regprocedure(fn) AND a.grantee = 0) THEN
      RAISE EXCEPTION '% has the wrong execute privileges.', fn;
    END IF;
  END LOOP;

  IF position('crm_staff_members' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.is_crm_staff()'::regprocedure)) = 0
     OR position('access_level' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.is_crm_admin()'::regprocedure)) = 0
     OR position('psychologists' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.is_crm_staff()'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'Role helpers are not membership-based.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy AS pol
    WHERE pol.polrelid = 'public.psychologist_availability'::regclass
      AND pol.polname = 'availability_require_staff_or_owner'
      AND pol.polpermissive = false AND pol.polcmd = '*'
      AND pol.polroles = ARRAY['authenticated'::regrole::oid]) THEN
    RAISE EXCEPTION 'The restrictive availability policy is missing or has the wrong shape.';
  END IF;

  FOREACH t IN ARRAY ARRAY['public.psychologist_availability', 'public.psychologists'] LOOP
    IF has_table_privilege('anon', t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'anon still has privileges on %.', t;
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['public.psychologist_availability', 'public.psychologists', 'public.services'] LOOP
    IF has_table_privilege('authenticated', t, 'TRUNCATE') IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'authenticated can still TRUNCATE %.', t;
    END IF;
  END LOOP;

  -- Functionality the app relies on must still be granted.
  IF NOT has_table_privilege('authenticated', 'public.psychologist_availability', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.psychologist_availability', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.psychologist_availability', 'UPDATE')
     OR NOT has_table_privilege('authenticated', 'public.psychologist_availability', 'DELETE')
     OR NOT has_table_privilege('authenticated', 'public.psychologists', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.services', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.services', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.services', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated lost a privilege the app needs.';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- 8. Behaviour check as the API roles with simulated logins (same technique as supabase/tests/*.sql).
--    Reads only ids and counts; writes nothing. Any failure rolls back the whole migration.
-- ---------------------------------------------------------------------------------------------
SELECT set_config('remediation.staff_uid',
         (SELECT user_id::text FROM public.crm_staff_members WHERE is_active ORDER BY created_at LIMIT 1), true),
       set_config('remediation.psych_uid',
         coalesce((SELECT p.auth_user_id::text FROM public.psychologists AS p
                   WHERE p.auth_user_id IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM public.crm_staff_members AS m
                                     WHERE m.user_id = p.auth_user_id AND m.is_active)
                   ORDER BY p.created_at LIMIT 1), ''), true);
-- Separate statement: target-list evaluation order is not guaranteed, and psych_id depends on psych_uid.
SELECT set_config('remediation.psych_id',
         coalesce((SELECT p.id::text FROM public.psychologists AS p
                   WHERE p.auth_user_id::text = current_setting('remediation.psych_uid', true)), ''), true);

-- 8a. anon: no table access, no helper access.
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
DO $$
BEGIN
  BEGIN PERFORM 1 FROM public.psychologist_availability LIMIT 1;
        RAISE EXCEPTION 'FAIL: anon can read psychologist_availability';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM 1 FROM public.psychologists LIMIT 1;
        RAISE EXCEPTION 'FAIL: anon can read psychologists';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.is_crm_staff();
        RAISE EXCEPTION 'FAIL: anon can execute is_crm_staff()';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END
$$;
RESET ROLE;

-- 8b. A signed-in stranger (no membership, no psychologist profile) is NOT staff and sees nothing.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
         json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
DO $$
BEGIN
  IF public.is_crm_staff() IS DISTINCT FROM false OR public.is_crm_admin() IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL: an unknown login is treated as staff/admin';
  END IF;
  IF EXISTS (SELECT 1 FROM public.clients) OR EXISTS (SELECT 1 FROM public.appointments)
     OR EXISTS (SELECT 1 FROM public.sessions) OR EXISTS (SELECT 1 FROM public.psychologist_availability) THEN
    RAISE EXCEPTION 'FAIL: an unknown login can still see clinical or availability rows';
  END IF;
END
$$;

-- 8c. An active staff member is still staff.
SELECT set_config('request.jwt.claims',
         json_build_object('sub', current_setting('remediation.staff_uid', true), 'role', 'authenticated')::text, true);
DO $$
BEGIN
  IF public.is_crm_staff() IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL: an active staff member is no longer staff';
  END IF;
END
$$;

-- 8d. A psychologist (if one has a login) is not staff but still owns their own availability.
SELECT set_config('request.jwt.claims',
         CASE WHEN current_setting('remediation.psych_uid', true) = '' THEN '{"role":"authenticated"}'
              ELSE json_build_object('sub', current_setting('remediation.psych_uid', true), 'role', 'authenticated')::text END,
         true);
DO $$
DECLARE
  v_pid uuid := nullif(current_setting('remediation.psych_id', true), '')::uuid;
BEGIN
  IF v_pid IS NULL THEN
    RAISE NOTICE 'SKIP 8d: no psychologist login without a staff membership.';
    RETURN;
  END IF;
  IF public.is_crm_staff() IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL: a psychologist without membership is treated as staff';
  END IF;
  IF public.is_own_psychologist(v_pid) IS DISTINCT FROM true
     OR public.is_own_psychologist(gen_random_uuid()) IS DISTINCT FROM false
     OR public.current_psychologist_id() IS DISTINCT FROM v_pid THEN
    RAISE EXCEPTION 'FAIL: psychologist ownership helpers disagree';
  END IF;
  IF EXISTS (SELECT 1 FROM public.psychologist_availability WHERE psychologist_id <> v_pid) THEN
    RAISE EXCEPTION 'FAIL: a psychologist can see another psychologist''s availability';
  END IF;
END
$$;

RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);

-- ====================================================================================================
-- PART 2: ADMIN ACCESS FOR THE 4 ACTIVE STAFF MEMBERS. Source: supabase/deploy/parts/202611130003_admin_assignment.sql
-- ====================================================================================================

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

-- ====================================================================================================
-- PART 3: supabase/migrations/202611130002_appointment_reminders.sql  (its outer BEGIN; line 68 and COMMIT; line 838 removed)
-- ====================================================================================================

/* =====================================================================
   0. Prerequisites: check the schema this migration builds on instead of assuming it.
   ===================================================================== */
DO $$
DECLARE
  status_def text;
  s text;
BEGIN
  IF to_regclass('public.appointments') IS NULL
     OR to_regclass('public.follow_up_recommendations') IS NULL
     OR to_regclass('public.crm_staff_members') IS NULL THEN
    RAISE EXCEPTION 'Apply 202611030001 and 202611040001 first (appointments, follow_up_recommendations, crm_staff_members).';
  END IF;

  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'appointments'
        AND column_name IN ('id', 'starts_at', 'status', 'recommendation_id', 'rescheduled_from_id', 'cancellation_reason')) <> 6 THEN
    RAISE EXCEPTION 'public.appointments does not have the 202611040001 columns this migration uses.';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'crm_staff_members'
        AND column_name IN ('user_id', 'is_active', 'access_level')) <> 3 THEN
    RAISE EXCEPTION 'public.crm_staff_members must have user_id, is_active and access_level.';
  END IF;

  -- The appointment status vocabulary must be exactly the one the triggers below rely on.
  SELECT string_agg(pg_get_constraintdef(c.oid), ' ') INTO status_def
  FROM pg_constraint AS c
  WHERE c.conrelid = 'public.appointments'::regclass AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%status%';
  FOREACH s IN ARRAY ARRAY['Scheduled', 'Confirmed', 'Rescheduled', 'Cancelled', 'Completed', 'Missed'] LOOP
    IF position(quote_literal(s) IN coalesce(status_def, '')) = 0 THEN
      RAISE EXCEPTION 'appointments.status no longer allows %; review the reminder triggers before applying.', s;
    END IF;
  END LOOP;

  -- Workflow functions and the behaviour the triggers depend on.
  IF to_regprocedure('public.book_appointment(uuid, uuid, uuid, timestamptz, text, uuid, text)') IS NULL
     OR to_regprocedure('public.reschedule_appointment(uuid, timestamptz, uuid, text)') IS NULL
     OR to_regprocedure('public.cancel_appointment(uuid, text)') IS NULL
     OR to_regprocedure('public.current_actor_name()') IS NULL THEN
    RAISE EXCEPTION 'book_appointment / reschedule_appointment / cancel_appointment / current_actor_name are missing. Apply 202611040001 first.';
  END IF;
  IF position('p_recommendation_id' IN (SELECT prosrc FROM pg_proc
       WHERE oid = 'public.book_appointment(uuid, uuid, uuid, timestamptz, text, uuid, text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'book_appointment no longer stores the recommendation on the appointment; follow-up detection would break.';
  END IF;
  IF position('old_appt.recommendation_id' IN (SELECT prosrc FROM pg_proc
       WHERE oid = 'public.reschedule_appointment(uuid, timestamptz, uuid, text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'reschedule_appointment no longer copies the recommendation onto the replacement; reminders would not follow it.';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class
             WHERE oid IN ('public.crm_staff_members'::regclass, 'public.appointments'::regclass)
               AND relforcerowsecurity) THEN
    RAISE EXCEPTION 'FORCE ROW LEVEL SECURITY on crm_staff_members/appointments would break the definer functions.';
  END IF;
END
$$;

/* =====================================================================
   1. Tables
   ===================================================================== */

-- 1a. Timing configuration: one row per reminder slot.
CREATE TABLE IF NOT EXISTS public.appointment_reminder_settings (
  reminder_number smallint PRIMARY KEY CHECK (reminder_number IN (1, 2)),
  offset_before_start interval NOT NULL
    CHECK (offset_before_start > interval '0' AND offset_before_start <= interval '30 days'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_by_name text
);

INSERT INTO public.appointment_reminder_settings (reminder_number, offset_before_start, updated_by_name)
VALUES (1, interval '24 hours', 'Initial configuration (202611130002)'),
       (2, interval '2 hours',  'Initial configuration (202611130002)')
ON CONFLICT (reminder_number) DO NOTHING;

-- 1b. Reminder slots.
CREATE TABLE IF NOT EXISTS public.appointment_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES public.appointments(id) ON DELETE RESTRICT,
  reminder_number smallint NOT NULL CHECK (reminder_number IN (1, 2)),
  due_at timestamptz NOT NULL,
  delivery_status text NOT NULL DEFAULT 'Pending'
    CHECK (delivery_status IN ('Pending', 'Sent', 'Delivered', 'Failed', 'Cancelled')),
  sent_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  failure_reason text CHECK (char_length(failure_reason) <= 500),
  cancelled_at timestamptz,
  delivery_updated_by uuid,
  delivery_updated_by_name text,
  client_response text CHECK (client_response IN ('Confirmed', 'Wants to Reschedule', 'No Response')),
  responded_at timestamptz,
  response_recorded_by uuid,
  response_recorded_by_name text,
  response_note text CHECK (char_length(response_note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Exactly two slots per appointment: numbers 1 and 2, each at most once.
  CONSTRAINT appointment_reminders_slot_key UNIQUE (appointment_id, reminder_number),
  CONSTRAINT appointment_reminders_sent_has_time
    CHECK (delivery_status NOT IN ('Sent', 'Delivered') OR sent_at IS NOT NULL),
  CONSTRAINT appointment_reminders_delivered_has_time
    CHECK ((delivery_status = 'Delivered') = (delivered_at IS NOT NULL)),
  CONSTRAINT appointment_reminders_delivered_after_sent
    CHECK (delivered_at IS NULL OR (sent_at IS NOT NULL AND delivered_at >= sent_at)),
  CONSTRAINT appointment_reminders_failed_has_time
    CHECK (delivery_status <> 'Failed' OR failed_at IS NOT NULL),
  CONSTRAINT appointment_reminders_cancelled_has_time
    CHECK ((delivery_status = 'Cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT appointment_reminders_response_has_time
    CHECK ((client_response IS NULL) = (responded_at IS NULL)),
  CONSTRAINT appointment_reminders_response_needs_delivery
    CHECK (client_response IS NULL OR delivery_status IN ('Sent', 'Delivered')),
  CONSTRAINT appointment_reminders_note_needs_response
    CHECK (response_note IS NULL OR client_response IS NOT NULL)
);
-- Work queue: pending reminders by due time.
CREATE INDEX IF NOT EXISTS idx_appointment_reminders_pending_due
  ON public.appointment_reminders (due_at) WHERE delivery_status = 'Pending';
-- Follow-up lists: sent/delivered reminders still waiting for a client response.
CREATE INDEX IF NOT EXISTS idx_appointment_reminders_awaiting_response
  ON public.appointment_reminders (sent_at)
  WHERE delivery_status IN ('Sent', 'Delivered') AND client_response IS NULL;
-- (appointment_id, reminder_number) is already indexed by appointment_reminders_slot_key.

-- 1c. Append-only history.
CREATE TABLE IF NOT EXISTS public.appointment_reminder_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Total order of events (several events in one transaction share changed_at = now()).
  event_seq bigint GENERATED ALWAYS AS IDENTITY,
  reminder_id uuid NOT NULL REFERENCES public.appointment_reminders(id) ON DELETE RESTRICT,
  appointment_id uuid NOT NULL REFERENCES public.appointments(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('Created', 'Delivery status', 'Client response', 'Due time')),
  from_value text,
  to_value text,
  note text CHECK (char_length(note) <= 1000),
  changed_by uuid,
  changed_by_name text,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_appointment_reminder_events_reminder
  ON public.appointment_reminder_events (reminder_id, event_seq);
CREATE INDEX IF NOT EXISTS idx_appointment_reminder_events_appointment
  ON public.appointment_reminder_events (appointment_id, event_seq);

/* =====================================================================
   2. Internal helpers (not callable through the API)
   ===================================================================== */

-- Raises 42501 unless the caller has an ACTIVE crm_staff_members row (and access_level 'admin' if asked).
-- Deliberately independent of is_crm_staff()/is_crm_admin() (see header).
CREATE OR REPLACE FUNCTION public._assert_crm_staff_member(p_admin boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.crm_staff_members AS m
    WHERE m.user_id = auth.uid()
      AND m.is_active = true
      AND (NOT coalesce(p_admin, false) OR m.access_level = 'admin')
  ) THEN
    IF coalesce(p_admin, false) THEN
      RAISE EXCEPTION 'Only CRM administrators can change reminder timing.' USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'Only CRM staff can update appointment reminders.' USING ERRCODE = '42501';
  END IF;
END;
$$;

-- Creates reminders 1 and 2 for an active follow-up appointment. Idempotent: an existing slot is never
-- duplicated or overwritten. Returns the number of reminders created (0, or 2 for a new follow-up).
CREATE OR REPLACE FUNCTION public._create_appointment_reminders(p_appointment_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  appt record;
  off1 interval;
  off2 interval;
  due1 timestamptz;
  due2 timestamptz;
  created integer;
BEGIN
  SELECT a.id, a.starts_at, a.status, a.recommendation_id, a.rescheduled_from_id INTO appt
  FROM public.appointments AS a WHERE a.id = p_appointment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Appointment % does not exist.', p_appointment_id USING ERRCODE = 'P0001';
  END IF;
  IF appt.recommendation_id IS NULL OR appt.status NOT IN ('Scheduled', 'Confirmed') THEN
    RETURN 0; -- not an active follow-up appointment
  END IF;
  IF appt.starts_at <= now() THEN
    RAISE EXCEPTION 'Reminders can only be created for an appointment in the future.' USING ERRCODE = 'P0001';
  END IF;

  SELECT s.offset_before_start INTO off1 FROM public.appointment_reminder_settings AS s WHERE s.reminder_number = 1;
  SELECT s.offset_before_start INTO off2 FROM public.appointment_reminder_settings AS s WHERE s.reminder_number = 2;
  IF off1 IS NULL OR off2 IS NULL THEN
    RAISE EXCEPTION 'Reminder timing is not configured (appointment_reminder_settings needs reminders 1 and 2).'
      USING ERRCODE = 'P0001';
  END IF;
  IF off1 <= off2 THEN
    RAISE EXCEPTION 'Reminder timing is misconfigured: reminder 1 must be due earlier than reminder 2.'
      USING ERRCODE = 'P0001';
  END IF;

  due1 := greatest(appt.starts_at - off1, now());
  due2 := greatest(appt.starts_at - off2, due1);

  PERFORM set_config('kappiness.reminder_note',
    CASE WHEN appt.rescheduled_from_id IS NULL THEN 'Follow-up appointment booked'
         ELSE format('Replacement for rescheduled appointment %s', appt.rescheduled_from_id) END, true);
  INSERT INTO public.appointment_reminders (appointment_id, reminder_number, due_at)
  VALUES (appt.id, 1, due1), (appt.id, 2, due2)
  ON CONFLICT (appointment_id, reminder_number) DO NOTHING;
  GET DIAGNOSTICS created = ROW_COUNT;
  PERFORM set_config('kappiness.reminder_note', '', true);
  RETURN created;
END;
$$;

/* =====================================================================
   3. Reminder table triggers: validation, history, no deletes
   ===================================================================== */

CREATE OR REPLACE FUNCTION public.appointment_reminders_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  appt_start timestamptz;
  allowed text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.delivery_status IS DISTINCT FROM 'Pending'
       OR NEW.sent_at IS NOT NULL OR NEW.delivered_at IS NOT NULL OR NEW.failed_at IS NOT NULL
       OR NEW.cancelled_at IS NOT NULL OR NEW.client_response IS NOT NULL THEN
      RAISE EXCEPTION 'A new reminder must start as Pending, with no delivery or response details.' USING ERRCODE = '22023';
    END IF;
    SELECT a.starts_at INTO appt_start FROM public.appointments AS a WHERE a.id = NEW.appointment_id;
    IF NEW.due_at >= appt_start THEN
      RAISE EXCEPTION 'A reminder must be due before the appointment starts.' USING ERRCODE = '22023';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  -- UPDATE: the slot identity never changes.
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id
     OR NEW.reminder_number IS DISTINCT FROM OLD.reminder_number OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'A reminder''s appointment, number and creation time cannot be changed.' USING ERRCODE = '22023';
  END IF;

  IF NEW.delivery_status IS DISTINCT FROM OLD.delivery_status THEN
    allowed := CASE OLD.delivery_status
      WHEN 'Pending' THEN ARRAY['Sent', 'Delivered', 'Failed', 'Cancelled']
      WHEN 'Sent'    THEN ARRAY['Delivered', 'Failed']
      WHEN 'Failed'  THEN ARRAY['Sent', 'Delivered', 'Cancelled']
      ELSE ARRAY[]::text[] -- Delivered and Cancelled are final
    END;
    IF NOT (NEW.delivery_status = ANY (allowed)) THEN
      RAISE EXCEPTION 'A reminder cannot move from % to %.', OLD.delivery_status, NEW.delivery_status USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Recorded delivery times are kept: sent_at changes only when (re)sending, delivered_at is written once.
  IF OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at
     AND NOT (NEW.delivery_status = 'Sent' AND OLD.delivery_status = 'Failed') THEN
    RAISE EXCEPTION 'The recorded send time cannot be changed.' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at THEN
    RAISE EXCEPTION 'The recorded delivery time cannot be changed.' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.due_at IS DISTINCT FROM OLD.due_at AND OLD.delivery_status <> 'Pending' THEN
    RAISE EXCEPTION 'Only a pending reminder can be moved to another time.' USING ERRCODE = 'P0001';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.appointment_reminders_log_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_note text := left(nullif(current_setting('kappiness.reminder_note', true), ''), 1000);
  v_by uuid := auth.uid();
  v_name text := public.current_actor_name();
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.appointment_reminder_events (reminder_id, appointment_id, event_type, from_value, to_value, note, changed_by, changed_by_name)
    VALUES (NEW.id, NEW.appointment_id, 'Created', NULL,
            format('Reminder %s Pending, due %s', NEW.reminder_number, NEW.due_at), v_note, v_by, v_name);
    RETURN NULL;
  END IF;

  IF NEW.delivery_status IS DISTINCT FROM OLD.delivery_status THEN
    INSERT INTO public.appointment_reminder_events (reminder_id, appointment_id, event_type, from_value, to_value, note, changed_by, changed_by_name)
    VALUES (NEW.id, NEW.appointment_id, 'Delivery status', OLD.delivery_status, NEW.delivery_status, v_note, v_by, v_name);
  END IF;
  IF NEW.client_response IS DISTINCT FROM OLD.client_response
     OR NEW.response_note IS DISTINCT FROM OLD.response_note
     OR NEW.responded_at IS DISTINCT FROM OLD.responded_at THEN
    INSERT INTO public.appointment_reminder_events (reminder_id, appointment_id, event_type, from_value, to_value, note, changed_by, changed_by_name)
    VALUES (NEW.id, NEW.appointment_id, 'Client response', OLD.client_response, NEW.client_response,
            left(NEW.response_note, 1000), v_by, v_name);
  END IF;
  IF NEW.due_at IS DISTINCT FROM OLD.due_at THEN
    INSERT INTO public.appointment_reminder_events (reminder_id, appointment_id, event_type, from_value, to_value, note, changed_by, changed_by_name)
    VALUES (NEW.id, NEW.appointment_id, 'Due time', OLD.due_at::text, NEW.due_at::text, v_note, v_by, v_name);
  END IF;
  RETURN NULL;
END;
$$;

-- Reminder history is permanent: no row of either table is ever deleted, and events are never edited.
CREATE OR REPLACE FUNCTION public.appointment_reminders_block_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION '% rows are permanent history and cannot be %.', TG_TABLE_NAME,
    CASE TG_OP WHEN 'DELETE' THEN 'deleted' ELSE 'changed' END USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS appointment_reminders_before_write ON public.appointment_reminders;
CREATE TRIGGER appointment_reminders_before_write
  BEFORE INSERT OR UPDATE ON public.appointment_reminders
  FOR EACH ROW EXECUTE FUNCTION public.appointment_reminders_before_write();

DROP TRIGGER IF EXISTS appointment_reminders_log_event ON public.appointment_reminders;
CREATE TRIGGER appointment_reminders_log_event
  AFTER INSERT OR UPDATE ON public.appointment_reminders
  FOR EACH ROW EXECUTE FUNCTION public.appointment_reminders_log_event();

DROP TRIGGER IF EXISTS appointment_reminders_no_delete ON public.appointment_reminders;
CREATE TRIGGER appointment_reminders_no_delete
  BEFORE DELETE ON public.appointment_reminders
  FOR EACH ROW EXECUTE FUNCTION public.appointment_reminders_block_delete();

DROP TRIGGER IF EXISTS appointment_reminder_events_append_only ON public.appointment_reminder_events;
CREATE TRIGGER appointment_reminder_events_append_only
  BEFORE UPDATE OR DELETE ON public.appointment_reminder_events
  FOR EACH ROW EXECUTE FUNCTION public.appointment_reminders_block_delete();

/* =====================================================================
   4. Integration with the appointment workflow (triggers on public.appointments)
   ===================================================================== */

-- Booking (book_appointment) and the replacement row of reschedule_appointment.
CREATE OR REPLACE FUNCTION public.appointment_reminders_on_appointment_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public._create_appointment_reminders(NEW.id);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS appointments_create_reminders ON public.appointments;
CREATE TRIGGER appointments_create_reminders
  AFTER INSERT ON public.appointments
  FOR EACH ROW
  WHEN (NEW.recommendation_id IS NOT NULL AND NEW.status IN ('Scheduled', 'Confirmed'))
  EXECUTE FUNCTION public.appointment_reminders_on_appointment_insert();

-- Leaving the active statuses (Cancelled, Rescheduled, Completed, Missed): cancel PENDING reminders only.
CREATE OR REPLACE FUNCTION public.appointment_reminders_on_appointment_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM set_config('kappiness.reminder_note',
    CASE WHEN NEW.status = 'Cancelled' AND nullif(btrim(NEW.cancellation_reason), '') IS NOT NULL
         THEN format('Appointment cancelled: %s', btrim(NEW.cancellation_reason))
         ELSE format('Appointment %s', lower(NEW.status)) END, true);
  UPDATE public.appointment_reminders
    SET delivery_status = 'Cancelled', cancelled_at = now(),
        delivery_updated_by = auth.uid(), delivery_updated_by_name = public.current_actor_name()
    WHERE appointment_id = NEW.id AND delivery_status = 'Pending';
  PERFORM set_config('kappiness.reminder_note', '', true);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS appointments_cancel_pending_reminders ON public.appointments;
CREATE TRIGGER appointments_cancel_pending_reminders
  AFTER UPDATE OF status ON public.appointments
  FOR EACH ROW
  WHEN (OLD.status IN ('Scheduled', 'Confirmed') AND NEW.status NOT IN ('Scheduled', 'Confirmed'))
  EXECUTE FUNCTION public.appointment_reminders_on_appointment_status();

/* =====================================================================
   5. Tracking functions (RPC)
   Lock order everywhere: appointment row, then reminder rows (same as cancel/reschedule), so a reminder update
   and an appointment cancellation can never deadlock, and the later one always sees the earlier one's result.
   ===================================================================== */

-- 5a. Delivery status: Sent, Delivered, Failed (optional reason) or Cancelled (reason required).
CREATE OR REPLACE FUNCTION public.record_reminder_delivery(
  p_reminder_id uuid,
  p_status text,
  p_occurred_at timestamptz DEFAULT NULL,
  p_note text DEFAULT NULL
)
RETURNS public.appointment_reminders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r public.appointment_reminders%ROWTYPE;
  v_at timestamptz := coalesce(p_occurred_at, now());
  v_note text := nullif(btrim(p_note), '');
  v_appt uuid;
BEGIN
  PERFORM public._assert_crm_staff_member(false);
  IF p_status IS NULL OR p_status NOT IN ('Sent', 'Delivered', 'Failed', 'Cancelled') THEN
    RAISE EXCEPTION 'Choose Sent, Delivered, Failed or Cancelled.' USING ERRCODE = '22023';
  END IF;
  IF v_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'The delivery time cannot be in the future.' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_note) > 500 THEN
    RAISE EXCEPTION 'Keep the note under 500 characters.' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'Cancelled' AND v_note IS NULL THEN
    RAISE EXCEPTION 'Add a reason for cancelling this reminder.' USING ERRCODE = '22023';
  END IF;

  SELECT appointment_id INTO v_appt FROM public.appointment_reminders WHERE id = p_reminder_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This reminder no longer exists.' USING ERRCODE = 'P0001';
  END IF;
  PERFORM 1 FROM public.appointments WHERE id = v_appt FOR SHARE;
  SELECT * INTO r FROM public.appointment_reminders WHERE id = p_reminder_id FOR UPDATE;

  IF r.delivery_status = p_status THEN
    RAISE EXCEPTION 'This reminder is already %.', p_status USING ERRCODE = 'P0001';
  END IF;
  IF v_at < r.created_at THEN
    RAISE EXCEPTION 'The delivery time cannot be before the reminder was created.' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'Delivered' AND r.sent_at IS NOT NULL AND v_at < r.sent_at THEN
    RAISE EXCEPTION 'The delivery time cannot be before the send time.' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('kappiness.reminder_note', coalesce(v_note, ''), true);
  UPDATE public.appointment_reminders
    SET delivery_status = p_status,
        sent_at = CASE p_status WHEN 'Sent' THEN v_at WHEN 'Delivered' THEN coalesce(sent_at, v_at) ELSE sent_at END,
        delivered_at = CASE WHEN p_status = 'Delivered' THEN v_at ELSE delivered_at END,
        failed_at = CASE WHEN p_status = 'Failed' THEN v_at ELSE failed_at END,
        failure_reason = CASE WHEN p_status = 'Failed' THEN v_note ELSE failure_reason END,
        cancelled_at = CASE WHEN p_status = 'Cancelled' THEN v_at ELSE cancelled_at END,
        delivery_updated_by = auth.uid(),
        delivery_updated_by_name = public.current_actor_name()
    WHERE id = p_reminder_id
    RETURNING * INTO r; -- invalid transitions are refused by appointment_reminders_before_write
  PERFORM set_config('kappiness.reminder_note', '', true);
  RETURN r;
END;
$$;

-- 5b. Client response to a Sent or Delivered reminder. A later call replaces it; the events keep every version.
CREATE OR REPLACE FUNCTION public.record_reminder_response(
  p_reminder_id uuid,
  p_response text,
  p_note text DEFAULT NULL,
  p_responded_at timestamptz DEFAULT NULL
)
RETURNS public.appointment_reminders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r public.appointment_reminders%ROWTYPE;
  v_at timestamptz := coalesce(p_responded_at, now());
  v_note text := nullif(btrim(p_note), '');
  v_appt uuid;
BEGIN
  PERFORM public._assert_crm_staff_member(false);
  IF p_response IS NULL OR p_response NOT IN ('Confirmed', 'Wants to Reschedule', 'No Response') THEN
    RAISE EXCEPTION 'Choose Confirmed, Wants to Reschedule or No Response.' USING ERRCODE = '22023';
  END IF;
  IF v_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'The response time cannot be in the future.' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_note) > 1000 THEN
    RAISE EXCEPTION 'Keep the note under 1000 characters.' USING ERRCODE = '22023';
  END IF;

  SELECT appointment_id INTO v_appt FROM public.appointment_reminders WHERE id = p_reminder_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This reminder no longer exists.' USING ERRCODE = 'P0001';
  END IF;
  PERFORM 1 FROM public.appointments WHERE id = v_appt FOR SHARE;
  SELECT * INTO r FROM public.appointment_reminders WHERE id = p_reminder_id FOR UPDATE;

  IF r.delivery_status NOT IN ('Sent', 'Delivered') THEN
    RAISE EXCEPTION 'Record that this reminder was sent before recording the client''s response (it is %).',
      r.delivery_status USING ERRCODE = 'P0001';
  END IF;
  IF v_at < r.sent_at THEN
    RAISE EXCEPTION 'The response time cannot be before the reminder was sent.' USING ERRCODE = '22023';
  END IF;
  IF r.client_response IS NOT DISTINCT FROM p_response AND r.response_note IS NOT DISTINCT FROM v_note THEN
    RAISE EXCEPTION 'This response is already recorded.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.appointment_reminders
    SET client_response = p_response,
        responded_at = v_at,
        response_note = v_note,
        response_recorded_by = auth.uid(),
        response_recorded_by_name = public.current_actor_name()
    WHERE id = p_reminder_id
    RETURNING * INTO r;
  RETURN r;
END;
$$;

-- 5c. Move one pending reminder (between now and the appointment start, keeping reminder 1 <= reminder 2).
CREATE OR REPLACE FUNCTION public.update_reminder_due_at(
  p_reminder_id uuid,
  p_due_at timestamptz,
  p_note text DEFAULT NULL
)
RETURNS public.appointment_reminders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r public.appointment_reminders%ROWTYPE;
  appt record;
  v_appt uuid;
  sibling_due timestamptz;
BEGIN
  PERFORM public._assert_crm_staff_member(false);
  SELECT appointment_id INTO v_appt FROM public.appointment_reminders WHERE id = p_reminder_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This reminder no longer exists.' USING ERRCODE = 'P0001';
  END IF;
  SELECT a.starts_at, a.status INTO appt FROM public.appointments AS a WHERE a.id = v_appt FOR SHARE;
  -- Lock both slots of this appointment in a fixed order.
  PERFORM 1 FROM public.appointment_reminders WHERE appointment_id = v_appt ORDER BY reminder_number FOR UPDATE;
  SELECT * INTO r FROM public.appointment_reminders WHERE id = p_reminder_id;

  IF r.delivery_status <> 'Pending' THEN
    RAISE EXCEPTION 'Only a pending reminder can be moved (this one is %).', r.delivery_status USING ERRCODE = 'P0001';
  END IF;
  IF appt.status NOT IN ('Scheduled', 'Confirmed') THEN
    RAISE EXCEPTION 'The appointment is %; its reminders cannot be moved.', appt.status USING ERRCODE = 'P0001';
  END IF;
  IF p_due_at IS NULL OR p_due_at < now() OR p_due_at >= appt.starts_at THEN
    RAISE EXCEPTION 'Choose a reminder time between now and the start of the appointment.' USING ERRCODE = '22023';
  END IF;
  SELECT s.due_at INTO sibling_due FROM public.appointment_reminders AS s
  WHERE s.appointment_id = r.appointment_id AND s.reminder_number <> r.reminder_number;
  IF (r.reminder_number = 1 AND p_due_at > sibling_due) OR (r.reminder_number = 2 AND p_due_at < sibling_due) THEN
    RAISE EXCEPTION 'Reminder 1 must be due no later than reminder 2.' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('kappiness.reminder_note', coalesce(left(nullif(btrim(p_note), ''), 1000), ''), true);
  UPDATE public.appointment_reminders SET due_at = p_due_at WHERE id = p_reminder_id RETURNING * INTO r;
  PERFORM set_config('kappiness.reminder_note', '', true);
  RETURN r;
END;
$$;

-- 5d. Timing configuration (admins). Applies to reminders created from now on; existing ones are unchanged.
CREATE OR REPLACE FUNCTION public.set_reminder_offsets(p_first_before_start interval, p_second_before_start interval)
RETURNS SETOF public.appointment_reminder_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public._assert_crm_staff_member(true);
  IF p_first_before_start IS NULL OR p_second_before_start IS NULL
     OR p_second_before_start <= interval '0' OR p_first_before_start > interval '30 days' THEN
    RAISE EXCEPTION 'Reminder offsets must be between 0 and 30 days before the appointment.' USING ERRCODE = '22023';
  END IF;
  IF p_first_before_start <= p_second_before_start THEN
    RAISE EXCEPTION 'Reminder 1 must be sent earlier than reminder 2 (a longer time before the appointment).'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.appointment_reminder_settings AS s (reminder_number, offset_before_start, updated_at, updated_by, updated_by_name)
  VALUES (1, p_first_before_start, now(), auth.uid(), public.current_actor_name()),
         (2, p_second_before_start, now(), auth.uid(), public.current_actor_name())
  ON CONFLICT (reminder_number) DO UPDATE
    SET offset_before_start = EXCLUDED.offset_before_start, updated_at = EXCLUDED.updated_at,
        updated_by = EXCLUDED.updated_by, updated_by_name = EXCLUDED.updated_by_name;

  RETURN QUERY SELECT * FROM public.appointment_reminder_settings ORDER BY reminder_number;
END;
$$;

/* =====================================================================
   6. Row Level Security and grants: active CRM staff read; all writes go through the functions above.
   ===================================================================== */

ALTER TABLE public.appointment_reminder_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointment_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointment_reminder_events ENABLE ROW LEVEL SECURITY;

-- Default privileges in public grant ALL to anon and authenticated on new tables: take everything back.
REVOKE ALL ON TABLE public.appointment_reminder_settings, public.appointment_reminders,
  public.appointment_reminder_events FROM PUBLIC, anon, authenticated;
REVOKE TRUNCATE ON TABLE public.appointment_reminder_settings, public.appointment_reminders,
  public.appointment_reminder_events FROM service_role;
GRANT SELECT ON TABLE public.appointment_reminder_settings, public.appointment_reminders,
  public.appointment_reminder_events TO authenticated;
-- The identity sequence behind event_seq also received the schema's default sequence grants.
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated',
                 pg_get_serial_sequence('public.appointment_reminder_events', 'event_seq'));
END
$$;

DROP POLICY IF EXISTS appointment_reminder_settings_staff_read ON public.appointment_reminder_settings;
CREATE POLICY appointment_reminder_settings_staff_read ON public.appointment_reminder_settings
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.crm_staff_members AS m
                 WHERE m.user_id = (SELECT auth.uid()) AND m.is_active = true));

DROP POLICY IF EXISTS appointment_reminders_staff_read ON public.appointment_reminders;
CREATE POLICY appointment_reminders_staff_read ON public.appointment_reminders
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.crm_staff_members AS m
                 WHERE m.user_id = (SELECT auth.uid()) AND m.is_active = true));

DROP POLICY IF EXISTS appointment_reminder_events_staff_read ON public.appointment_reminder_events;
CREATE POLICY appointment_reminder_events_staff_read ON public.appointment_reminder_events
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.crm_staff_members AS m
                 WHERE m.user_id = (SELECT auth.uid()) AND m.is_active = true));

-- Internal and trigger functions: nobody through the API.
REVOKE ALL ON FUNCTION
  public._assert_crm_staff_member(boolean),
  public._create_appointment_reminders(uuid),
  public.appointment_reminders_before_write(),
  public.appointment_reminders_log_event(),
  public.appointment_reminders_block_delete(),
  public.appointment_reminders_on_appointment_insert(),
  public.appointment_reminders_on_appointment_status()
FROM PUBLIC, anon, authenticated;

-- RPCs: signed-in users may call them; each one checks for an active staff (or admin) membership itself.
REVOKE ALL ON FUNCTION
  public.record_reminder_delivery(uuid, text, timestamptz, text),
  public.record_reminder_response(uuid, text, text, timestamptz),
  public.update_reminder_due_at(uuid, timestamptz, text),
  public.set_reminder_offsets(interval, interval)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.record_reminder_delivery(uuid, text, timestamptz, text),
  public.record_reminder_response(uuid, text, text, timestamptz),
  public.update_reminder_due_at(uuid, timestamptz, text),
  public.set_reminder_offsets(interval, interval)
TO authenticated;

COMMENT ON TABLE public.appointment_reminders IS
  'Two reminder slots per follow-up appointment (202611130002). Written only by triggers and reminder RPCs.';
COMMENT ON TABLE public.appointment_reminder_events IS
  'Append-only history of appointment_reminders changes (202611130002).';
COMMENT ON TABLE public.appointment_reminder_settings IS
  'How long before the appointment reminders 1 and 2 are due. Change with set_reminder_offsets() (202611130002).';

/* =====================================================================
   7. Backfill: active, future follow-up appointments that existed before this migration.
   ===================================================================== */
DO $$
DECLARE
  n integer := 0;
  a record;
BEGIN
  FOR a IN
    SELECT id FROM public.appointments
    WHERE recommendation_id IS NOT NULL AND status IN ('Scheduled', 'Confirmed') AND starts_at > now()
    ORDER BY starts_at
  LOOP
    n := n + public._create_appointment_reminders(a.id);
  END LOOP;
  RAISE NOTICE 'appointment_reminders backfill: % reminder(s) created for existing follow-up appointments.', n;
END
$$;

/* =====================================================================
   8. Self-check (NULL-safe): fail and roll back unless the security shape is exactly as intended.
   ===================================================================== */
DO $$
DECLARE
  t text;
  fn text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.appointment_reminder_settings', 'public.appointment_reminders',
                           'public.appointment_reminder_events'] LOOP
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = t::regclass) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'RLS is not enabled on %.', t;
    END IF;
    IF has_table_privilege('anon', t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'anon has privileges on %.', t;
    END IF;
    IF has_table_privilege('authenticated', t, 'SELECT') IS DISTINCT FROM true
       OR has_table_privilege('authenticated', t, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'authenticated must have SELECT only on %.', t;
    END IF;
  END LOOP;

  FOREACH fn IN ARRAY ARRAY['public._assert_crm_staff_member(boolean)', 'public._create_appointment_reminders(uuid)',
                            'public.appointment_reminders_on_appointment_insert()',
                            'public.appointment_reminders_on_appointment_status()'] LOOP
    IF has_function_privilege('authenticated', fn, 'EXECUTE') IS DISTINCT FROM false
       OR has_function_privilege('anon', fn, 'EXECUTE') IS DISTINCT FROM false THEN
      RAISE EXCEPTION '% must not be executable through the API.', fn;
    END IF;
  END LOOP;
  FOREACH fn IN ARRAY ARRAY['public.record_reminder_delivery(uuid, text, timestamptz, text)',
                            'public.record_reminder_response(uuid, text, text, timestamptz)',
                            'public.update_reminder_due_at(uuid, timestamptz, text)',
                            'public.set_reminder_offsets(interval, interval)'] LOOP
    IF has_function_privilege('anon', fn, 'EXECUTE') IS DISTINCT FROM false
       OR has_function_privilege('authenticated', fn, 'EXECUTE') IS DISTINCT FROM true THEN
      RAISE EXCEPTION '% has the wrong execute privileges.', fn;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_trigger
      WHERE tgrelid = 'public.appointments'::regclass AND NOT tgisinternal
        AND tgname IN ('appointments_create_reminders', 'appointments_cancel_pending_reminders')) <> 2 THEN
    RAISE EXCEPTION 'The appointment reminder triggers are missing.';
  END IF;
  IF (SELECT count(*) FROM public.appointment_reminder_settings WHERE reminder_number IN (1, 2)) <> 2 THEN
    RAISE EXCEPTION 'appointment_reminder_settings must have reminders 1 and 2.';
  END IF;
END
$$;

-- ====================================================================================================
-- PART 4: BEHAVIOUR CHECKS. Source: supabase/deploy/parts/202611130003_behaviour_checks.sql
-- ====================================================================================================

-- Kappiness CRM production deployment 202611130003: BEHAVIOUR CHECKS (statements, no transaction control).
-- Edit here, then run  node scripts/build-production-deploy.mjs
-- Embedded in 202611130003_02_production_deploy.sql just before COMMIT, and wrapped in BEGIN ... ROLLBACK as
-- 202611130003_04_behaviour_check.sql (re-run any time after the deployment).
--
-- Simulates Supabase logins (request.jwt.claims + SET LOCAL ROLE, the documented SQL Editor technique) for:
-- anon, a random signed-in account, a real active staff member and a real psychologist without membership.
-- Reads only ids and EXISTS/count results; writes nothing (refused calls are expected to fail before writing).
-- Any failure raises, which rolls back the enclosing transaction.

SELECT set_config('deploy.staff_uid',
         (SELECT user_id::text FROM public.crm_staff_members WHERE is_active ORDER BY created_at LIMIT 1), true);
SELECT set_config('deploy.psych_uid',
         coalesce((SELECT p.auth_user_id::text FROM public.psychologists AS p
                   WHERE p.auth_user_id IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM public.crm_staff_members AS m
                                     WHERE m.user_id = p.auth_user_id AND m.is_active)
                   ORDER BY p.created_at LIMIT 1), ''), true);
SELECT set_config('deploy.psych_id',
         coalesce((SELECT p.id::text FROM public.psychologists AS p
                   WHERE p.auth_user_id::text = current_setting('deploy.psych_uid', true)), ''), true);
-- Any existing appointment id: cancel_appointment checks permission before status, so a refused call proves the
-- permission check. If the check were broken the call would succeed, X2 would raise, and everything rolls back.
SELECT set_config('deploy.appt_id',
         coalesce((SELECT id::text FROM public.appointments ORDER BY created_at LIMIT 1), ''), true);

-- X1. anon: no access to reminders, availability, psychologists; no reminder RPCs.
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
DO $$
DECLARE
  denied integer := 0;
BEGIN
  BEGIN PERFORM 1 FROM public.appointment_reminders LIMIT 1; EXCEPTION WHEN insufficient_privilege THEN denied := denied + 1; END;
  BEGIN PERFORM 1 FROM public.appointment_reminder_events LIMIT 1; EXCEPTION WHEN insufficient_privilege THEN denied := denied + 1; END;
  BEGIN PERFORM 1 FROM public.psychologist_availability LIMIT 1; EXCEPTION WHEN insufficient_privilege THEN denied := denied + 1; END;
  BEGIN PERFORM 1 FROM public.psychologists LIMIT 1; EXCEPTION WHEN insufficient_privilege THEN denied := denied + 1; END;
  BEGIN PERFORM public.record_reminder_delivery(gen_random_uuid(), 'Sent'); EXCEPTION WHEN insufficient_privilege THEN denied := denied + 1; END;
  BEGIN PERFORM public.is_crm_staff(); EXCEPTION WHEN insufficient_privilege THEN denied := denied + 1; END;
  IF denied <> 6 THEN
    RAISE EXCEPTION 'BEHAVIOUR FAIL X1: anon reached % of 6 protected objects', 6 - denied;
  END IF;
END
$$;
RESET ROLE;

-- X2. A signed-in account with no membership and no psychologist profile: not staff, sees nothing, changes nothing.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated',
         'app_metadata', json_build_object('role', 'admin'))::text, true);   -- a JWT "admin" claim must not help
DO $$
DECLARE
  refused integer := 0;
  expected integer := 3;
  v_appt uuid := nullif(current_setting('deploy.appt_id', true), '')::uuid;
BEGIN
  IF public.is_crm_staff() IS DISTINCT FROM false OR public.is_crm_admin() IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'BEHAVIOUR FAIL X2: an unknown login is treated as staff/admin';
  END IF;
  IF EXISTS (SELECT 1 FROM public.clients) OR EXISTS (SELECT 1 FROM public.appointments)
     OR EXISTS (SELECT 1 FROM public.sessions) OR EXISTS (SELECT 1 FROM public.follow_up_recommendations)
     OR EXISTS (SELECT 1 FROM public.psychologist_availability) OR EXISTS (SELECT 1 FROM public.leads)
     OR EXISTS (SELECT 1 FROM public.appointment_reminders) OR EXISTS (SELECT 1 FROM public.appointment_reminder_events)
     OR EXISTS (SELECT 1 FROM public.appointment_reminder_settings) THEN
    RAISE EXCEPTION 'BEHAVIOUR FAIL X2: an unknown login can see CRM rows';
  END IF;
  BEGIN PERFORM public.record_reminder_delivery(gen_random_uuid(), 'Sent'); EXCEPTION WHEN insufficient_privilege THEN refused := refused + 1; END;
  BEGIN PERFORM public.set_reminder_offsets(interval '48 hours', interval '1 hour'); EXCEPTION WHEN insufficient_privilege THEN refused := refused + 1; END;
  IF v_appt IS NOT NULL THEN
    expected := expected + 1;
    BEGIN PERFORM public.cancel_appointment(v_appt, 'deployment permission probe');
    EXCEPTION WHEN insufficient_privilege THEN refused := refused + 1; END;
  END IF;
  BEGIN
    INSERT INTO public.psychologist_availability (psychologist_id, day_of_week, start_time, end_time)
    VALUES ((SELECT id FROM public.psychologists LIMIT 1), 7, '03:00', '03:30');
  EXCEPTION WHEN insufficient_privilege OR not_null_violation THEN refused := refused + 1;
  END;
  IF refused <> expected THEN
    RAISE EXCEPTION 'BEHAVIOUR FAIL X2: an unknown login was allowed % of % refused actions', expected - refused, expected;
  END IF;
END
$$;

-- X3. A real active staff member: staff, can read reminder configuration, reaches the RPC's own checks.
SELECT set_config('request.jwt.claims',
         json_build_object('sub', current_setting('deploy.staff_uid', true), 'role', 'authenticated')::text, true);
DO $$
DECLARE
  state text;
BEGIN
  IF public.is_crm_staff() IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'BEHAVIOUR FAIL X3: an active staff member is no longer staff';
  END IF;
  IF (SELECT count(*) FROM public.appointment_reminder_settings) <> 2 THEN
    RAISE EXCEPTION 'BEHAVIOUR FAIL X3: staff cannot read reminder settings';
  END IF;
  BEGIN
    PERFORM public.record_reminder_delivery(gen_random_uuid(), 'Sent');   -- unknown reminder: P0001, not 42501
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
  END;
  IF state IS DISTINCT FROM 'P0001' THEN
    RAISE EXCEPTION 'BEHAVIOUR FAIL X3: staff call to record_reminder_delivery returned % instead of P0001', state;
  END IF;
END
$$;

-- X4. A real psychologist without membership: not staff, owns only their profile, no reminder access.
SELECT set_config('request.jwt.claims',
         CASE WHEN current_setting('deploy.psych_uid', true) = '' THEN '{"role":"authenticated"}'
              ELSE json_build_object('sub', current_setting('deploy.psych_uid', true), 'role', 'authenticated')::text END,
         true);
DO $$
DECLARE
  v_pid uuid := nullif(current_setting('deploy.psych_id', true), '')::uuid;
BEGIN
  IF v_pid IS NULL THEN
    RAISE NOTICE 'BEHAVIOUR SKIP X4: no psychologist login without staff membership';
    RETURN;
  END IF;
  IF public.is_crm_staff() IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'BEHAVIOUR FAIL X4: a psychologist without membership is treated as staff';
  END IF;
  IF public.is_own_psychologist(v_pid) IS DISTINCT FROM true OR public.is_own_psychologist(gen_random_uuid()) IS DISTINCT FROM false
     OR public.current_psychologist_id() IS DISTINCT FROM v_pid THEN
    RAISE EXCEPTION 'BEHAVIOUR FAIL X4: psychologist ownership helpers disagree';
  END IF;
  IF EXISTS (SELECT 1 FROM public.psychologist_availability WHERE psychologist_id <> v_pid)
     OR EXISTS (SELECT 1 FROM public.leads)
     OR EXISTS (SELECT 1 FROM public.appointment_reminders) OR EXISTS (SELECT 1 FROM public.appointment_reminder_settings) THEN
    RAISE EXCEPTION 'BEHAVIOUR FAIL X4: a psychologist sees another psychologist''s availability, leads or reminders';
  END IF;
END
$$;

-- X5. Admin decision: every ACTIVE membership passes is_crm_admin() (and is_crm_staff()); every INACTIVE membership
--     and the psychologist fail both. User ids are read as postgres first (the API role cannot list memberships).
RESET ROLE;
SELECT set_config('deploy.active_uids',
         coalesce((SELECT string_agg(user_id::text, ',' ORDER BY user_id) FROM public.crm_staff_members WHERE is_active), ''), true);
SELECT set_config('deploy.inactive_uids',
         coalesce((SELECT string_agg(user_id::text, ',' ORDER BY user_id) FROM public.crm_staff_members WHERE NOT is_active), ''), true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  uid text;
  n_active integer := 0;
  n_inactive integer := 0;
BEGIN
  FOREACH uid IN ARRAY coalesce(string_to_array(nullif(current_setting('deploy.active_uids', true), ''), ','), ARRAY[]::text[]) LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
    IF public.is_crm_admin() IS DISTINCT FROM true OR public.is_crm_staff() IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'BEHAVIOUR FAIL X5: active member % is not admin and staff', uid;
    END IF;
    n_active := n_active + 1;
  END LOOP;
  IF n_active <> 4 THEN
    RAISE EXCEPTION 'BEHAVIOUR FAIL X5: expected 4 active admins, checked %', n_active;
  END IF;

  FOREACH uid IN ARRAY coalesce(string_to_array(nullif(current_setting('deploy.inactive_uids', true), ''), ','), ARRAY[]::text[]) LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
    IF public.is_crm_admin() IS DISTINCT FROM false OR public.is_crm_staff() IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'BEHAVIOUR FAIL X5: inactive member % still passes is_crm_admin()/is_crm_staff()', uid;
    END IF;
    n_inactive := n_inactive + 1;
  END LOOP;

  -- The psychologist (no membership) and a stranger with a JWT "admin" claim are not admin.
  IF current_setting('deploy.psych_uid', true) <> '' THEN
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', current_setting('deploy.psych_uid', true), 'role', 'authenticated')::text, true);
    IF public.is_crm_admin() IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'BEHAVIOUR FAIL X5: a psychologist without membership passes is_crm_admin()';
    END IF;
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated',
            'app_metadata', json_build_object('role', 'admin'))::text, true);
  IF public.is_crm_admin() IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'BEHAVIOUR FAIL X5: a non-member with a JWT admin claim passes is_crm_admin()';
  END IF;
  RAISE NOTICE 'BEHAVIOUR X5: % active admin(s) pass, % inactive member(s), psychologist and non-member refused', n_active, n_inactive;
END
$$;

RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);

-- ====================================================================================================
-- PART 5: POST-DEPLOYMENT CHECKS (strict). Source: supabase/deploy/parts/202611130003_postdeploy_checks.sql
-- ====================================================================================================

DO $postcheck$
DECLARE
  deploy_check record;  -- name chosen so it cannot collide with aliases inside the query
  failures text := '';
  passed integer := 0;
BEGIN
  FOR deploy_check IN
    -- Kappiness CRM production deployment 202611130003: POST-DEPLOYMENT CHECKS.
    -- ONE read-only SELECT returning (check_name, expected, actual, ok). Edit here, then run
    --   node scripts/build-production-deploy.mjs
    -- Embedded twice: at the end of 202611130003_02_production_deploy.sql (any ok = false rolls the whole deployment
    -- back before COMMIT) and as the table in 202611130003_03_postdeploy_report.sql (run after COMMIT).
    -- Read-only; no client or patient record content.
    WITH unchanged_fp(fn, md5) AS (
      -- Functions this deployment must NOT change (same values as the preflight).
      VALUES
        ('public.update_lead_with_history(uuid, text, jsonb, jsonb)',               '2dc29d7ea4dade1797b141a2b86c408c'),
        ('public.enforce_lead_workflow()',                                          'a1a07bca19718034c78c824014060747'),
        ('public.crm_role()',                                                       '8b7bb33b96afb015b6af4c62d1ab2b53'),
        ('public.current_psychologist_id()',                                        '6a5e058441a5d4257c1b7d695947ac0a'),
        ('public.current_actor_name()',                                             '3bcf440ff185b01884a4bd608445b380'),
        ('public._can_manage_psychologist(uuid)',                                   '909bbbcea4ee38fbb66dc1790d3a0217'),
        ('public.book_appointment(uuid, uuid, uuid, timestamptz, text, uuid, text)', '0c25ffb3cfa622fdeb53041a496b7ade'),
        ('public.reschedule_appointment(uuid, timestamptz, uuid, text)',            'b2dfe8c23125444174baece37fdc9bb1'),
        ('public.cancel_appointment(uuid, text)',                                   'ac4778a4b105e7e242dc6db37bbdfd37'),
        ('public.confirm_appointment(uuid)',                                        '885bf2ed11541f4bc5b51bbdb48da11f'),
        ('public.record_attendance(uuid, boolean, text)',                           'b5acfeb14dad087caf5c38438d612a48'),
        ('public.appointments_before_write()',                                      '93261248f0492e3dbf7f5a9171ddde52'),
        ('public.log_appointment_status()',                                         'e0d2d13fcb9f9f0537d86226bac65fb8')
    ),
    helper AS (
      SELECT h.fn, p.prosecdef, p.provolatile, p.proconfig, p.prosrc,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
             EXISTS (SELECT 1 FROM aclexplode(p.proacl) AS a WHERE a.grantee = 0) AS public_x
      FROM (VALUES ('public.is_crm_staff()'), ('public.is_crm_admin()'), ('public.is_own_psychologist(uuid)')) AS h(fn)
      LEFT JOIN pg_proc AS p ON p.oid = to_regprocedure(h.fn)
    ),
    reminder_tables(t) AS (
      VALUES ('public.appointment_reminders'), ('public.appointment_reminder_events'), ('public.appointment_reminder_settings')
    ),
    checks(check_name, expected, actual, ok) AS (
      SELECT 'A1 unchanged ' || f.fn, f.md5, coalesce(a.m, 'MISSING'), a.m IS NOT DISTINCT FROM f.md5
      FROM unchanged_fp AS f
      LEFT JOIN LATERAL (SELECT md5(replace(p.prosrc, E'\r', '')) AS m FROM pg_proc AS p
                         WHERE p.oid = to_regprocedure(f.fn)) AS a ON true

      UNION ALL
      SELECT 'B1 helper ' || h.fn, 'definer, stable, search_path="", no JWT role, EXECUTE authenticated only',
             format('definer=%s volatile=%s config=%s anon=%s authenticated=%s public=%s',
                    h.prosecdef, h.provolatile, h.proconfig, h.anon_x, h.auth_x, h.public_x),
             coalesce(h.prosecdef AND h.provolatile = 's' AND 'search_path=""' = ANY (h.proconfig)
                      AND position('crm_role' IN h.prosrc) = 0 AND position('app_metadata' IN h.prosrc) = 0
                      AND NOT h.anon_x AND h.auth_x AND NOT h.public_x, false)
      FROM helper AS h

      UNION ALL
      SELECT 'B2 is_crm_staff() uses active crm_staff_members only', 'crm_staff_members + is_active, no psychologists',
             left(regexp_replace(prosrc, '\s+', ' ', 'g'), 200),
             position('crm_staff_members' IN prosrc) > 0 AND position('is_active' IN prosrc) > 0
               AND position('psychologists' IN prosrc) = 0
      FROM pg_proc WHERE oid = 'public.is_crm_staff()'::regprocedure

      UNION ALL
      SELECT 'B3 is_crm_admin() uses crm_staff_members.access_level', 'crm_staff_members + access_level = admin',
             left(regexp_replace(prosrc, '\s+', ' ', 'g'), 200),
             position('crm_staff_members' IN prosrc) > 0 AND position('access_level' IN prosrc) > 0
      FROM pg_proc WHERE oid = 'public.is_crm_admin()'::regprocedure

      UNION ALL
      SELECT 'B4 no other public function decides access from crm_role()', 'none',
             coalesce(string_agg(oid::regprocedure::text, ', '), 'none'), count(*) = 0
      FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace AND proname <> 'crm_role' AND prosrc ~ 'crm_role\(\)\s*(IN|=|<>)'

      UNION ALL
      SELECT 'C1 restrictive availability policy', 'RESTRICTIVE ALL {authenticated}',
             coalesce((SELECT CASE WHEN polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END || ' '
                              || CASE polcmd WHEN '*' THEN 'ALL' ELSE polcmd::text END || ' '
                              || (SELECT array_agg(rolname)::text FROM pg_roles WHERE oid = ANY (polroles))
                       FROM pg_policy WHERE polrelid = 'public.psychologist_availability'::regclass
                         AND polname = 'availability_require_staff_or_owner'), 'MISSING'),
             EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.psychologist_availability'::regclass
                       AND polname = 'availability_require_staff_or_owner' AND NOT polpermissive AND polcmd = '*'
                       AND polroles = ARRAY['authenticated'::regrole::oid])

      UNION ALL
      SELECT 'C2 psychologist_availability policy count', '10 (9 existing + 1 restrictive)', count(*)::text, count(*) = 10
      FROM pg_policy WHERE polrelid = 'public.psychologist_availability'::regclass

      UNION ALL
      SELECT 'C3 anon privileges on ' || u.tbl, 'none',
             coalesce(nullif(concat_ws(',',
               CASE WHEN has_table_privilege('anon', u.tbl, 'SELECT') THEN 'SELECT' END,
               CASE WHEN has_table_privilege('anon', u.tbl, 'INSERT') THEN 'INSERT' END,
               CASE WHEN has_table_privilege('anon', u.tbl, 'UPDATE') THEN 'UPDATE' END,
               CASE WHEN has_table_privilege('anon', u.tbl, 'DELETE') THEN 'DELETE' END,
               CASE WHEN has_table_privilege('anon', u.tbl, 'TRUNCATE') THEN 'TRUNCATE' END,
               CASE WHEN has_table_privilege('anon', u.tbl, 'REFERENCES') THEN 'REFERENCES' END,
               CASE WHEN has_table_privilege('anon', u.tbl, 'TRIGGER') THEN 'TRIGGER' END), ''), 'none'),
             NOT has_table_privilege('anon', u.tbl, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      FROM unnest(ARRAY['public.psychologist_availability', 'public.psychologists',
                        'public.appointment_reminders', 'public.appointment_reminder_events',
                        'public.appointment_reminder_settings']) AS u(tbl)

      UNION ALL
      SELECT 'C4 authenticated TRUNCATE/REFERENCES/TRIGGER on ' || u.tbl, 'none',
             CASE WHEN has_table_privilege('authenticated', u.tbl, 'TRUNCATE, REFERENCES, TRIGGER') THEN 'present' ELSE 'none' END,
             NOT has_table_privilege('authenticated', u.tbl, 'TRUNCATE, REFERENCES, TRIGGER')
      FROM unnest(ARRAY['public.psychologist_availability', 'public.psychologists', 'public.services']) AS u(tbl)

      UNION ALL
      SELECT 'C5 app privileges kept (availability SIUD, psychologists S, services SIU)', 'all true',
             format('avail=%s/%s/%s/%s psych=%s services=%s/%s/%s',
               has_table_privilege('authenticated', 'public.psychologist_availability', 'SELECT'),
               has_table_privilege('authenticated', 'public.psychologist_availability', 'INSERT'),
               has_table_privilege('authenticated', 'public.psychologist_availability', 'UPDATE'),
               has_table_privilege('authenticated', 'public.psychologist_availability', 'DELETE'),
               has_table_privilege('authenticated', 'public.psychologists', 'SELECT'),
               has_table_privilege('authenticated', 'public.services', 'SELECT'),
               has_table_privilege('authenticated', 'public.services', 'INSERT'),
               has_table_privilege('authenticated', 'public.services', 'UPDATE')),
             has_table_privilege('authenticated', 'public.psychologist_availability', 'SELECT')
               AND has_table_privilege('authenticated', 'public.psychologist_availability', 'INSERT')
               AND has_table_privilege('authenticated', 'public.psychologist_availability', 'UPDATE')
               AND has_table_privilege('authenticated', 'public.psychologist_availability', 'DELETE')
               AND has_table_privilege('authenticated', 'public.psychologists', 'SELECT')
               AND has_table_privilege('authenticated', 'public.services', 'SELECT')
               AND has_table_privilege('authenticated', 'public.services', 'INSERT')
               AND has_table_privilege('authenticated', 'public.services', 'UPDATE')

      UNION ALL
      SELECT 'D1 reminder table ' || r.t, 'RLS on; authenticated SELECT only; staff read policy',
             CASE WHEN to_regclass(r.t) IS NULL THEN 'MISSING' ELSE
               format('rls=%s auth_select=%s auth_write=%s staff_policy=%s',
                 (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass(r.t)),
                 has_table_privilege('authenticated', r.t, 'SELECT'),
                 has_table_privilege('authenticated', r.t, 'INSERT, UPDATE, DELETE, TRUNCATE'),
                 EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = to_regclass(r.t) AND polcmd = 'r'
                           AND pg_get_expr(polqual, polrelid) LIKE '%crm_staff_members%is_active%')) END,
             to_regclass(r.t) IS NOT NULL
               AND coalesce((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass(r.t)), false)
               AND has_table_privilege('authenticated', r.t, 'SELECT')
               AND NOT has_table_privilege('authenticated', r.t, 'INSERT, UPDATE, DELETE, TRUNCATE')
               AND EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = to_regclass(r.t) AND polcmd = 'r'
                             AND pg_get_expr(polqual, polrelid) LIKE '%crm_staff_members%is_active%')
               AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = to_regclass(r.t)
                                 AND pg_get_expr(polqual, polrelid) ~ 'is_crm_(staff|admin)')
      FROM reminder_tables AS r

      UNION ALL
      SELECT 'D2 triggers on appointments', 'appointments_before_write,appointments_cancel_pending_reminders,appointments_create_reminders,appointments_log_status',
             coalesce(string_agg(tgname, ',' ORDER BY tgname), ''),
             coalesce(string_agg(tgname, ',' ORDER BY tgname), '')
               = 'appointments_before_write,appointments_cancel_pending_reminders,appointments_create_reminders,appointments_log_status'
      FROM pg_trigger WHERE tgrelid = 'public.appointments'::regclass AND NOT tgisinternal

      UNION ALL
      SELECT 'D3 reminder RPCs: authenticated only', 'anon=false authenticated=true (x4)',
             string_agg(format('%s anon=%s auth=%s', proname, has_function_privilege('anon', oid, 'EXECUTE'),
                               has_function_privilege('authenticated', oid, 'EXECUTE')), '; ' ORDER BY proname),
             count(*) = 4 AND bool_and(NOT has_function_privilege('anon', oid, 'EXECUTE')
                                       AND has_function_privilege('authenticated', oid, 'EXECUTE'))
      FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname IN ('record_reminder_delivery', 'record_reminder_response', 'update_reminder_due_at', 'set_reminder_offsets')

      UNION ALL
      SELECT 'D4 internal reminder functions not callable through the API', 'none callable',
             coalesce(string_agg(proname, ',') FILTER (WHERE has_function_privilege('authenticated', oid, 'EXECUTE')
                                                          OR has_function_privilege('anon', oid, 'EXECUTE')), 'none callable'),
             count(*) = 7 AND NOT bool_or(has_function_privilege('authenticated', oid, 'EXECUTE')
                                          OR has_function_privilege('anon', oid, 'EXECUTE'))
      FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname IN ('_assert_crm_staff_member', '_create_appointment_reminders', 'appointment_reminders_before_write',
                        'appointment_reminders_log_event', 'appointment_reminders_block_delete',
                        'appointment_reminders_on_appointment_insert', 'appointment_reminders_on_appointment_status')

      UNION ALL
      SELECT 'D5 reminder timing configured', 'reminder 1 > reminder 2 > 0',
             coalesce(string_agg(reminder_number || '=' || offset_before_start, ', ' ORDER BY reminder_number), 'MISSING'),
             count(*) = 2 AND max(offset_before_start) FILTER (WHERE reminder_number = 1)
                              > max(offset_before_start) FILTER (WHERE reminder_number = 2)
      FROM public.appointment_reminder_settings

      UNION ALL
      SELECT 'D6 every appointment with reminders has exactly slots 1 and 2', '0 violations', count(*)::text, count(*) = 0
      FROM (SELECT appointment_id FROM public.appointment_reminders GROUP BY appointment_id
            HAVING array_agg(reminder_number ORDER BY reminder_number) <> ARRAY[1, 2]::smallint[]) AS bad

      UNION ALL
      SELECT 'D7 active future follow-ups without reminders', '0', count(*)::text, count(*) = 0
      FROM public.appointments AS a
      WHERE a.recommendation_id IS NOT NULL AND a.status IN ('Scheduled', 'Confirmed') AND a.starts_at > now()
        AND NOT EXISTS (SELECT 1 FROM public.appointment_reminders AS r WHERE r.appointment_id = a.id)

      UNION ALL
      SELECT 'E1 active memberships: exactly 4, all admin', 'active=4 admin=4 not_admin=0',
             format('active=%s admin=%s not_admin=%s', count(*), count(*) FILTER (WHERE access_level = 'admin'),
                    count(*) FILTER (WHERE access_level IS DISTINCT FROM 'admin')),
             count(*) = 4 AND count(*) FILTER (WHERE access_level = 'admin') = 4
      FROM public.crm_staff_members WHERE is_active = true

      UNION ALL
      SELECT 'E2 inactive memberships (info: never changed by this deployment)', 'info',
             coalesce((SELECT string_agg(access_level || '=' || n, ', ' ORDER BY access_level)
                       FROM (SELECT access_level, count(*) AS n FROM public.crm_staff_members
                             WHERE NOT is_active GROUP BY 1) AS x), 'none'),
             true
    )
    SELECT check_name, expected, actual, ok FROM checks ORDER BY ok, check_name
  LOOP
    IF deploy_check.ok IS DISTINCT FROM true THEN
      failures := failures || format(E'\n  %s | expected: %s | actual: %s', deploy_check.check_name, deploy_check.expected, deploy_check.actual);
    ELSE
      passed := passed + 1;
    END IF;
  END LOOP;
  IF failures <> '' THEN
    RAISE EXCEPTION 'POST-DEPLOYMENT CHECK FAILED - everything rolled back:%', failures;
  END IF;
  RAISE NOTICE 'POST-DEPLOYMENT CHECKS PASSED: % checks passed', passed;
END
$postcheck$;

-- Existing data unchanged: same row count AND same content in all 15 pre-existing tables (crm_staff_members:
-- everything except access_level of active rows). Any difference rolls the whole deployment back.
DO $snap$
DECLARE
  t text;
  sql text;
  n bigint;
  h text;
  before jsonb := current_setting('deploy.content_before')::jsonb;
  diffs text := '';
BEGIN
  FOREACH t IN ARRAY ARRAY['appointment_status_history', 'appointments', 'clients', 'crm_staff_members', 'follow_up_recommendations', 'lead_activities', 'leads', 'leads_status_backup_202611030002', 'psychologist_availability', 'psychologist_availability_exceptions', 'psychologists', 'services', 'session_notes', 'session_status_history', 'sessions'] LOOP
    -- (shared by the before/after blocks)
    sql := CASE WHEN t = 'crm_staff_members' THEN
        'SELECT count(*), md5(coalesce(string_agg(x::text, E''\n'' ORDER BY x::text), '''')) FROM ('
        || 'SELECT user_id, is_active, created_at, created_by, CASE WHEN is_active THEN NULL ELSE access_level END'
        || ' AS inactive_access_level FROM public.crm_staff_members) AS x'
      ELSE format('SELECT count(*), md5(coalesce(string_agg(x::text, E''\n'' ORDER BY x::text), '''')) FROM public.%I AS x', t)
    END;
    EXECUTE sql INTO n, h;
    IF n IS DISTINCT FROM (before -> t ->> 'rows')::bigint OR h IS DISTINCT FROM (before -> t ->> 'md5') THEN
      diffs := diffs || format(E'\n  %s: rows %s -> %s, content %s', t, before -> t ->> 'rows', n,
                                CASE WHEN h IS DISTINCT FROM (before -> t ->> 'md5') THEN 'CHANGED' ELSE 'same' END);
    END IF;
  END LOOP;
  IF diffs <> '' THEN
    RAISE EXCEPTION 'POST-DEPLOYMENT CHECK FAILED (existing data changed) - everything rolled back:%', diffs;
  END IF;
  RAISE NOTICE 'Content of the 15 existing tables unchanged (only active crm_staff_members.access_level may differ)';
END
$snap$;

COMMIT;
