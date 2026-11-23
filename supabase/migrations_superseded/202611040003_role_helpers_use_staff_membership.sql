-- Kappiness CRM: role helpers use trusted CRM staff membership.
-- Owner: Aswathy (backend / security).
--
-- WHY
--   202611040001 defines public.is_crm_staff() as "app_metadata.role is admin/staff, OR any signed-in user
--   without a psychologist profile". With Google sign-in, any Google account would count as staff and could
--   read and change clients, appointments, sessions, recommendations, services and availability.
--   It also defines public.is_crm_admin() from app_metadata.role, which gates clinical session notes.
--
--   The live project already decides staff access with public.crm_staff_members (202611030001).
--   This migration makes both helpers use that table, and nothing else:
--     is_crm_staff()  = the caller has an ACTIVE crm_staff_members row.
--     is_crm_admin()  = the caller has an ACTIVE crm_staff_members row with access_level = 'admin'.
--   JWT claims (app_metadata.role) and the presence/absence of a psychologist profile are ignored.
--   A person with an active membership AND a psychologist profile counts as staff.
--   A psychologist without an active membership never counts as staff.
--
--   Every policy and workflow function in 202611040001 calls these helpers, so replacing them secures all of
--   them. Signatures are unchanged (no arguments, boolean), so dependent policies keep working.
--
-- LIVE STATE (verified 4 Nov 2026 from pg_get_functiondef, live_function_definitions.csv)
--   Live public.is_crm_staff() is already membership-based:
--     SELECT auth.uid() IS NOT NULL AND EXISTS (SELECT 1 FROM public.crm_staff_members AS staff
--            WHERE staff.user_id = auth.uid() AND staff.is_active = true);
--   owner postgres, SECURITY DEFINER, STABLE, search_path public, EXECUTE: authenticated + service_role only.
--   202611040001 would REPLACE that safe function with the insecure version. This file restores the same
--   rule (identical truth table: no signed-in user -> false; otherwise active membership) with an empty
--   search_path, so existing live policies that call is_crm_staff() keep exactly their current behaviour.
--   is_crm_admin() does not exist on live; it is new (202611040001) and is redefined here.
--
-- DEPLOYMENT (IMPORTANT)
--   * NEVER apply 202611040001 on its own. It is deployed only inside the atomic bundle built by
--     scripts/build-deploy-bundle.mjs (030002 + 040001 + 040003 + 040004 + 040005, one BEGIN/COMMIT).
--     202611040001 ends with its own COMMIT, so running the files one after the other is NOT atomic
--     (not even pasted together in one SQL editor run).
--     Any error (including the self-check in step 4) rolls back the whole bundle, so nothing is ever
--     committed with the insecure helpers. Other sessions never see the uncommitted helpers.
--     If 202611040001 is ever re-run, this file must be re-run in the same transaction, because
--     202611040001 recreates the insecure helpers.
--   * 202611040002 is NOT needed and should not be applied: the live restrictive lead policies from
--     202611030001 already require active staff membership.
--   * This file refuses to run before 202611040001 (step 0), so a wrong order fails instead of being
--     silently undone.
--
-- PREREQUISITES
--   202611030001 (public.crm_staff_members) and 202611040001 (public.appointments and the helpers).
--
-- SECURITY NOTES
--   SECURITY DEFINER with an empty search_path: the helpers read crm_staff_members as the owner (postgres,
--   the table owner, which RLS does not apply to because the table does not use FORCE ROW LEVEL SECURITY).
--   Callers only ever learn true/false about themselves.
--   EXECUTE stays limited to authenticated: RLS policy expressions run as the calling role.
--
-- ROLLBACK
--   Do not roll back to the 202611040001 definitions. If this must be undone, replace the helpers with
--   another membership-based definition.

BEGIN;

