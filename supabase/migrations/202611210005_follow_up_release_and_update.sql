-- Kappiness CRM: release a held follow-up slot and update follow-up details.
-- Owner: Sariga (follow-up workflow).
--
-- WHY
--   follow_ups is written only through functions (202611210002/3), but there was no way to release a hold
--   when the client declines, and no way to assign reception staff, change the due date or edit notes.
--
-- WHAT THIS ADDS (nothing existing is changed)
--   release_follow_up_slot(id, declined, note)  staff or the follow-up's psychologist. A held follow-up
--                                               (Tentative / Pending Confirmation) goes back to Upcoming, the
--                                               hold is cleared, confirmation_status = Declined (or Not Requested).
--   update_follow_up(id, assigned_staff_id, due_on, notes)  staff. NULL leaves a value unchanged.
--
-- PREREQUISITES
--   202611210002, 202611210003.
--
-- ROLLBACK
--   BEGIN;
--   DROP FUNCTION IF EXISTS public.release_follow_up_slot(uuid, boolean, text),
--     public.update_follow_up(uuid, uuid, date, text);
--   COMMIT;
--
-- Safe to re-run (CREATE OR REPLACE).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.follow_ups') IS NULL
     OR to_regprocedure('public.propose_follow_up_slot(uuid, timestamptz, uuid, uuid, text)') IS NULL THEN
    RAISE EXCEPTION 'Apply 202611210002 and 202611210003 first.';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.release_follow_up_slot(
  p_follow_up_id uuid,
  p_declined boolean DEFAULT true,
  p_note text DEFAULT NULL
)
RETURNS public.follow_ups
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  f public.follow_ups%ROWTYPE;
BEGIN
  SELECT * INTO f FROM public.follow_ups WHERE id = p_follow_up_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This follow-up no longer exists.' USING ERRCODE = 'P0001';
  END IF;
  IF f.status NOT IN ('Tentative', 'Pending Confirmation') THEN
    RAISE EXCEPTION 'Only a held follow-up slot can be released.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT coalesce(public._can_manage_psychologist(f.psychologist_id), false) THEN
    RAISE EXCEPTION 'You do not have permission to release this slot.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.follow_ups
    SET status = 'Upcoming',
        proposed_starts_at = NULL, proposed_ends_at = NULL, proposed_blocked_until = NULL,
        proposed_service_id = NULL,
        confirmation_status = CASE WHEN coalesce(p_declined, true) THEN 'Declined' ELSE 'Not Requested' END,
        notes = CASE WHEN nullif(btrim(p_note), '') IS NULL THEN notes
                     ELSE left(concat_ws(E'\n', notes, btrim(p_note)), 2000) END,
        updated_by = auth.uid(), updated_by_name = public.current_actor_name(), updated_at = now()
    WHERE id = p_follow_up_id
    RETURNING * INTO f;

  PERFORM public._log_client_activity(f.client_id, 'Follow-up slot released');
  RETURN f;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_follow_up(
  p_follow_up_id uuid,
  p_assigned_staff_id uuid DEFAULT NULL,
  p_due_on date DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS public.follow_ups
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  f public.follow_ups%ROWTYPE;
BEGIN
  IF NOT coalesce(public.is_crm_staff(), false) THEN
    RAISE EXCEPTION 'Only CRM staff can update follow-ups.' USING ERRCODE = '42501';
  END IF;
  IF p_assigned_staff_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.crm_staff_members AS m WHERE m.user_id = p_assigned_staff_id AND m.is_active
  ) THEN
    RAISE EXCEPTION 'Assign the follow-up to an active staff member.' USING ERRCODE = 'P0001';
  END IF;
  IF p_due_on IS NOT NULL AND p_due_on < (now() AT TIME ZONE public.clinic_timezone())::date THEN
    RAISE EXCEPTION 'Choose a due date from today onwards.' USING ERRCODE = '22023';
  END IF;
  IF p_notes IS NOT NULL AND char_length(p_notes) > 2000 THEN
    RAISE EXCEPTION 'Keep the notes under 2000 characters.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO f FROM public.follow_ups WHERE id = p_follow_up_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This follow-up no longer exists.' USING ERRCODE = 'P0001';
  END IF;
  IF f.status IN ('Completed', 'No Follow-up Required') THEN
    RAISE EXCEPTION 'This follow-up is already closed.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.follow_ups
    SET assigned_staff_id = coalesce(p_assigned_staff_id, assigned_staff_id),
        due_on = coalesce(p_due_on, due_on),
        notes = CASE WHEN p_notes IS NULL THEN notes ELSE nullif(btrim(p_notes), '') END,
        updated_by = auth.uid(), updated_by_name = public.current_actor_name(), updated_at = now()
    WHERE id = p_follow_up_id
    RETURNING * INTO f;
  RETURN f;
END;
$$;

REVOKE ALL ON FUNCTION
  public.release_follow_up_slot(uuid, boolean, text),
  public.update_follow_up(uuid, uuid, date, text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.release_follow_up_slot(uuid, boolean, text),
  public.update_follow_up(uuid, uuid, date, text)
TO authenticated;

COMMIT;
