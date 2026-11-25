-- Kappiness CRM (Day 24): client management, phone-number matching (shared numbers allowed), linking a new enquiry
-- to an existing client, and communication tracking for leads and clients.
-- Owner: Aswathy (backend / database).
--
-- WHY
--   * clients had no referral source, and a second enquiry from an existing client could only become a second
--     client (sync_client_from_lead creates one client per Confirmed lead), splitting that person's appointments and
--     history. There was no way to see that a new enquiry's phone number already belongs to a client.
--   * TEAM DECISION (25 Nov 2026): a phone number is NOT unique. Different people (a parent and a child, a couple)
--     may share one number and each have their own client profile. A matching number is a suggestion shown to staff,
--     never a restriction, and nothing is ever linked, merged, changed or deleted automatically because of it.
--   * Communication with leads and clients (calls, WhatsApp, reminders and the client's answer) was only tracked
--     for follow-ups (follow_up_contacts, 202611210002). lead_activities is lead-only, has free-text staff names
--     and no communication status.
--
-- WHAT THIS ADDS / CHANGES
--   1. public.normalize_phone(text)          IMMUTABLE. One canonical form per phone number (rules below).
--   2. clients.referral_source               text. Backfilled ONCE from the client's original lead (leads.source),
--                                            only where it is NULL; set from the lead for new clients.
--      clients.phone_normalized              STORED generated column = normalize_phone(phone).
--      Index idx_clients_phone_normalized    NON-unique (shared numbers are allowed); it serves the phone lookup.
--                                            A unique index from an earlier draft (clients_phone_normalized_key) is
--                                            dropped if present.
--      Index idx_leads_phone_normalized      expression index for the phone-match lookup on leads.
--   3. public.lead_client_links              one row per lead that belongs to an EXISTING client (lead_id is the
--                                            primary key). Written only by link_lead_to_client /
--                                            unlink_lead_from_client / convert_lead_to_existing_client.
--   4. public.sync_client_from_lead()        REPLACED (same trigger, signature and settings):
--                                              - a lead linked to an existing client never creates a second client;
--                                              - a new client gets referral_source = the lead's source.
--                                            Everything else is the 202611040001 body unchanged (a lead that is not
--                                            linked still gets its own client, even if the number is shared).
--   5. public.communication_events           append-only communication history for ONE lead or ONE client:
--                                            channel, communication status, notes, who (auth.uid() + display name)
--                                            and when. Written only by record_communication(). Separate from lead,
--                                            client, appointment, session and follow-up statuses.
--   6. Client audit: trigger clients_audit_changes writes every change of a client's details or Active/Inactive
--      status to public.activity_log (202611210004, table unchanged), with the actor, old/new values and the reason.
--      TEAM DECISION: psychologists may read these. Policy activity_log_client_audit_read lets a caller read
--      entity_type = 'client' rows of exactly the clients they can read under clients_read (staff: all; a
--      psychologist: their own clients and clients booked with them), evaluated at read time, so a reassignment
--      takes effect immediately. Audit rows store psychologist_id NULL so that Sariga's activity_log_read policy
--      (unchanged) does not also grant them by a stored, possibly outdated, psychologist. No write grant: append-only.
--      Trigger clients_guard_deactivation refuses to mark a client inactive while they still have any Scheduled /
--      Confirmed appointment (future, or past and awaiting attendance) or a follow-up slot hold (nothing is cancelled
--      automatically).
--   7. Functions
--        find_phone_matches(p_phone, p_exclude_lead_id)       staff; ALL clients and leads with the same number
--        link_lead_to_client(p_lead_id, p_client_id, p_note)  staff; records the link + lead history
--        unlink_lead_from_client(p_lead_id, p_reason)         staff; only before the lead is Confirmed
--        convert_lead_to_existing_client(...)                 staff; Day 23 conversion for a returning client
--        update_client_details(p_client_id, p_changes, p_expected_updated_at)  staff
--        set_client_active(p_client_id, p_active, p_reason)   staff
--        record_communication(p_lead_id, p_client_id, p_channel, p_status, p_notes, p_occurred_at)  staff
--   8. View public.client_directory (security_invoker): clients + psychologist name, total completed sessions,
--      last and next appointment, original lead code and number of linked enquiries.
--
-- PHONE NORMALISATION (the clinic is in India; numbers abroad must be entered with their country code, which the
-- Add Lead form already asks for)
--   spaces, hyphens, dots, brackets and a trailing extension (ext / x / #) are ignored;
--   "+<digits>" or "00<digits>"          -> "+<digits>" (8 to 15 digits), "+91 0XXXXXXXXXX" -> "+91XXXXXXXXXX";
--   10 digits                            -> "+91" + digits;
--   11 digits starting with 0            -> "+91" + last 10;
--   12 digits starting with 91           -> "+" + digits;
--   anything else with 7 to 15 digits    -> the digits as they are (no country is assumed, so such a number only
--                                           matches the very same digits; it never matches a "+" number);
--   fewer than 7 digits                  -> NULL (not a phone number; never matched).
--   So +44 7911 123456 and +91 79111 23456 are different numbers, while "98765 43210", "+91-98765-43210",
--   "(0)98765 43210" and "0091 9876543210" are the same.
--   app/lib/phone.js implements the same rules for instant feedback; the database stays the authority.
--
-- EXISTING DATA: no client, lead, appointment, session or history row is deleted, merged, deactivated or linked.
--   The only existing rows written are clients.referral_source (NULL -> the original lead's source). Existing clients
--   that share a phone number are allowed and do NOT block the migration: it only reports counts (shared-number
--   groups, and possible duplicate profiles = same number AND same name). The team reviews them individually with
--   supabase/deploy/20261125120000_01_preflight_report.sql.
--
-- NOT CHANGED: lead statuses and transitions (enforce_lead_workflow), update_lead_with_history,
--   convert_lead_to_appointment (Day 23), book_appointment, reschedule_appointment, cancel/confirm/attendance,
--   existing RLS policies and grants, follow-up tables and functions (only read), activity_log's columns, grants,
--   trigger and existing policy (one SELECT policy added; rows appended only).
--
-- SECURITY: new tables have RLS on, staff-only read policies, and no write grants for anon / authenticated
--   (functions only). SECURITY DEFINER functions check is_crm_staff() first and use search_path = public.
--   convert_lead_to_existing_client and find_phone_matches are SECURITY INVOKER like convert_lead_to_appointment
--   (the caller's RLS applies). Nothing is granted to anon or PUBLIC. activity_log gets one extra SELECT policy
--   (client audit rows, scoped by clients_read); communication history and enquiry links stay staff-only.
--
-- PREREQUISITES (checked): 202611040001, 202611130001, 202611210002 (follow_ups), 202611210004 (activity_log),
--   20261123161850 (Day 21), 20261123223548 (Day 23). Function bodies this relies on are pinned by fingerprint.
--
-- DEPLOYMENT: do NOT use `supabase db push`. Run supabase/deploy/20261125120000_01_preflight_report.sql (read-only)
--   first, then this whole file in the SQL Editor, then _03_postdeploy_report.sql and _04_behaviour_check.sql
--   (ends in ROLLBACK). Rollback reference: supabase/deploy/20261125120000_ROLLBACK_reference.sql.
--   Ship the app changes at the same time or after this migration (the app reads the new columns and RPCs).
--
-- Safe to re-run: CREATE OR REPLACE / IF NOT EXISTS, and the preflight accepts the Day 24 sync_client_from_lead.

BEGIN;

SET LOCAL lock_timeout = '10s';

-- Lock in a fixed order so the shared-number report, the backfill and the indexes see one consistent state.
LOCK TABLE public.leads IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.clients IN SHARE ROW EXCLUSIVE MODE;

/* =====================================================================
   0. Preflight (dependencies)
   ===================================================================== */
DO $$
DECLARE
  v_text text;
  v_md5 text;
  v_fn record;
BEGIN
  IF to_regclass('public.leads') IS NULL OR to_regclass('public.lead_activities') IS NULL
     OR to_regclass('public.clients') IS NULL OR to_regclass('public.appointments') IS NULL
     OR to_regclass('public.sessions') IS NULL OR to_regclass('public.psychologists') IS NULL
     OR to_regclass('public.crm_staff_members') IS NULL OR to_regclass('public.follow_ups') IS NULL
     OR to_regclass('public.follow_up_contacts') IS NULL OR to_regclass('public.activity_log') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: a required table is missing (apply 202611040001, 202611130001, 202611210002 and 202611210004 first).';
  END IF;
  IF to_regprocedure('public.convert_lead_to_appointment(uuid,text,uuid,uuid,timestamptz,text)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: convert_lead_to_appointment is missing (apply 20261123223548 first).';
  END IF;
  IF position('crm_staff_members' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.is_crm_staff()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'PREFLIGHT: is_crm_staff() is not membership-based (apply 202611130001 first).';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_text
  FROM pg_constraint WHERE conrelid = 'public.leads'::regclass AND conname = 'leads_status_check';
  IF v_text IS DISTINCT FROM
     'CHECK ((status = ANY (ARRAY[''New Lead''::text, ''Contacted''::text, ''Interested''::text, ''Follow-up Required''::text, ''Awaiting Confirmation''::text, ''Confirmed''::text, ''Not Interested''::text, ''Lost Lead''::text])))' THEN
    RAISE EXCEPTION 'PREFLIGHT: leads_status_check is not the Day 21 eight-status constraint: %', coalesce(v_text, '(missing)');
  END IF;

  -- Functions this migration calls or replaces must be the reviewed versions.
  FOR v_fn IN
    SELECT * FROM (VALUES
      ('public.update_lead_with_history(uuid,text,jsonb,jsonb)', ARRAY['0a62ea753396e7da751446e34373c29e'], '20261123161850'),
      ('public.enforce_lead_workflow()', ARRAY['7c9f820ac5dd11e57e6b4a11b2785a6b'], '20261123161850'),
      ('public.book_appointment(uuid,uuid,uuid,timestamptz,text,uuid,text)', ARRAY['0c25ffb3cfa622fdeb53041a496b7ade'], '202611040001'),
      ('public.convert_lead_to_appointment(uuid,text,uuid,uuid,timestamptz,text)', ARRAY['d61213476b5d2537d729a08e91a008eb'], '20261123223548'),
      -- 202611040001 body, an earlier (never deployed) Day 24 draft, or this migration's body (re-run).
      ('public.sync_client_from_lead()', ARRAY['4109aa9bd681941e084d44732f35a38c', '23111b570f26fbfe2c75dd2d8b74f64f', '913c7560fceaa9e09468c3e6cb298a83'], '202611040001 / 20261125120000')
    ) AS f(sig, expected, source)
  LOOP
    SELECT md5(replace(prosrc, E'\r', '')) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure(v_fn.sig);
    IF v_md5 IS NULL OR NOT v_md5 = ANY(v_fn.expected) THEN
      RAISE EXCEPTION 'PREFLIGHT: % is not the % version (md5 %). Review the change before applying.',
        v_fn.sig, v_fn.source, coalesce(v_md5, 'missing');
    END IF;
  END LOOP;

  SELECT string_agg(t.tgname::text || ':' || t.tgenabled::text, ',' ORDER BY t.tgname) INTO v_text
  FROM pg_trigger AS t WHERE t.tgrelid = 'public.leads'::regclass AND NOT t.tgisinternal;
  IF v_text IS DISTINCT FROM 'leads_enforce_workflow:O,leads_sync_client:O,set_lead_code:O' THEN
    RAISE EXCEPTION 'PREFLIGHT: unexpected triggers on leads: %', coalesce(v_text, '(none)');
  END IF;

  -- A phone_normalized column or the links table created by something else would need a look first.
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'clients'
             AND column_name = 'phone_normalized' AND is_generated <> 'ALWAYS') THEN
    RAISE EXCEPTION 'PREFLIGHT: clients.phone_normalized exists and is not a generated column.';
  END IF;
END
$$;

-- Fingerprints of existing data, compared again at the end.
CREATE TEMP TABLE _d24_before ON COMMIT DROP AS
SELECT
  (SELECT count(*) FROM public.leads) AS leads_n,
  (SELECT md5(coalesce(string_agg(to_jsonb(l)::text, '|' ORDER BY l.id), '')) FROM public.leads AS l) AS leads_md5,
  (SELECT count(*) FROM public.lead_activities) AS activities_n,
  (SELECT count(*) FROM public.clients) AS clients_n,
  (SELECT md5(coalesce(string_agg((to_jsonb(c) - 'referral_source' - 'phone_normalized')::text, '|' ORDER BY c.id), ''))
     FROM public.clients AS c) AS clients_md5,
  (SELECT count(*) FROM public.appointments) AS appointments_n,
  (SELECT count(*) FROM public.sessions) AS sessions_n;

/* =====================================================================
   1. Phone normalisation
   ===================================================================== */
CREATE OR REPLACE FUNCTION public.normalize_phone(p_phone text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = ''
AS $$
DECLARE
  v text := btrim(p_phone);
  d text;
  plus boolean;
BEGIN
  -- A trailing extension is not part of the number.
  v := regexp_replace(v, '\s*(ext\.?|extension|x|#)\s*[0-9]{1,6}\s*$', '', 'i');
  -- The number is international when its first digit-or-plus character is '+': "(+44) ...", "Tel: +44 ..." and
  -- leading tabs / non-breaking spaces do not hide the country code.
  plus := left(regexp_replace(v, '[^0-9+]', '', 'g'), 1) = '+';
  d := regexp_replace(v, '[^0-9]', '', 'g');
  IF d = '' THEN
    RETURN NULL;
  END IF;
  IF NOT plus AND left(d, 2) = '00' THEN
    plus := true;
    d := substr(d, 3);
  END IF;
  IF plus THEN
    -- India written with the national trunk prefix after the country code: +91 0XXXXXXXXXX.
    IF length(d) = 13 AND left(d, 3) = '910' THEN
      d := '91' || substr(d, 4);
    END IF;
    IF length(d) BETWEEN 8 AND 15 THEN
      RETURN '+' || d;
    END IF;
    RETURN NULL;
  END IF;
  IF length(d) = 10 THEN
    RETURN '+91' || d;
  END IF;
  IF length(d) = 11 AND left(d, 1) = '0' THEN
    RETURN '+91' || substr(d, 2);
  END IF;
  IF length(d) = 12 AND left(d, 2) = '91' THEN
    RETURN '+' || d;
  END IF;
  -- Unknown format without a country code: compared exactly, never assumed to be Indian.
  IF length(d) BETWEEN 7 AND 15 THEN
    RETURN d;
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.normalize_phone(text) IS
  'Day 24 (20261125120000): canonical phone number (India default, +country kept). Mirrored by app/lib/phone.js. Used by the stored column clients.phone_normalized: changing it requires recomputing that column.';

REVOKE ALL ON FUNCTION public.normalize_phone(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.normalize_phone(text) TO authenticated, service_role;

/* =====================================================================
   2. Existing shared numbers: report only (counts, no personal data). Never blocks, never changes data.
   ===================================================================== */
DO $$
DECLARE
  v_groups integer;
  v_clients integer;
  v_same_name integer;
  v_unparsed integer;
BEGIN
  SELECT count(*), coalesce(sum(g.cnt), 0) INTO v_groups, v_clients
  FROM (SELECT public.normalize_phone(c.phone) AS n, count(*) AS cnt FROM public.clients AS c
        WHERE public.normalize_phone(c.phone) IS NOT NULL GROUP BY 1 HAVING count(*) > 1) AS g;
  -- Same number AND same name: more likely one person entered twice than a family sharing a phone.
  SELECT count(*) INTO v_same_name
  FROM (SELECT 1 FROM public.clients AS c WHERE public.normalize_phone(c.phone) IS NOT NULL
        GROUP BY public.normalize_phone(c.phone), lower(btrim(c.full_name)) HAVING count(*) > 1) AS g;
  SELECT count(*) INTO v_unparsed FROM public.clients AS c
  WHERE c.phone IS NULL OR public.normalize_phone(c.phone) IS NULL;
  RAISE NOTICE 'Shared phone numbers (allowed): % number(s) used by % client(s). Possible duplicate profiles (same number and same name): % group(s). Clients without a recognisable phone: %. Nothing is changed; review with supabase/deploy/20261125120000_01_preflight_report.sql.',
    v_groups, v_clients, v_same_name, v_unparsed;
END
$$;

/* =====================================================================
   3. Client columns and indexes
   ===================================================================== */
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS referral_source text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.clients'::regclass
                 AND conname = 'clients_referral_source_length') THEN
    ALTER TABLE public.clients ADD CONSTRAINT clients_referral_source_length
      CHECK (referral_source IS NULL OR char_length(referral_source) BETWEEN 1 AND 80);
  END IF;
END
$$;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS phone_normalized text GENERATED ALWAYS AS (public.normalize_phone(phone)) STORED;

-- Shared numbers are allowed (team decision): a NON-unique index for lookups. A unique index from an earlier,
-- never-deployed draft of this migration is removed if a database has it.
DROP INDEX IF EXISTS public.clients_phone_normalized_key;
CREATE INDEX IF NOT EXISTS idx_clients_phone_normalized
  ON public.clients (phone_normalized) WHERE phone_normalized IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_phone_normalized ON public.leads (public.normalize_phone(phone));
CREATE INDEX IF NOT EXISTS idx_clients_full_name ON public.clients (lower(full_name));

COMMENT ON COLUMN public.clients.referral_source IS
  'Day 24: how the client first came to the clinic (first-touch). Copied from the original lead''s source; never overwritten by a later linked enquiry. Staff may correct it on the client profile.';
COMMENT ON COLUMN public.clients.phone_normalized IS
  'Day 24: normalize_phone(phone). Not unique: family members may share a number. Used to suggest matching clients.';

-- One-time backfill of the new column from each client's original lead. Only NULLs are filled.
UPDATE public.clients AS c
SET referral_source = left(btrim(l.source), 80)
FROM public.leads AS l
WHERE l.id = c.lead_id
  AND c.referral_source IS NULL
  AND nullif(btrim(l.source), '') IS NOT NULL;

/* =====================================================================
   4. Lead -> existing client links
   ===================================================================== */
CREATE TABLE IF NOT EXISTS public.lead_client_links (
  lead_id uuid PRIMARY KEY REFERENCES public.leads(id) ON DELETE RESTRICT,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
  match_basis text NOT NULL CHECK (match_basis IN ('phone', 'manual')),
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  linked_by uuid NOT NULL,
  linked_by_name text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lead_client_links_client ON public.lead_client_links (client_id, linked_at);

COMMENT ON TABLE public.lead_client_links IS
  'Day 24: an enquiry (lead) that belongs to an EXISTING client. The client''s original lead stays clients.lead_id. Written only by link_lead_to_client / unlink_lead_from_client / convert_lead_to_existing_client.';

/* =====================================================================
   5. Client creation from a Confirmed lead (replaces the 202611040001 body)
   ===================================================================== */
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
    -- Day 24: an enquiry linked to an existing client never creates a second client profile.
    IF EXISTS (SELECT 1 FROM public.lead_client_links AS k WHERE k.lead_id = NEW.id) THEN
      RETURN NEW;
    END IF;
    -- Not linked: the lead gets its own client, even when another client shares the phone number (allowed).
    INSERT INTO public.clients (
      lead_id, full_name, phone, email, city, preferred_language, preferred_contact, best_time,
      service_interest, primary_psychologist_id, referral_source
    ) VALUES (
      NEW.id,
      coalesce(nullif(btrim(lead ->> 'full_name'), ''), 'Client'),
      lead ->> 'phone', lead ->> 'email', lead ->> 'city', lead ->> 'preferred_language',
      coalesce(lead ->> 'preferred_contact', lead ->> 'contact_method'), lead ->> 'best_time',
      lead ->> 'service_interest', NEW.assigned_psychologist_id,
      left(nullif(btrim(lead ->> 'source'), ''), 80)
    )
    ON CONFLICT (lead_id) DO UPDATE
      SET primary_psychologist_id = EXCLUDED.primary_psychologist_id, updated_at = now()
      WHERE public.clients.primary_psychologist_id IS DISTINCT FROM EXCLUDED.primary_psychologist_id;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_client_from_lead() FROM PUBLIC, anon, authenticated;

/* =====================================================================
   6. Communication history (leads and clients)
   ===================================================================== */
CREATE TABLE IF NOT EXISTS public.communication_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES public.leads(id) ON DELETE RESTRICT,
  client_id uuid REFERENCES public.clients(id) ON DELETE RESTRICT,
  channel text NOT NULL CHECK (channel IN ('Call', 'WhatsApp', 'SMS', 'Email', 'Reminder', 'In person', 'Other')),
  communication_status text NOT NULL
    CHECK (communication_status IN ('Reminder Pending', 'Message Sent', 'Call Completed', 'Client Responded',
                                    'No Response', 'Client Will Inform')),
  previous_status text
    CHECK (previous_status IS NULL OR previous_status IN ('Reminder Pending', 'Message Sent', 'Call Completed',
                                    'Client Responded', 'No Response', 'Client Will Inform')),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid NOT NULL,
  recorded_by_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT communication_events_one_subject CHECK (num_nonnulls(lead_id, client_id) = 1),
  CONSTRAINT communication_events_not_future CHECK (occurred_at <= created_at + interval '5 minutes'),
  -- A completed call is a call; a sent message went out on a messaging channel.
  CONSTRAINT communication_events_status_channel CHECK (
    (communication_status <> 'Call Completed' OR channel = 'Call')
    AND (communication_status <> 'Message Sent' OR channel IN ('WhatsApp', 'SMS', 'Email', 'Reminder'))
  )
);
CREATE INDEX IF NOT EXISTS idx_communication_events_lead ON public.communication_events (lead_id, occurred_at DESC)
  WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_communication_events_client ON public.communication_events (client_id, occurred_at DESC)
  WHERE client_id IS NOT NULL;

COMMENT ON TABLE public.communication_events IS
  'Day 24: append-only communication history of one lead or one client (channel, communication status, notes, who, when). Written only by record_communication(). Follow-up communications stay in follow_up_contacts.';

CREATE OR REPLACE FUNCTION public.communication_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'Communication history cannot be changed or deleted. Record a new entry instead.' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS communication_events_append_only ON public.communication_events;
CREATE TRIGGER communication_events_append_only
  BEFORE UPDATE OR DELETE ON public.communication_events
  FOR EACH ROW
  EXECUTE FUNCTION public.communication_events_append_only();

-- Record a communication. The previous status is the subject's latest entry, read under a lock on the subject so two
-- staff recording at the same moment get a consistent trail. There is no automatic entry: opening WhatsApp, a tel:
-- link or a message template never calls this.
CREATE OR REPLACE FUNCTION public.record_communication(
  p_lead_id uuid,
  p_client_id uuid,
  p_channel text,
  p_status text,
  p_notes text DEFAULT NULL,
  p_occurred_at timestamptz DEFAULT NULL
)
RETURNS public.communication_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_previous text;
  v_at timestamptz := coalesce(p_occurred_at, now());
  saved public.communication_events%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT coalesce(public.is_crm_staff(), false) THEN
    RAISE EXCEPTION 'Only CRM staff can record communication.' USING ERRCODE = '42501';
  END IF;
  IF num_nonnulls(p_lead_id, p_client_id) <> 1 THEN
    RAISE EXCEPTION 'Record the communication for one lead or one client.' USING ERRCODE = '22023';
  END IF;
  IF p_channel IS NULL OR p_channel NOT IN ('Call', 'WhatsApp', 'SMS', 'Email', 'Reminder', 'In person', 'Other') THEN
    RAISE EXCEPTION 'Choose how you contacted them (call, WhatsApp, SMS, email, reminder, in person or other).' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('Reminder Pending', 'Message Sent', 'Call Completed', 'Client Responded',
                                          'No Response', 'Client Will Inform') THEN
    RAISE EXCEPTION 'Choose a valid communication status.' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'Call Completed' AND p_channel <> 'Call' THEN
    RAISE EXCEPTION 'Call Completed can only be recorded for a call.' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'Message Sent' AND p_channel NOT IN ('WhatsApp', 'SMS', 'Email', 'Reminder') THEN
    RAISE EXCEPTION 'Message Sent can only be recorded for WhatsApp, SMS, email or a reminder.' USING ERRCODE = '22023';
  END IF;
  IF p_notes IS NOT NULL AND char_length(p_notes) > 1000 THEN
    RAISE EXCEPTION 'Keep the notes under 1000 characters.' USING ERRCODE = '22023';
  END IF;
  IF v_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'The communication time cannot be in the future.' USING ERRCODE = '22023';
  END IF;
  IF v_at < now() - interval '30 days' THEN
    RAISE EXCEPTION 'Communication can be recorded up to 30 days back.' USING ERRCODE = '22023';
  END IF;

  IF p_lead_id IS NOT NULL THEN
    PERFORM 1 FROM public.leads WHERE id = p_lead_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'This lead no longer exists. Refresh the page and try again.' USING ERRCODE = 'P0001';
    END IF;
    SELECT e.communication_status INTO v_previous FROM public.communication_events AS e
    WHERE e.lead_id = p_lead_id ORDER BY e.occurred_at DESC, e.created_at DESC LIMIT 1;
  ELSE
    PERFORM 1 FROM public.clients WHERE id = p_client_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'This client no longer exists. Refresh the page and try again.' USING ERRCODE = 'P0001';
    END IF;
    SELECT e.communication_status INTO v_previous FROM public.communication_events AS e
    WHERE e.client_id = p_client_id ORDER BY e.occurred_at DESC, e.created_at DESC LIMIT 1;
  END IF;

  INSERT INTO public.communication_events (
    lead_id, client_id, channel, communication_status, previous_status, notes, occurred_at,
    recorded_by, recorded_by_name
  ) VALUES (
    p_lead_id, p_client_id, p_channel, p_status, v_previous, nullif(btrim(p_notes), ''), v_at,
    auth.uid(), public.current_actor_name()
  ) RETURNING * INTO saved;
  RETURN saved;
END;
$$;

/* =====================================================================
   7. Client audit and deactivation guard
   ===================================================================== */
CREATE OR REPLACE FUNCTION public.clients_audit_changes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tracked constant text[] := ARRAY['full_name', 'phone', 'email', 'city', 'preferred_language', 'preferred_contact',
                                   'best_time', 'service_interest', 'referral_source', 'is_active'];
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb := to_jsonb(NEW);
  changes jsonb := '{}'::jsonb;
  k text;
  v_action text;
BEGIN
  FOREACH k IN ARRAY tracked LOOP
    IF old_row -> k IS DISTINCT FROM new_row -> k THEN
      changes := changes || jsonb_build_object(k, jsonb_build_object('from', old_row -> k, 'to', new_row -> k));
    END IF;
  END LOOP;
  IF changes = '{}'::jsonb THEN
    RETURN NULL;
  END IF;
  v_action := CASE
    WHEN changes ? 'is_active' AND NEW.is_active THEN 'Client reactivated'
    WHEN changes ? 'is_active' THEN 'Client marked inactive'
    ELSE 'Client details updated'
  END;
  INSERT INTO public.activity_log (entity_type, entity_id, action, actor, actor_name, details, client_id, psychologist_id)
  VALUES (
    'client', NEW.id, v_action, auth.uid(), public.current_actor_name(),
    jsonb_strip_nulls(jsonb_build_object(
      'changes', changes,
      'reason', nullif(current_setting('kappiness.client_change_reason', true), ''))),
    -- psychologist_id NULL on purpose: read access comes from activity_log_client_audit_read (current clients_read
    -- access), not from activity_log_read's stored psychologist, which would outlive a reassignment.
    NEW.id, NULL
  );
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS clients_audit_changes ON public.clients;
CREATE TRIGGER clients_audit_changes
  AFTER UPDATE ON public.clients
  FOR EACH ROW
  EXECUTE FUNCTION public.clients_audit_changes();

-- Marking a client inactive keeps every appointment, session and history row. It is refused while the client still
-- has ANY Scheduled / Confirmed appointment (future, or past and still awaiting attendance) or a follow-up slot hold,
-- so nothing active is left behind for an inactive client (an active appointment could otherwise be rescheduled into
-- the future, since reschedule_appointment does not check the client's status).
CREATE OR REPLACE FUNCTION public.clients_guard_deactivation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_appointments integer;
  v_holds integer;
BEGIN
  IF OLD.is_active AND NOT NEW.is_active THEN
    SELECT count(*) INTO v_appointments FROM public.appointments AS a
    WHERE a.client_id = NEW.id AND a.status IN ('Scheduled', 'Confirmed');
    SELECT count(*) INTO v_holds FROM public.follow_ups AS f
    WHERE f.client_id = NEW.id AND f.status IN ('Tentative', 'Pending Confirmation');
    IF v_appointments > 0 OR v_holds > 0 THEN
      RAISE EXCEPTION 'This client still has % open appointment(s) (Scheduled or Confirmed, including past ones awaiting attendance) and % held follow-up slot(s). Record attendance for, or cancel, them before marking the client inactive.',
        v_appointments, v_holds USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS clients_guard_deactivation ON public.clients;
CREATE TRIGGER clients_guard_deactivation
  BEFORE UPDATE OF is_active ON public.clients
  FOR EACH ROW
  EXECUTE FUNCTION public.clients_guard_deactivation();

REVOKE ALL ON FUNCTION public.clients_audit_changes(), public.clients_guard_deactivation(),
  public.communication_events_append_only() FROM PUBLIC, anon, authenticated;

/* =====================================================================
   8. Client functions
   ===================================================================== */

-- Staff edit a client's details. p_changes: any of the keys below; "" or null clears an optional field.
-- p_expected_updated_at (optional) refuses the save when someone else changed the client in between.
CREATE OR REPLACE FUNCTION public.update_client_details(
  p_client_id uuid,
  p_changes jsonb,
  p_expected_updated_at timestamptz DEFAULT NULL
)
RETURNS public.clients
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cli public.clients%ROWTYPE;
  allowed constant text[] := ARRAY['full_name', 'phone', 'email', 'city', 'preferred_language', 'preferred_contact',
                                   'best_time', 'service_interest', 'referral_source'];
  v_name text;
  v_phone text;
  v_email text;
  v_source text;
  k text;
BEGIN
  IF auth.uid() IS NULL OR NOT coalesce(public.is_crm_staff(), false) THEN
    RAISE EXCEPTION 'Only CRM staff can edit client details.' USING ERRCODE = '42501';
  END IF;
  IF p_client_id IS NULL OR p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' THEN
    RAISE EXCEPTION 'Invalid client update.' USING ERRCODE = '22023';
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_changes) LOOP
    IF NOT k = ANY(allowed) THEN
      RAISE EXCEPTION 'The field % cannot be edited here.', k USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(p_changes -> k) NOT IN ('string', 'null') THEN
      RAISE EXCEPTION 'Invalid value for %.', k USING ERRCODE = '22023';
    END IF;
    IF char_length(coalesce(p_changes ->> k, '')) > 200 THEN
      RAISE EXCEPTION 'Keep % under 200 characters.', replace(k, '_', ' ') USING ERRCODE = '22023';
    END IF;
  END LOOP;

  SELECT * INTO cli FROM public.clients WHERE id = p_client_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This client no longer exists.' USING ERRCODE = 'P0001';
  END IF;
  IF p_expected_updated_at IS NOT NULL AND cli.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'This client was changed elsewhere. Refresh the profile before saving.' USING ERRCODE = 'P0001';
  END IF;

  v_name := CASE WHEN p_changes ? 'full_name' THEN nullif(btrim(p_changes ->> 'full_name'), '') ELSE cli.full_name END;
  IF v_name IS NULL OR char_length(v_name) < 2 THEN
    RAISE EXCEPTION 'A client needs a full name.' USING ERRCODE = '22023';
  END IF;
  v_phone := CASE WHEN p_changes ? 'phone' THEN nullif(btrim(p_changes ->> 'phone'), '') ELSE cli.phone END;
  IF p_changes ? 'phone' AND (v_phone IS NULL OR public.normalize_phone(v_phone) IS NULL) THEN
    RAISE EXCEPTION 'Enter a valid phone number (10 digits, or + and the country code).' USING ERRCODE = '22023';
  END IF;
  v_email := CASE WHEN p_changes ? 'email' THEN nullif(btrim(p_changes ->> 'email'), '') ELSE cli.email END;
  IF p_changes ? 'email' AND v_email IS NOT NULL AND v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RAISE EXCEPTION 'Enter a valid email address.' USING ERRCODE = '22023';
  END IF;
  v_source := CASE WHEN p_changes ? 'referral_source' THEN nullif(btrim(p_changes ->> 'referral_source'), '') ELSE cli.referral_source END;
  IF v_source IS NOT NULL AND char_length(v_source) > 80 THEN
    RAISE EXCEPTION 'Keep the referral source under 80 characters.' USING ERRCODE = '22023';
  END IF;

  -- A phone number shared with another client is allowed (the app shows the matches before saving).
  UPDATE public.clients SET
    full_name = v_name,
    phone = v_phone,
    email = v_email,
    city = CASE WHEN p_changes ? 'city' THEN nullif(btrim(p_changes ->> 'city'), '') ELSE city END,
    preferred_language = CASE WHEN p_changes ? 'preferred_language' THEN nullif(btrim(p_changes ->> 'preferred_language'), '') ELSE preferred_language END,
    preferred_contact = CASE WHEN p_changes ? 'preferred_contact' THEN nullif(btrim(p_changes ->> 'preferred_contact'), '') ELSE preferred_contact END,
    best_time = CASE WHEN p_changes ? 'best_time' THEN nullif(btrim(p_changes ->> 'best_time'), '') ELSE best_time END,
    service_interest = CASE WHEN p_changes ? 'service_interest' THEN nullif(btrim(p_changes ->> 'service_interest'), '') ELSE service_interest END,
    referral_source = v_source,
    updated_at = now()
  WHERE id = p_client_id
  RETURNING * INTO cli;
  RETURN cli;
END;
$$;

-- Staff change Active / Inactive. A reason is required to deactivate; it is stored in activity_log.
CREATE OR REPLACE FUNCTION public.set_client_active(p_client_id uuid, p_active boolean, p_reason text DEFAULT NULL)
RETURNS public.clients
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cli public.clients%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT coalesce(public.is_crm_staff(), false) THEN
    RAISE EXCEPTION 'Only CRM staff can change a client''s status.' USING ERRCODE = '42501';
  END IF;
  IF p_client_id IS NULL OR p_active IS NULL THEN
    RAISE EXCEPTION 'Choose a client and a status.' USING ERRCODE = '22023';
  END IF;
  IF NOT p_active AND char_length(coalesce(btrim(p_reason), '')) < 3 THEN
    RAISE EXCEPTION 'Add a reason for marking the client inactive.' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NOT NULL AND char_length(p_reason) > 500 THEN
    RAISE EXCEPTION 'Keep the reason under 500 characters.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO cli FROM public.clients WHERE id = p_client_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This client no longer exists.' USING ERRCODE = 'P0001';
  END IF;
  IF cli.is_active = p_active THEN
    RAISE EXCEPTION 'This client is already %.', CASE WHEN p_active THEN 'active' ELSE 'inactive' END USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('kappiness.client_change_reason', coalesce(btrim(p_reason), ''), true);
  UPDATE public.clients SET is_active = p_active, updated_at = now() WHERE id = p_client_id RETURNING * INTO cli;
  PERFORM set_config('kappiness.client_change_reason', '', true);
  RETURN cli;
END;
$$;

-- ALL clients and leads with the same normalised phone number (staff only; RLS of the caller applies). Several
-- clients may share a number: the app lists every one and staff choose; nothing is linked automatically.
CREATE OR REPLACE FUNCTION public.find_phone_matches(p_phone text, p_exclude_lead_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  n text := public.normalize_phone(p_phone);
BEGIN
  IF auth.uid() IS NULL OR NOT coalesce(public.is_crm_staff(), false) THEN
    RAISE EXCEPTION 'Only CRM staff can look up phone numbers.' USING ERRCODE = '42501';
  END IF;
  IF n IS NULL THEN
    RETURN jsonb_build_object('normalized', NULL, 'clients', '[]'::jsonb, 'leads', '[]'::jsonb);
  END IF;
  RETURN jsonb_build_object(
    'normalized', n,
    'clients', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', c.id, 'full_name', c.full_name, 'phone', c.phone, 'email', c.email, 'is_active', c.is_active,
        'primary_psychologist_id', c.primary_psychologist_id, 'referral_source', c.referral_source,
        'lead_id', c.lead_id, 'created_at', c.created_at) ORDER BY c.created_at)
      FROM public.clients AS c WHERE c.phone_normalized = n), '[]'::jsonb),
    'leads', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', l.id, 'lead_code', l.lead_code, 'full_name', l.full_name, 'status', l.status,
        'source', l.source, 'created_at', l.created_at, 'linked_client_id', k.client_id) ORDER BY l.created_at)
      FROM public.leads AS l
      LEFT JOIN public.lead_client_links AS k ON k.lead_id = l.id
      WHERE public.normalize_phone(l.phone) = n AND l.id IS DISTINCT FROM p_exclude_lead_id), '[]'::jsonb)
  );
