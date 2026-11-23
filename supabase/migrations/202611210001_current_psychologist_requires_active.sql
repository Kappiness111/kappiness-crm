-- Kappiness CRM: psychologist access requires an active psychologist record.
-- Owner: Sariga (psychologist access rules).
--
-- WHY
--   current_psychologist_id() matched auth_user_id only, so a deactivated
--   psychologist still passed every policy and function that uses it.
--   Tested on 14 Nov: with is_active = false the account still saw its appointments.
--
-- WHAT THIS DOES
--   Adds "AND p.is_active" to current_psychologist_id(). Same name, same
--   signature; existing grants are kept.
--
-- AFTER APPLYING
--   Re-run the inactive-psychologist test. Expected: 0 appointments seen.
--
-- ROLLBACK
--   Re-create the function without the is_active condition.
--
-- Safe to re-run (CREATE OR REPLACE).

BEGIN;

CREATE OR REPLACE FUNCTION public.current_psychologist_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id
  FROM public.psychologists AS p
  WHERE p.auth_user_id = auth.uid()
    AND p.is_active
  LIMIT 1;
$$;

COMMIT;
