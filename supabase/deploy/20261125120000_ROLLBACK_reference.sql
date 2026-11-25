-- Kappiness CRM Day 24: ROLLBACK REFERENCE for 20261125120000. READ IT BEFORE USING IT. Not part of any deployment.
--
-- What it does: removes the Day 24 functions, view, triggers and tables, the two client columns and indexes, the
-- activity_log_client_audit_read policy (Day 24 client audit ROWS stay in activity_log, which is append-only), and
-- restores the 202611040001 body of sync_client_from_lead.
--
-- DATA LOSS: communication_events (communication history) and lead_client_links (which enquiries belong to which
-- existing client) are DROPPED. clients.referral_source is DROPPED. Export them first if they must be kept:
--   SELECT * FROM public.communication_events; SELECT * FROM public.lead_client_links;
--   SELECT id, referral_source FROM public.clients;
-- Appointments booked for existing clients through linked enquiries stay (they belong to that client).
--
-- RISK AFTER ROLLBACK: a Confirmed lead that was linked has no client of its own. With the old trigger, changing
-- that lead's psychologist would try to create a second client for the same person. The guard below refuses to roll
-- back while such leads exist unless you SET kappiness.d24_rollback_ack = 'yes' in the same session first.

BEGIN;

DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM public.lead_client_links AS k JOIN public.leads AS l ON l.id = k.lead_id WHERE l.status = 'Confirmed';
  IF n > 0 AND coalesce(current_setting('kappiness.d24_rollback_ack', true), '') <> 'yes' THEN
    RAISE EXCEPTION '% Confirmed lead(s) are linked to an existing client. Read the RISK note, then SET kappiness.d24_rollback_ack = ''yes''.', n;
  END IF;
END
$$;

DROP VIEW IF EXISTS public.client_directory;
DROP FUNCTION IF EXISTS public.convert_lead_to_existing_client(uuid, text, uuid, uuid, uuid, timestamptz, text, text);
DROP FUNCTION IF EXISTS public.link_lead_to_client(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.unlink_lead_from_client(uuid, text);
DROP FUNCTION IF EXISTS public.find_phone_matches(text, uuid);
DROP FUNCTION IF EXISTS public.set_client_active(uuid, boolean, text);
DROP FUNCTION IF EXISTS public.update_client_details(uuid, jsonb, timestamptz);
DROP FUNCTION IF EXISTS public.record_communication(uuid, uuid, text, text, text, timestamptz);
DROP TRIGGER IF EXISTS clients_audit_changes ON public.clients;
DROP TRIGGER IF EXISTS clients_guard_deactivation ON public.clients;
DROP FUNCTION IF EXISTS public.clients_audit_changes();
DROP FUNCTION IF EXISTS public.clients_guard_deactivation();

-- The 202611040001 body (fingerprint 4109aa9bd681941e084d44732f35a38c).
CREATE OR REPLACE FUNCTION public.sync_client_from_lead()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  lead jsonb := to_jsonb(NEW);
BEGIN
  IF NEW.status = 'Confirmed' AND NEW.assigned_psychologist_id IS NOT NULL THEN
    INSERT INTO public.clients (
      lead_id, full_name, phone, email, city, preferred_language, preferred_contact, best_time,
      service_interest, primary_psychologist_id
    ) VALUES (
      NEW.id,
      coalesce(nullif(btrim(lead ->> 'full_name'), ''), 'Client'),
      lead ->> 'phone', lead ->> 'email', lead ->> 'city', lead ->> 'preferred_language',
      coalesce(lead ->> 'preferred_contact', lead ->> 'contact_method'), lead ->> 'best_time',
      lead ->> 'service_interest', NEW.assigned_psychologist_id
    )
    ON CONFLICT (lead_id) DO UPDATE
      SET primary_psychologist_id = EXCLUDED.primary_psychologist_id, updated_at = now()
      WHERE public.clients.primary_psychologist_id IS DISTINCT FROM EXCLUDED.primary_psychologist_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TABLE IF EXISTS public.communication_events;
DROP FUNCTION IF EXISTS public.communication_events_append_only();
DROP TABLE IF EXISTS public.lead_client_links;

DROP POLICY IF EXISTS activity_log_client_audit_read ON public.activity_log;
DROP INDEX IF EXISTS public.clients_phone_normalized_key;
DROP INDEX IF EXISTS public.idx_clients_phone_normalized;
DROP INDEX IF EXISTS public.idx_leads_phone_normalized;
DROP INDEX IF EXISTS public.idx_clients_full_name;
ALTER TABLE public.clients DROP COLUMN IF EXISTS phone_normalized;
ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_referral_source_length;
ALTER TABLE public.clients DROP COLUMN IF EXISTS referral_source;
DROP FUNCTION IF EXISTS public.normalize_phone(text);

DO $$
BEGIN
  IF md5(replace((SELECT prosrc FROM pg_proc WHERE oid = 'public.sync_client_from_lead()'::regprocedure), E'\r', ''))
     <> '4109aa9bd681941e084d44732f35a38c' THEN
    RAISE EXCEPTION 'ROLLBACK CHECK: sync_client_from_lead was not restored exactly.';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