END;
$$;

-- Link an enquiry to an existing client (before it is Confirmed). Idempotent for the same client.
-- A link without a matching phone number needs a note saying why (for example a parent enquiring for a client).
CREATE OR REPLACE FUNCTION public.link_lead_to_client(p_lead_id uuid, p_client_id uuid, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ld public.leads%ROWTYPE;
  cli public.clients%ROWTYPE;
  existing public.lead_client_links%ROWTYPE;
  v_basis text;
  saved public.lead_client_links%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT coalesce(public.is_crm_staff(), false) THEN
    RAISE EXCEPTION 'Only CRM staff can link an enquiry to a client.' USING ERRCODE = '42501';
  END IF;
  IF p_lead_id IS NULL OR p_client_id IS NULL THEN
    RAISE EXCEPTION 'Choose a lead and a client.' USING ERRCODE = '22023';
  END IF;
  IF p_note IS NOT NULL AND char_length(p_note) > 500 THEN
    RAISE EXCEPTION 'Keep the note under 500 characters.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO ld FROM public.leads WHERE id = p_lead_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This lead no longer exists. Refresh the page and try again.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO cli FROM public.clients WHERE id = p_client_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This client no longer exists.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO existing FROM public.lead_client_links WHERE lead_id = p_lead_id;
  IF FOUND THEN
    IF existing.client_id = p_client_id THEN
      RETURN jsonb_build_object('ok', true, 'created', false, 'link', to_jsonb(existing));
    END IF;
    RAISE EXCEPTION 'This enquiry is already linked to another client. Unlink it first.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.clients AS c WHERE c.lead_id = p_lead_id) THEN
    RAISE EXCEPTION 'This lead already has its own client profile, so it cannot be linked to another client.' USING ERRCODE = 'P0001';
  END IF;
  IF ld.status = 'Confirmed' THEN
    RAISE EXCEPTION 'This lead is already Confirmed. Links can only be made before the lead is confirmed.' USING ERRCODE = 'P0001';
  END IF;

  v_basis := CASE WHEN public.normalize_phone(ld.phone) IS NOT NULL
                   AND public.normalize_phone(ld.phone) = cli.phone_normalized THEN 'phone' ELSE 'manual' END;
  IF v_basis = 'manual' AND char_length(coalesce(btrim(p_note), '')) < 3 THEN
    RAISE EXCEPTION 'The phone numbers do not match. Add a note explaining why this enquiry belongs to this client.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.lead_client_links (lead_id, client_id, match_basis, note, linked_by, linked_by_name)
  VALUES (p_lead_id, p_client_id, v_basis, nullif(btrim(p_note), ''), auth.uid(), public.current_actor_name())
  RETURNING * INTO saved;

  INSERT INTO public.lead_activities (lead_id, activity_type, staff_member, notes)
  VALUES (p_lead_id, 'Lead update', public.current_actor_name(),
          format('Linked to existing client %s (Client ID %s)%s%s', cli.full_name, cli.id,
                 CASE WHEN v_basis = 'phone' THEN ', same phone number' ELSE ', linked manually' END,
                 CASE WHEN nullif(btrim(p_note), '') IS NULL THEN '' ELSE ': ' || btrim(p_note) END));

  RETURN jsonb_build_object('ok', true, 'created', true, 'link', to_jsonb(saved));
END;
$$;

-- Remove a link made by mistake (only while the lead is not Confirmed). The lead history records it.
CREATE OR REPLACE FUNCTION public.unlink_lead_from_client(p_lead_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ld public.leads%ROWTYPE;
  link public.lead_client_links%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT coalesce(public.is_crm_staff(), false) THEN
    RAISE EXCEPTION 'Only CRM staff can unlink an enquiry.' USING ERRCODE = '42501';
  END IF;
  IF char_length(coalesce(btrim(p_reason), '')) < 3 OR char_length(p_reason) > 500 THEN
    RAISE EXCEPTION 'Add a reason (3 to 500 characters) for removing the link.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO ld FROM public.leads WHERE id = p_lead_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This lead no longer exists. Refresh the page and try again.' USING ERRCODE = 'P0001';
  END IF;
  IF ld.status = 'Confirmed' THEN
    RAISE EXCEPTION 'A Confirmed lead stays linked to its client: its appointments belong to that client.' USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM public.lead_client_links WHERE lead_id = p_lead_id RETURNING * INTO link;
  IF link.lead_id IS NULL THEN
    RAISE EXCEPTION 'This enquiry is not linked to a client.' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.lead_activities (lead_id, activity_type, staff_member, notes)
  VALUES (p_lead_id, 'Lead update', public.current_actor_name(),
          format('Link to client %s removed: %s', link.client_id, btrim(p_reason)));
  RETURN jsonb_build_object('ok', true, 'removed', to_jsonb(link));
END;
$$;

-- Day 23 conversion for an enquiry from an EXISTING client: link (if not yet linked), confirm the lead with history
-- (enforce_lead_workflow still decides the transition and checks the psychologist), and book the appointment for the
-- existing client through book_appointment, all in one transaction. No second client is ever created.
CREATE OR REPLACE FUNCTION public.convert_lead_to_existing_client(
  p_lead_id uuid,
  p_expected_status text,
  p_client_id uuid,
  p_psychologist_id uuid,
  p_service_id uuid,
  p_starts_at timestamptz,
  p_notes text DEFAULT NULL,
  p_link_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  current_lead public.leads%ROWTYPE;
  cli public.clients%ROWTYPE;
  v_changes jsonb;
  v_events jsonb;
  v_psychologist_name text;
  v_saved jsonb;
  v_link jsonb;
  v_appointment public.appointments%ROWTYPE;
  v_session_id uuid;
BEGIN
  IF p_lead_id IS NULL OR p_expected_status IS NULL OR p_client_id IS NULL OR p_psychologist_id IS NULL
     OR p_service_id IS NULL OR p_starts_at IS NULL THEN
    RAISE EXCEPTION 'Choose a lead, the existing client, a psychologist, a service and a time slot.' USING ERRCODE = '22023';
  END IF;
  IF p_notes IS NOT NULL AND char_length(p_notes) > 1000 THEN
    RAISE EXCEPTION 'Keep the appointment notes under 1000 characters.' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NULL OR NOT coalesce(public.is_crm_staff(), false) THEN
    RAISE EXCEPTION 'Only CRM staff can convert leads into appointments.' USING ERRCODE = '42501';
  END IF;

  -- Same order as convert_lead_to_appointment: lead first, then the client.
  SELECT * INTO current_lead FROM public.leads WHERE id = p_lead_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This lead no longer exists. Refresh the page and try again.' USING ERRCODE = 'P0001';
  END IF;
  IF current_lead.status = 'Confirmed' THEN
    RAISE EXCEPTION 'This lead is already Confirmed. Book further appointments from its client profile.' USING ERRCODE = 'P0001';
  END IF;
  IF current_lead.status IS DISTINCT FROM p_expected_status THEN
    RAISE EXCEPTION 'This lead was changed elsewhere. Refresh it before converting it.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.clients AS c WHERE c.lead_id = p_lead_id) THEN
    RAISE EXCEPTION 'A client profile already exists for this lead, so it cannot be linked to another client. Ask an administrator to investigate.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Locks the client until commit, so it cannot be deactivated half way.
  SELECT * INTO cli FROM public.clients WHERE id = p_client_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This client no longer exists.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT cli.is_active THEN
    RAISE EXCEPTION 'This client is inactive. Reactivate the client profile before booking.' USING ERRCODE = 'P0001';
  END IF;

  -- 1. Link (idempotent when already linked to this client; refused when linked elsewhere).
  v_link := public.link_lead_to_client(p_lead_id, p_client_id, p_link_note);

  -- 2. Confirm through the Day 21 RPC. leads_sync_client sees the link and creates no client.
  v_changes := jsonb_build_object('status', 'Confirmed', 'updated_at', now());
  v_events := jsonb_build_array(jsonb_build_object(
    'type', 'status', 'text', format('Status changed from %s to Confirmed (existing client %s)', current_lead.status, cli.full_name)));
  IF current_lead.assigned_psychologist_id IS DISTINCT FROM p_psychologist_id THEN
    SELECT nullif(btrim(p.full_name), '') INTO v_psychologist_name FROM public.psychologists AS p WHERE p.id = p_psychologist_id;
    v_changes := v_changes || jsonb_build_object('assigned_psychologist_id', p_psychologist_id);
    v_events := v_events || jsonb_build_array(jsonb_build_object(
      'type', 'update', 'text', format('Psychologist assigned: %s', coalesce(v_psychologist_name, 'selected psychologist'))));
  END IF;
  IF current_lead.next_follow_up_at IS NOT NULL THEN
    v_changes := v_changes || '{"next_follow_up_at": null}'::jsonb;
    v_events := v_events || jsonb_build_array(jsonb_build_object(
      'type', 'followup', 'text', format('Follow up cleared on conversion (was %s %s, %s)',
        to_char(current_lead.next_follow_up_at AT TIME ZONE public.clinic_timezone(), 'DD Mon YYYY HH24:MI'),
        public.clinic_timezone(),
        to_char(current_lead.next_follow_up_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))));
  END IF;
  v_saved := public.update_lead_with_history(p_lead_id, p_expected_status, v_changes, v_events);
  IF NOT coalesce((v_saved ->> 'ok')::boolean, false) OR v_saved -> 'lead' IS NULL THEN
    RAISE EXCEPTION 'The lead could not be confirmed. Nothing was saved.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.clients AS c WHERE c.lead_id = p_lead_id) THEN
    RAISE EXCEPTION 'A second client profile would have been created. Nothing was saved.' USING ERRCODE = 'P0001';
  END IF;

  -- 3. Book for the existing client (every booking rule applies; the client must be active).
  SELECT * INTO v_appointment
  FROM public.book_appointment(p_client_id, p_psychologist_id, p_service_id, p_starts_at, nullif(btrim(p_notes), ''), NULL, NULL);
  SELECT s.id INTO v_session_id FROM public.sessions AS s WHERE s.appointment_id = v_appointment.id;
  IF v_appointment.id IS NULL OR v_session_id IS NULL THEN
    RAISE EXCEPTION 'The appointment could not be booked. Nothing was saved.' USING ERRCODE = 'P0001';
  END IF;

  -- book_appointment writes its history to the client's original lead; the enquiry gets its own entry too.
  INSERT INTO public.lead_activities (lead_id, activity_type, staff_member, notes)
  VALUES (p_lead_id, 'Lead update', public.current_actor_name(),
          format('Appointment booked for existing client %s: %s, %s', cli.full_name, v_appointment.service_type,
                 to_char(v_appointment.starts_at AT TIME ZONE public.clinic_timezone(), 'DD Mon YYYY HH24:MI')));

  RETURN jsonb_build_object(
    'ok', true,
    'lead', v_saved -> 'lead',
    'client_id', p_client_id,
    'appointment_id', v_appointment.id,
    'session_id', v_session_id,
    'linked_existing_client', true,
    'link_created', coalesce((v_link ->> 'created')::boolean, false)
  );
END;
$$;

/* =====================================================================
   9. Client directory view (list and profile summary)
   ===================================================================== */
CREATE OR REPLACE VIEW public.client_directory
WITH (security_invoker = true) AS
SELECT
  c.id, c.lead_id, c.full_name, c.phone, c.phone_normalized, c.email, c.city, c.preferred_language,
  c.preferred_contact, c.best_time, c.service_interest, c.referral_source, c.primary_psychologist_id,
  c.is_active, c.created_at, c.updated_at,
  p.full_name AS psychologist_name,
  l.lead_code AS original_lead_code,
  (SELECT count(*) FROM public.sessions AS s WHERE s.client_id = c.id AND s.status = 'Completed')::integer AS total_sessions,
  la.starts_at AS last_appointment_at,
  la.status AS last_appointment_status,
  na.id AS next_appointment_id,
  na.starts_at AS next_appointment_at,
  na.status AS next_appointment_status,
  (SELECT count(*) FROM public.lead_client_links AS k WHERE k.client_id = c.id)::integer AS linked_enquiries
FROM public.clients AS c
LEFT JOIN public.psychologists AS p ON p.id = c.primary_psychologist_id
LEFT JOIN public.leads AS l ON l.id = c.lead_id
-- Last appointment: the latest one that has started and was not cancelled or moved (Completed, Missed, or still
-- awaiting attendance).
LEFT JOIN LATERAL (
  SELECT a.starts_at, a.status FROM public.appointments AS a
  WHERE a.client_id = c.id AND a.starts_at <= now() AND a.status IN ('Completed', 'Missed', 'Scheduled', 'Confirmed')
  ORDER BY a.starts_at DESC LIMIT 1
) AS la ON true
LEFT JOIN LATERAL (
  SELECT a.id, a.starts_at, a.status FROM public.appointments AS a
  WHERE a.client_id = c.id AND a.starts_at > now() AND a.status IN ('Scheduled', 'Confirmed')
  ORDER BY a.starts_at ASC LIMIT 1
) AS na ON true;

COMMENT ON VIEW public.client_directory IS
  'Day 24: clients with psychologist name, completed-session count, last and next appointment, original lead code and linked enquiries. security_invoker: the caller''s RLS applies to every table read.';

/* =====================================================================
   10. Row Level Security and grants
   ===================================================================== */
ALTER TABLE public.lead_client_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.communication_events ENABLE ROW LEVEL SECURITY;

-- Default privileges in public grant ALL to the API roles on new objects: take everything back.
REVOKE ALL ON TABLE public.lead_client_links, public.communication_events, public.client_directory
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.lead_client_links, public.communication_events, public.client_directory TO authenticated;
GRANT ALL ON TABLE public.lead_client_links, public.communication_events TO service_role;

DROP POLICY IF EXISTS lead_client_links_staff_read ON public.lead_client_links;
CREATE POLICY lead_client_links_staff_read ON public.lead_client_links FOR SELECT TO authenticated
  USING (public.is_crm_staff());

-- Client audit rows (written by clients_audit_changes) are readable by whoever can read that client under
-- clients_read: staff, the client's psychologist, and a psychologist the client is booked with. The EXISTS runs with
-- the caller's own RLS on clients. Other activity_log rows are unaffected (activity_log_read, unchanged). There is
-- still no INSERT / UPDATE / DELETE grant, and activity_log_append_only blocks changes for everyone.
DROP POLICY IF EXISTS activity_log_client_audit_read ON public.activity_log;
CREATE POLICY activity_log_client_audit_read ON public.activity_log FOR SELECT TO authenticated
  USING (
    entity_type = 'client'
    AND client_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.clients AS c WHERE c.id = activity_log.client_id)
  );

DROP POLICY IF EXISTS communication_events_staff_read ON public.communication_events;
CREATE POLICY communication_events_staff_read ON public.communication_events FOR SELECT TO authenticated
  USING (public.is_crm_staff());

REVOKE ALL ON FUNCTION
  public.record_communication(uuid, uuid, text, text, text, timestamptz),
  public.update_client_details(uuid, jsonb, timestamptz),
  public.set_client_active(uuid, boolean, text),
  public.find_phone_matches(text, uuid),
  public.link_lead_to_client(uuid, uuid, text),
  public.unlink_lead_from_client(uuid, text),
  public.convert_lead_to_existing_client(uuid, text, uuid, uuid, uuid, timestamptz, text, text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.record_communication(uuid, uuid, text, text, text, timestamptz),
  public.update_client_details(uuid, jsonb, timestamptz),
  public.set_client_active(uuid, boolean, text),
  public.find_phone_matches(text, uuid),
  public.link_lead_to_client(uuid, uuid, text),
  public.unlink_lead_from_client(uuid, text),
  public.convert_lead_to_existing_client(uuid, text, uuid, uuid, uuid, timestamptz, text, text)
TO authenticated;

COMMENT ON FUNCTION public.convert_lead_to_existing_client(uuid, text, uuid, uuid, uuid, timestamptz, text, text) IS
  'Day 24: confirms an enquiry from an existing client, links it and books the appointment for that client in one transaction (20261125120000).';

/* =====================================================================
   11. Post-checks (any failure rolls back everything)
   ===================================================================== */
DO $$
DECLARE
  b record;
  v_text text;
  t text;
BEGIN
  SELECT * INTO b FROM _d24_before;

  -- Existing data: nothing deleted, nothing but the new columns written.
  IF (SELECT count(*) FROM public.leads) <> b.leads_n
     OR (SELECT md5(coalesce(string_agg(to_jsonb(l)::text, '|' ORDER BY l.id), '')) FROM public.leads AS l) IS DISTINCT FROM b.leads_md5 THEN
    RAISE EXCEPTION 'POSTCHECK: leads changed.';
  END IF;
  IF (SELECT count(*) FROM public.lead_activities) <> b.activities_n THEN
    RAISE EXCEPTION 'POSTCHECK: lead_activities changed.';
  END IF;
  IF (SELECT count(*) FROM public.clients) <> b.clients_n
     OR (SELECT md5(coalesce(string_agg((to_jsonb(c) - 'referral_source' - 'phone_normalized')::text, '|' ORDER BY c.id), ''))
           FROM public.clients AS c) IS DISTINCT FROM b.clients_md5 THEN
    RAISE EXCEPTION 'POSTCHECK: client columns other than referral_source / phone_normalized changed.';
  END IF;
  IF (SELECT count(*) FROM public.appointments) <> b.appointments_n OR (SELECT count(*) FROM public.sessions) <> b.sessions_n THEN
    RAISE EXCEPTION 'POSTCHECK: appointments or sessions changed.';
  END IF;
  -- Unchanged dependencies.
  SELECT string_agg(t2.tgname::text || ':' || t2.tgenabled::text, ',' ORDER BY t2.tgname) INTO v_text
  FROM pg_trigger AS t2 WHERE t2.tgrelid = 'public.leads'::regclass AND NOT t2.tgisinternal;
  IF v_text IS DISTINCT FROM 'leads_enforce_workflow:O,leads_sync_client:O,set_lead_code:O' THEN
    RAISE EXCEPTION 'POSTCHECK: triggers on leads are %', v_text;
  END IF;
  IF md5(replace((SELECT prosrc FROM pg_proc WHERE oid = 'public.convert_lead_to_appointment(uuid,text,uuid,uuid,timestamptz,text)'::regprocedure), E'\r', ''))
       <> 'd61213476b5d2537d729a08e91a008eb'
     OR md5(replace((SELECT prosrc FROM pg_proc WHERE oid = 'public.update_lead_with_history(uuid,text,jsonb,jsonb)'::regprocedure), E'\r', ''))
       <> '0a62ea753396e7da751446e34373c29e'
     OR md5(replace((SELECT prosrc FROM pg_proc WHERE oid = 'public.book_appointment(uuid,uuid,uuid,timestamptz,text,uuid,text)'::regprocedure), E'\r', ''))
       <> '0c25ffb3cfa622fdeb53041a496b7ade' THEN
    RAISE EXCEPTION 'POSTCHECK: a protected function changed.';
  END IF;

  -- Shared numbers allowed: a valid NON-unique lookup index, and no unique rule on the phone number anywhere.
  IF NOT EXISTS (SELECT 1 FROM pg_index AS i JOIN pg_class AS ic ON ic.oid = i.indexrelid
                 WHERE i.indrelid = 'public.clients'::regclass AND ic.relname = 'idx_clients_phone_normalized'
                   AND NOT i.indisunique AND i.indisvalid) THEN
    RAISE EXCEPTION 'POSTCHECK: idx_clients_phone_normalized is missing, invalid or unique.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_index AS i
             WHERE i.indrelid = 'public.clients'::regclass AND i.indisunique
               AND i.indkey::int2[] @> ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.clients'::regclass
                                             AND attname = 'phone_normalized')]) THEN
    RAISE EXCEPTION 'POSTCHECK: a unique index still covers clients.phone_normalized.';
  END IF;
  -- Audit: readable through the new policy, still not writable by API roles.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'activity_log'
                 AND policyname = 'activity_log_client_audit_read' AND cmd = 'SELECT')
     OR has_table_privilege('authenticated', 'public.activity_log', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('anon', 'public.activity_log', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') THEN
    RAISE EXCEPTION 'POSTCHECK: activity_log policy or privileges are not as expected.';
  END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.normalize_phone(text)'::regprocedure) <> 'i' THEN
    RAISE EXCEPTION 'POSTCHECK: normalize_phone must be IMMUTABLE.';
  END IF;

  -- New tables: RLS on, no writes for API roles.
  FOREACH t IN ARRAY ARRAY['public.lead_client_links', 'public.communication_events'] LOOP
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = t::regclass) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'POSTCHECK: RLS is not enabled on %.', t;
    END IF;
    IF has_table_privilege('anon', t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
       OR has_table_privilege('authenticated', t, 'INSERT, UPDATE, DELETE, TRUNCATE') THEN
      RAISE EXCEPTION 'POSTCHECK: unexpected privileges on %.', t;
    END IF;
  END LOOP;
  IF has_table_privilege('anon', 'public.client_directory', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCHECK: anon can read client_directory.';
  END IF;
  IF has_column_privilege('authenticated', 'public.clients', 'referral_source', 'UPDATE') THEN
    RAISE EXCEPTION 'POSTCHECK: referral_source must only be written through update_client_details.';
  END IF;

  -- Function settings and grants.
  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('public.record_communication(uuid,uuid,text,text,text,timestamptz)', true),
      ('public.update_client_details(uuid,jsonb,timestamptz)', true),
      ('public.set_client_active(uuid,boolean,text)', true),
      ('public.link_lead_to_client(uuid,uuid,text)', true),
      ('public.unlink_lead_from_client(uuid,text)', true),
      ('public.find_phone_matches(text,uuid)', false),
      ('public.convert_lead_to_existing_client(uuid,text,uuid,uuid,uuid,timestamptz,text,text)', false)
    ) AS f(sig, definer)
    JOIN pg_proc AS p ON p.oid = to_regprocedure(f.sig)
    WHERE p.prosecdef IS DISTINCT FROM f.definer
       OR coalesce(p.proconfig, ARRAY[]::text[]) IS DISTINCT FROM ARRAY['search_path=public']
       OR has_function_privilege('anon', p.oid, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'POSTCHECK: a Day 24 function has the wrong security, search_path or grants.';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
