-- Kappiness CRM TEST BOOTSTRAP: add ONE temporary active staff login before 202611130001.
-- TEST PROJECT ONLY. Requires  SET kappiness.test_env = 'disposable';
--
-- WHY: 202611130001 has a production lock-out guard: it refuses to run when crm_staff_members has no active row
-- (every staff user would be locked out). The empty test project has none, and the SQL suites require an EMPTY
-- crm_staff_members. So the bootstrap adds this one login just for 202611130001 and removes it again with
-- 07_remove_temporary_staff.sql before the suites run.

BEGIN;

DO $$
BEGIN
  IF coalesce(current_setting('kappiness.test_env', true), '') <> 'disposable' THEN
    RAISE EXCEPTION 'Refusing to run: SET kappiness.test_env = ''disposable'' first (test project only).';
  END IF;
  IF EXISTS (SELECT 1 FROM public.crm_staff_members) OR EXISTS (SELECT 1 FROM auth.users) THEN
    RAISE EXCEPTION 'Refusing to run: crm_staff_members / auth.users must be empty (this must be the empty test project).';
  END IF;
END
$$;

INSERT INTO auth.users (id, email, aud, role)
VALUES ('00000000-0000-4000-9000-000000000001', 'bootstrap-temporary-staff@test.invalid', 'authenticated', 'authenticated');

INSERT INTO public.crm_staff_members (user_id, access_level, is_active)
VALUES ('00000000-0000-4000-9000-000000000001', 'staff', true);

COMMIT;
