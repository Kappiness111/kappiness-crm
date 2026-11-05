-- Kappiness CRM TEST BOOTSTRAP, step 1 of 4: baseline from the 27 Oct schema snapshot.
-- Owner: Aswathy (backend / testing).
--
-- TARGET: the separate, EMPTY Supabase project kappiness-crm-test ONLY. Never production.
--
-- SOURCE: supabase/backups/schema_before_migration.sql (schema only: it has no COPY / INSERT / setval).
--   Kept:   lead_code_seq, leads, lead_activities, their constraints, indexes, FK, the set_lead_code
--           trigger, the five permissive "Staff can ..." policies, RLS, the snapshot's table grants and
--           the default privileges for objects created by postgres in public.
--   Left out on purpose:
--     * CREATE EXTENSION pg_stat_statements / pgcrypto / supabase_vault / uuid-ossp: Supabase installs
--       and manages these in every project.
--     * COMMENT ON SCHEMA public, GRANT USAGE ON SCHEMA public, ALTER PUBLICATION supabase_realtime:
--       Supabase-managed.
--     * ALTER ... OWNER TO postgres: run this file as postgres, so postgres owns everything (step 4 checks).
--     * The snapshot's legacy update_lead_with_history (New/Contacted/...): step 3 installs the exact
--       live definition instead.
--     * SET row_security = off and the empty search_path: names below are schema-qualified.
--   Nothing in auth, storage, realtime, vault, extensions or graphql is created or changed.
--
-- EXECUTION ORDER: see supabase/test-bootstrap/README.md. Requires, in the same psql session:
--   SET kappiness.test_env = 'disposable';

BEGIN;

-- 0. Isolation guard: refuse anywhere except an empty, opted-in project.
DO $$
DECLARE
  n integer;
BEGIN
  IF coalesce(current_setting('kappiness.test_env', true), '') <> 'disposable' THEN
    RAISE EXCEPTION 'Refusing to run: SET kappiness.test_env = ''disposable'' first (test project only).';
  END IF;

  SELECT count(*) INTO n
  FROM pg_class AS c JOIN pg_namespace AS ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f');
  IF n > 0 THEN
    RAISE EXCEPTION 'Refusing to run: schema public already has % relations. This must be the EMPTY test project.', n;
  END IF;

  IF EXISTS (SELECT 1 FROM auth.users) THEN
    RAISE EXCEPTION 'Refusing to run: auth.users is not empty. This must be the EMPTY test project.';
  END IF;

  IF to_regnamespace('extensions') IS NULL THEN
    RAISE EXCEPTION 'The extensions schema is missing; this does not look like a standard Supabase project.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'btree_gist') THEN
    RAISE EXCEPTION 'btree_gist is not available; the deployment bundle needs it.';
  END IF;
END
$$;

-- 1. Default privileges for objects postgres creates in public (from the snapshot; also the Supabase
--    default). They matter: tables created later by the bundle inherit the same grants as on live.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;

-- 2. Lead code sequence and trigger function.
CREATE SEQUENCE public.lead_code_seq
  START WITH 1
  INCREMENT BY 1
  NO MINVALUE
  NO MAXVALUE
  CACHE 1;

CREATE FUNCTION public.generate_lead_code()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.lead_code IS NULL OR NEW.lead_code = '' THEN
    NEW.lead_code :=
      'KAP-' || LPAD(NEXTVAL('public.lead_code_seq')::TEXT, 3, '0');
  END IF;
  RETURN NEW;
END;
$$;

-- 3. Tables (columns and constraints exactly as in the snapshot; step 3 moves the status vocabulary to live).
CREATE TABLE public.lead_activities (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  lead_id uuid NOT NULL,
  activity_type text NOT NULL,
  staff_member text,
  occurred_at timestamp with time zone DEFAULT now() NOT NULL,
  notes text,
  outcome text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT lead_activities_activity_type_check CHECK ((activity_type = ANY (ARRAY['Phone call'::text, 'Message'::text, 'Callback'::text, 'Email'::text, 'Meeting'::text, 'Note'::text, 'Lead created'::text, 'Status change'::text, 'Follow-up'::text, 'Lead update'::text])))
);

CREATE TABLE public.leads (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  lead_code text,
  full_name text NOT NULL,
  phone text NOT NULL,
  email text,
  source text,
  assigned_staff text,
  status text DEFAULT 'New'::text NOT NULL,
  next_follow_up_at timestamp with time zone,
  not_converted_reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  city text,
  preferred_language text,
  preferred_contact text,
  best_time text,
  service_interest text,
  priority text,
  notes text,
  contact_method text,
  CONSTRAINT follow_up_requires_datetime CHECK (((status <> 'Follow Up'::text) OR (next_follow_up_at IS NOT NULL))),
  CONSTRAINT leads_contact_method_check CHECK (((contact_method IS NULL) OR (contact_method = ANY (ARRAY['WhatsApp'::text, 'Call'::text, 'Other'::text])))),
  CONSTRAINT leads_status_check CHECK ((status = ANY (ARRAY['New'::text, 'Contacted'::text, 'Follow Up'::text, 'Converted'::text, 'Lost'::text]))),
  CONSTRAINT lost_lead_requires_reason CHECK (((status <> 'Lost'::text) OR (NULLIF(TRIM(BOTH FROM not_converted_reason), ''::text) IS NOT NULL)))
);

ALTER TABLE ONLY public.lead_activities ADD CONSTRAINT lead_activities_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.leads ADD CONSTRAINT leads_lead_code_key UNIQUE (lead_code);
ALTER TABLE ONLY public.leads ADD CONSTRAINT leads_pkey PRIMARY KEY (id);

CREATE INDEX idx_lead_activities_lead_id ON public.lead_activities USING btree (lead_id);
CREATE INDEX idx_leads_follow_up ON public.leads USING btree (next_follow_up_at);
CREATE INDEX idx_leads_status ON public.leads USING btree (status);

CREATE TRIGGER set_lead_code BEFORE INSERT ON public.leads FOR EACH ROW EXECUTE FUNCTION public.generate_lead_code();

ALTER TABLE ONLY public.lead_activities
  ADD CONSTRAINT lead_activities_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id) ON DELETE CASCADE;

-- 4. Permissive policies and RLS (snapshot). 202611030001 (step 2) adds the restrictive membership policies.
CREATE POLICY "Staff can create lead activities" ON public.lead_activities FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Staff can create leads" ON public.leads FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Staff can update leads" ON public.leads FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Staff can view all lead activities" ON public.lead_activities FOR SELECT TO authenticated USING (true);
CREATE POLICY "Staff can view all leads" ON public.leads FOR SELECT TO authenticated USING (true);

ALTER TABLE public.lead_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

-- 5. Grants exactly as in the snapshot. The default privileges above would also give anon ALL and
--    authenticated ALL, which the snapshot does not have, so reset first.
REVOKE ALL ON TABLE public.leads, public.lead_activities FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.lead_code_seq FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public.lead_activities TO service_role;
GRANT SELECT, INSERT ON TABLE public.lead_activities TO authenticated;
GRANT ALL ON SEQUENCE public.lead_code_seq TO service_role;
GRANT USAGE ON SEQUENCE public.lead_code_seq TO authenticated;
GRANT ALL ON TABLE public.leads TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.leads TO authenticated;

GRANT ALL ON FUNCTION public.generate_lead_code() TO anon, authenticated, service_role;

COMMIT;