-- 0. Prerequisites: the staff membership table (with the columns used below) and 202611040001.
DO $$
BEGIN
  IF to_regclass('public.crm_staff_members') IS NULL THEN
    RAISE EXCEPTION 'public.crm_staff_members is missing. Apply 202611030001 first.';
  END IF;

  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'crm_staff_members'
        AND column_name IN ('user_id', 'is_active', 'access_level')) <> 3 THEN
    RAISE EXCEPTION 'public.crm_staff_members must have user_id, is_active and access_level.';
  END IF;

  IF to_regclass('public.appointments') IS NULL
     OR to_regprocedure('public.is_crm_staff()') IS NULL
     OR to_regprocedure('public.is_crm_admin()') IS NULL THEN
    RAISE EXCEPTION 'Apply 202611040001 before this migration, in the same transaction.';
  END IF;
END
$$;

-- 1. Staff = active CRM staff membership. Nothing else.
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

-- 2. Admin = active CRM staff membership with access_level 'admin'.
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
  'True only when the caller has an active public.crm_staff_members row. Ignores JWT roles and psychologist profiles. (202611040003)';
COMMENT ON FUNCTION public.is_crm_admin() IS
  'True only when the caller has an active public.crm_staff_members row with access_level = admin. (202611040003)';
COMMENT ON FUNCTION public.crm_role() IS
  'Reads app_metadata.role from the JWT. NOT an authorization source: use is_crm_staff() / is_crm_admin(). (202611040003)';

-- 3. Execute rights: signed-in users only (RLS policies evaluate these as the calling role).
REVOKE ALL ON FUNCTION public.is_crm_staff(), public.is_crm_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_crm_staff(), public.is_crm_admin() TO authenticated;

-- 4. Self-check: fail (and roll back everything) unless the safe definitions are the ones in place.
--    Every comparison is NULL-safe: a missing function or catalog value is a failure, never a pass.
DO $$
DECLARE
  fn text;
  fn_oid oid;
  def record;
  table_owner oid;
  table_forced boolean;
  owner_ok boolean;
BEGIN
  SELECT c.relowner, c.relforcerowsecurity INTO table_owner, table_forced
  FROM pg_class AS c WHERE c.oid = 'public.crm_staff_members'::regclass;

  -- With FORCE ROW LEVEL SECURITY the definer would be subject to RLS and the helpers would return false
  -- for everyone (staff locked out). Refuse instead of deploying a silently broken permission model.
  IF table_forced IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'public.crm_staff_members uses FORCE ROW LEVEL SECURITY; the role helpers cannot read it.';
  END IF;

  FOREACH fn IN ARRAY ARRAY['public.is_crm_staff()', 'public.is_crm_admin()'] LOOP
    fn_oid := to_regprocedure(fn);
    IF fn_oid IS NULL THEN
      RAISE EXCEPTION '% does not exist after this migration.', fn;
    END IF;

    SELECT p.prosecdef, p.prosrc, p.proconfig, p.provolatile, p.prorettype, p.proowner INTO def
    FROM pg_proc AS p
    WHERE p.oid = fn_oid;

    IF def.prosecdef IS DISTINCT FROM true
       OR def.provolatile IS DISTINCT FROM 's'
       OR def.prorettype IS DISTINCT FROM 'boolean'::regtype
       OR def.prosrc IS NULL
       OR position('crm_staff_members' IN def.prosrc) = 0
       OR position('crm_role' IN def.prosrc) > 0
       OR position('psychologists' IN def.prosrc) > 0
       OR position('app_metadata' IN def.prosrc) > 0
       OR NOT ('search_path=""' = ANY (coalesce(def.proconfig, ARRAY[]::text[])))
    THEN
      RAISE EXCEPTION '% does not have the expected membership-based definition.', fn;
    END IF;

    -- The definer must be able to read crm_staff_members without RLS: table owner, superuser or BYPASSRLS.
    SELECT (def.proowner = table_owner) OR r.rolsuper OR r.rolbypassrls INTO owner_ok
    FROM pg_roles AS r WHERE r.oid = def.proowner;
    IF owner_ok IS DISTINCT FROM true THEN
      RAISE EXCEPTION '% is owned by a role that cannot read public.crm_staff_members past RLS.', fn;
    END IF;

    IF has_function_privilege('anon', fn_oid, 'EXECUTE') IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'anon must not be able to execute %.', fn;
    END IF;
    IF has_function_privilege('authenticated', fn_oid, 'EXECUTE') IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'authenticated must be able to execute %.', fn;
    END IF;
  END LOOP;
END
$$;

COMMIT;
