-- Kappiness CRM Day 23: BEHAVIOUR CHECK for convert_lead_to_appointment. Ends in ROLLBACK: changes nothing.
-- Run AFTER the deployment, in the SQL Editor, as one script. Success = "Success. No rows returned";
-- any failure shows BEHAVIOUR FAIL ... and everything is rolled back.
--
-- Same technique as 202611130003_04_behaviour_check.sql: simulated Supabase logins (request.jwt.claims +
-- SET LOCAL ROLE). Only refusal paths are exercised, so the function never reaches a write:
--   B1  anon cannot execute the RPC at all.
--   B2  a signed-in account that is not CRM staff is refused by the RPC's staff check (42501).
--   B3  a real active staff member reaches the lead lookup and gets "This lead no longer exists" for a random id:
--       proves the grant, SECURITY INVOKER execution and the staff check pass for staff, without touching any lead.
-- Not exercised here (would write data): a full conversion. See the post-deployment steps for the app smoke test.

BEGIN;

SELECT set_config('deploy.staff_uid',
         coalesce((SELECT user_id::text FROM public.crm_staff_members WHERE is_active ORDER BY created_at LIMIT 1), ''),
         true);

-- B1. anon: no EXECUTE privilege.
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
DO $$
BEGIN
  BEGIN
    PERFORM public.convert_lead_to_appointment(gen_random_uuid(), 'Interested', gen_random_uuid(), gen_random_uuid(),
                                               now() + interval '1 day', NULL);
    RAISE EXCEPTION 'BEHAVIOUR FAIL B1: anon executed convert_lead_to_appointment';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- expected: permission denied for function
  END;
END
$$;
RESET ROLE;

-- B2. A signed-in account with no CRM staff membership (random user id).
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
         json_build_object('sub', gen_random_uuid()::text, 'role', 'authenticated')::text, true);
DO $$
BEGIN
  BEGIN
    PERFORM public.convert_lead_to_appointment(gen_random_uuid(), 'Interested', gen_random_uuid(), gen_random_uuid(),
                                               now() + interval '1 day', NULL);
    RAISE EXCEPTION 'BEHAVIOUR FAIL B2: a non-staff account passed the staff check';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE 'Only CRM staff can convert leads%' THEN
      RAISE EXCEPTION 'BEHAVIOUR FAIL B2: refused for an unexpected reason: %', SQLERRM;
    END IF;
  END;
END
$$;
RESET ROLE;

-- B3. A real active staff member, a lead id that does not exist.
DO $$
BEGIN
  IF current_setting('deploy.staff_uid', true) IS NULL OR current_setting('deploy.staff_uid', true) = '' THEN
    RAISE EXCEPTION 'BEHAVIOUR FAIL B3: no active crm_staff_members row to simulate.';
  END IF;
END
$$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
         json_build_object('sub', current_setting('deploy.staff_uid', true), 'role', 'authenticated')::text, true);
DO $$
BEGIN
  BEGIN
    PERFORM public.convert_lead_to_appointment(gen_random_uuid(), 'Interested', gen_random_uuid(), gen_random_uuid(),
                                               now() + interval '1 day', NULL);
    RAISE EXCEPTION 'BEHAVIOUR FAIL B3: converting a non-existent lead did not fail';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'BEHAVIOUR FAIL B3: active staff was refused: %', SQLERRM;
    WHEN raise_exception THEN
      IF SQLERRM LIKE 'BEHAVIOUR FAIL%' THEN RAISE; END IF;
      IF SQLERRM NOT LIKE 'This lead no longer exists%' THEN
        RAISE EXCEPTION 'BEHAVIOUR FAIL B3: unexpected error: %', SQLERRM;
      END IF;
  END;
END
$$;
RESET ROLE;

ROLLBACK;
