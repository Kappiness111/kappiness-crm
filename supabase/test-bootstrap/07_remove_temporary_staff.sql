-- Kappiness CRM TEST BOOTSTRAP: remove the temporary staff login added by 06_add_temporary_staff.sql.
-- TEST PROJECT ONLY. Requires  SET kappiness.test_env = 'disposable';  Run right after 202611130002.
-- Deleting the auth user cascades to its crm_staff_members row (FK ON DELETE CASCADE).

BEGIN;

DO $$
BEGIN
  IF coalesce(current_setting('kappiness.test_env', true), '') <> 'disposable' THEN
    RAISE EXCEPTION 'Refusing to run: SET kappiness.test_env = ''disposable'' first (test project only).';
  END IF;
END
$$;

DELETE FROM auth.users WHERE id = '00000000-0000-4000-9000-000000000001';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.crm_staff_members) OR EXISTS (SELECT 1 FROM auth.users) THEN
    RAISE EXCEPTION 'Temporary staff login not fully removed: crm_staff_members / auth.users still have rows.';
  END IF;
  RAISE NOTICE 'Temporary staff login removed; crm_staff_members and auth.users are empty again.';
END
$$;

COMMIT;
