-- Kappiness CRM: keep lead (sales) records for CRM staff only.
--
-- Apply AFTER 202611040001 (it defines public.is_crm_staff()).
--
-- WHY: psychologists work with client profiles (public.clients), not leads. The existing policies on
-- public.leads and public.lead_activities are not in this repository, so they may let any signed-in user
-- (including psychologists) read every lead. RESTRICTIVE policies are AND-ed with whatever permissive
-- policies exist, so this narrows access without dropping or editing any existing policy.
--
-- EFFECT: signed-in users who are not CRM staff (psychologists) can no longer read or write leads or
-- lead_activities. Staff access is unchanged. The SQL editor / service role is unaffected.
--
-- BEFORE APPLYING, review the current policies:
--   SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
--   FROM pg_policies
--   WHERE schemaname = 'public'
--     AND tablename IN ('leads', 'lead_activities', 'psychologists', 'psychologist_availability')
--   ORDER BY tablename, policyname;
--
--   And check that RLS is on:
--   SELECT relname, relrowsecurity FROM pg_class
--   WHERE relnamespace = 'public'::regnamespace AND relname IN ('leads', 'lead_activities');
--
-- ROLLBACK: DROP POLICY leads_staff_only ON public.leads; DROP POLICY lead_activities_staff_only ON public.lead_activities;

BEGIN;

-- If RLS is currently OFF on a table, turning it on with only a restrictive policy would block everyone.
-- In that case add a permissive staff policy first, so staff keep exactly the access they have today.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['leads', 'lead_activities'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = format('public.%I', t)::regclass) THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_staff_all', t);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (public.is_crm_staff()) WITH CHECK (public.is_crm_staff())',
        t || '_staff_all', t);
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      RAISE NOTICE 'RLS was off on public.%; enabled it with a staff policy.', t;
    END IF;
  END LOOP;
END
$$;

DROP POLICY IF EXISTS leads_staff_only ON public.leads;
CREATE POLICY leads_staff_only ON public.leads
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (public.is_crm_staff())
  WITH CHECK (public.is_crm_staff());

DROP POLICY IF EXISTS lead_activities_staff_only ON public.lead_activities;
CREATE POLICY lead_activities_staff_only ON public.lead_activities
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (public.is_crm_staff())
  WITH CHECK (public.is_crm_staff());

COMMIT;
