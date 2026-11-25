-- Kappiness CRM Day 24: BEHAVIOUR CHECK for 20261125120000. Ends in ROLLBACK: changes nothing.
-- Run AFTER the deployment, in the SQL Editor, as one script. Success = "Success. No rows returned";
-- any failure shows BEHAVIOUR FAIL ... and everything is rolled back.
--
-- Simulated Supabase logins (request.jwt.claims + SET LOCAL ROLE), refusal and read-only paths only:
--   B1  anon cannot execute the Day 24 RPCs.
--   B2  a signed-in account without CRM staff membership is refused (42501).
--   B3  a real active staff member: normalize_phone works, find_phone_matches answers, record_communication and
--       convert_lead_to_existing_client reach their lead lookup ("This lead no longer exists" for a random id).
-- The full workflow (duplicates, linking, conversion, communication) is covered by
-- supabase/tests/client_management_day24_test.sql on a disposable database, not here.

BEGIN;

SELECT set_config('deploy.staff_uid',
         coalesce((SELECT user_id::text FROM public.crm_staff_members WHERE is_active ORDER BY created_at LIMIT 1), ''),
         true);

-- B1
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
DO $$
BEGIN
  BEGIN
    PERFORM public.record_communication(gen_random_uuid(), NULL, 'Call', 'Call Completed', NULL, NULL);
    RAISE EXCEPTION 'BEHAVIOUR FAIL B1: anon executed record_communication';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.find_phone_matches('9876543210', NULL);
    RAISE EXCEPTION 'BEHAVIOUR FAIL B1: anon executed find_phone_matches';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.communication_events LIMIT 1;
    RAISE EXCEPTION 'BEHAVIOUR FAIL B1: anon read communication_events';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
RESET ROLE;

-- B2
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid()::text, 'role', 'authenticated')::text, true);
DO $$
BEGIN
  BEGIN
    PERFORM public.link_lead_to_client(gen_random_uuid(), gen_random_uuid(), NULL);
    RAISE EXCEPTION 'BEHAVIOUR FAIL B2: a non-staff account passed the staff check';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM public.communication_events) OR EXISTS (SELECT 1 FROM public.client_directory) THEN
    RAISE EXCEPTION 'BEHAVIOUR FAIL B2: a non-staff account can read communication or clients';
  END IF;
END
$$;
RESET ROLE;

-- B3
DO $$
BEGIN
  IF coalesce(current_setting('deploy.staff_uid', true), '') = '' THEN
    RAISE EXCEPTION 'BEHAVIOUR FAIL B3: no active crm_staff_members row to simulate.';
  END IF;
END
$$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
         json_build_object('sub', current_setting('deploy.staff_uid', true), 'role', 'authenticated')::text, true);
DO $$
DECLARE
  v jsonb;
BEGIN
  IF public.normalize_phone('+91 98765-43210') <> '+919876543210' OR public.normalize_phone('+44 7911 123456') <> '+447911123456' THEN
    RAISE EXCEPTION 'BEHAVIOUR FAIL B3: normalize_phone';
  END IF;
  v := public.find_phone_matches('+00 0000', NULL);
  IF v IS NULL OR NOT v ? 'clients' THEN RAISE EXCEPTION 'BEHAVIOUR FAIL B3: find_phone_matches'; END IF;
  BEGIN
    PERFORM public.record_communication(gen_random_uuid(), NULL, 'Call', 'Call Completed', NULL, NULL);
    RAISE EXCEPTION 'BEHAVIOUR FAIL B3: recording for a missing lead did not fail';
  EXCEPTION
    WHEN insufficient_privilege THEN RAISE EXCEPTION 'BEHAVIOUR FAIL B3: staff refused: %', SQLERRM;
    WHEN raise_exception THEN
      IF SQLERRM LIKE 'BEHAVIOUR FAIL%' THEN RAISE; END IF;
      IF SQLERRM NOT LIKE 'This lead no longer exists%' THEN RAISE EXCEPTION 'BEHAVIOUR FAIL B3: %', SQLERRM; END IF;
  END;
  BEGIN
    PERFORM public.convert_lead_to_existing_client(gen_random_uuid(), 'Interested', gen_random_uuid(), gen_random_uuid(),
              gen_random_uuid(), now() + interval '1 day', NULL, NULL);
    RAISE EXCEPTION 'BEHAVIOUR FAIL B3: converting a missing lead did not fail';
  EXCEPTION
    WHEN insufficient_privilege THEN RAISE EXCEPTION 'BEHAVIOUR FAIL B3: staff refused: %', SQLERRM;
    WHEN raise_exception THEN
      IF SQLERRM LIKE 'BEHAVIOUR FAIL%' THEN RAISE; END IF;
      IF SQLERRM NOT LIKE 'This lead no longer exists%' THEN RAISE EXCEPTION 'BEHAVIOUR FAIL B3: %', SQLERRM; END IF;
  END;
END
$$;
RESET ROLE;

ROLLBACK;
