-- Kappiness CRM: psychologist_availability access is limited to CRM staff and the psychologist themself.
-- Owner: Aswathy (backend / security).
--
-- WHY
--   Live public.psychologist_availability has five PERMISSIVE policies (checked 4 Nov 2026):
--     - Active CRM staff can view psychologist availability (SELECT)
--     - Psychologists can read / insert / update / delete their own availability
--   and the table grants SELECT, INSERT, UPDATE and DELETE to anon.
--   202611040001 adds four more PERMISSIVE policies (availability_*_scoped) and grants
--   SELECT/INSERT/UPDATE/DELETE to authenticated. Permissive policies are OR-ed, so any one of them that
--   is (or later becomes) broad would bypass the others.
--
-- WHAT THIS DOES
--   1. Adds one RESTRICTIVE policy for authenticated: every read and write must satisfy
--      "active CRM staff (crm_staff_members) OR the row belongs to the caller's own psychologist profile".
--      It is AND-ed with all permissive policies, so no permissive policy can widen access beyond it.
--      Existing policies are not dropped or changed: psychologists keep their own access, staff keep
--      read access, and 202611040001 adds staff management.
--   2. Adds public.is_own_psychologist(uuid): true when the psychologist row is linked to the caller's login.
--      Handles a login linked to more than one profile, and does not depend on RLS on psychologists.
--   3. Revokes every privilege from anon (and PUBLIC). Nothing anonymous reads or writes availability:
--      every caller in the app is signed in (proxy.js redirects anonymous users to /login).
--   4. Removes TRUNCATE, REFERENCES and TRIGGER from authenticated (TRUNCATE ignores RLS).
--   5. Self-check: RLS enabled and not forced, the restrictive policy present, no anon privileges.
--
-- DEPLOYMENT
--   Only inside the atomic bundle (scripts/build-deploy-bundle.mjs), after 202611040003, which makes
--   is_crm_staff() membership-based. Refuses to run if that has not happened.
--
-- FORCE ROW LEVEL SECURITY
--   Live psychologist_availability (checked 4 Nov 2026): rls_enabled = true, force_rls = false.
--   Must stay OFF on psychologist_availability and psychologists: SECURITY DEFINER functions owned by the
--   table owner (_assert_slot_available, current_psychologist_id, is_own_psychologist) read them past RLS.
--   With FORCE on, booking and ownership checks would fail for everyone. Step 0 refuses in that case.
--
-- ROLLBACK
--   DROP POLICY availability_require_staff_or_owner ON public.psychologist_availability;
--   (Do not restore the anon grants.)

BEGIN;

-- 0. Prerequisites.
DO $$
DECLARE
  staff_src text;
BEGIN
  IF to_regclass('public.psychologist_availability') IS NULL OR to_regclass('public.psychologists') IS NULL THEN
    RAISE EXCEPTION 'public.psychologists and public.psychologist_availability must exist.';
  END IF;

  SELECT p.prosrc INTO staff_src FROM pg_proc AS p WHERE p.oid = to_regprocedure('public.is_crm_staff()');
  IF staff_src IS NULL OR position('crm_staff_members' IN staff_src) = 0 THEN
    RAISE EXCEPTION 'Apply 202611040003 (membership-based is_crm_staff) before this migration, in the same transaction.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid IN ('public.psychologist_availability'::regclass, 'public.psychologists'::regclass)
      AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'FORCE ROW LEVEL SECURITY is on for psychologists or psychologist_availability; turn it off or redesign the definer functions first.';
  END IF;
END
$$;

-- 1. Ownership helper (multiple profiles per login supported; no dependency on RLS on psychologists).
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
  'True when the psychologist profile is linked to the caller''s login (psychologists.auth_user_id). (202611040005)';

REVOKE ALL ON FUNCTION public.is_own_psychologist(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_own_psychologist(uuid) TO authenticated;

-- 2. RLS on, and the restrictive guard (AND-ed with every permissive policy, for every command).
ALTER TABLE public.psychologist_availability ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS availability_require_staff_or_owner ON public.psychologist_availability;
CREATE POLICY availability_require_staff_or_owner ON public.psychologist_availability
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING ((SELECT public.is_crm_staff()) OR public.is_own_psychologist(psychologist_id))
  WITH CHECK ((SELECT public.is_crm_staff()) OR public.is_own_psychologist(psychologist_id));

-- 3 + 4. Privileges.
REVOKE ALL ON TABLE public.psychologist_availability FROM PUBLIC, anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.psychologist_availability FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.psychologist_availability TO authenticated;

-- 5. Self-check (NULL-safe).
DO $$
DECLARE
  rls_on boolean;
  rls_forced boolean;
  permissive_count integer;
BEGIN
  SELECT relrowsecurity, relforcerowsecurity INTO rls_on, rls_forced
  FROM pg_class WHERE oid = 'public.psychologist_availability'::regclass;
  IF rls_on IS DISTINCT FROM true OR rls_forced IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'psychologist_availability must have RLS enabled and not forced.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy AS pol
    WHERE pol.polrelid = 'public.psychologist_availability'::regclass
      AND pol.polname = 'availability_require_staff_or_owner'
      AND pol.polpermissive = false
      AND pol.polcmd = '*'
      AND pol.polroles = ARRAY['authenticated'::regrole::oid]
  ) THEN
    RAISE EXCEPTION 'The restrictive availability policy is missing or has the wrong shape.';
  END IF;

  IF has_table_privilege('anon', 'public.psychologist_availability',
                         'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'anon still has privileges on psychologist_availability.';
  END IF;
  IF has_table_privilege('authenticated', 'public.psychologist_availability', 'TRUNCATE') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'authenticated must not be able to TRUNCATE psychologist_availability.';
  END IF;
  IF has_function_privilege('anon', 'public.is_own_psychologist(uuid)', 'EXECUTE') IS DISTINCT FROM false
     OR has_function_privilege('authenticated', 'public.is_own_psychologist(uuid)', 'EXECUTE') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'is_own_psychologist(uuid) has the wrong execute privileges.';
  END IF;

  SELECT count(*) INTO permissive_count FROM pg_policy
  WHERE polrelid = 'public.psychologist_availability'::regclass AND polpermissive;
  RAISE NOTICE 'psychologist_availability: % permissive policies, all limited by availability_require_staff_or_owner.',
    permissive_count;
END
$$;

COMMIT;
