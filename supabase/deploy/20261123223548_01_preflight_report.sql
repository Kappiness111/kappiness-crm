-- Kappiness CRM Day 23: PREFLIGHT REPORT for migration 20261123223548_convert_lead_to_appointment.sql.
-- READ-ONLY: one SELECT, no writes, no locks beyond ordinary reads. Safe on production MAIN.
-- Run it in the SQL Editor BEFORE the deployment. Every row must show ok = true (failing rows sort first).
--
-- These are the same conditions the migration's own preflight enforces (it aborts and changes nothing if any
-- fails); this report just shows them all at once, with the actual values, before you try.
--
-- P03-P06 compare function fingerprints (md5 of the body without CR). book_appointment's value was verified on
-- production by deployment 202611130003; the Day 21 values and sync_client_from_lead's are computed from the
-- repository files. A mismatch means production differs from the repository: STOP and review, do not edit the
-- expected value to make it pass.
--
-- P14 is false only if this migration has already been applied (re-running it is allowed and harmless).

WITH fp(id, sig, expected) AS (
  VALUES
    ('P03', 'public.update_lead_with_history(uuid,text,jsonb,jsonb)', '0a62ea753396e7da751446e34373c29e'),
    ('P04', 'public.enforce_lead_workflow()', '7c9f820ac5dd11e57e6b4a11b2785a6b'),
    ('P05', 'public.sync_client_from_lead()', '4109aa9bd681941e084d44732f35a38c'),
    ('P06', 'public.book_appointment(uuid,uuid,uuid,timestamptz,text,uuid,text)', '0c25ffb3cfa622fdeb53041a496b7ade')
),
checks(id, check_name, expected, actual) AS (
  SELECT 'P01', 'required tables and is_crm_staff() exist', 'all present',
    CASE WHEN to_regclass('public.leads') IS NOT NULL AND to_regclass('public.lead_activities') IS NOT NULL
               AND to_regclass('public.clients') IS NOT NULL AND to_regclass('public.appointments') IS NOT NULL
               AND to_regclass('public.sessions') IS NOT NULL AND to_regclass('public.psychologists') IS NOT NULL
               AND to_regclass('public.crm_staff_members') IS NOT NULL
               AND to_regprocedure('public.is_crm_staff()') IS NOT NULL
         THEN 'all present' ELSE 'MISSING' END

  UNION ALL
  SELECT 'P02', 'leads_status_check is the Day 21 eight-status constraint',
    'CHECK ((status = ANY (ARRAY[''New Lead''::text, ''Contacted''::text, ''Interested''::text, ''Follow-up Required''::text, ''Awaiting Confirmation''::text, ''Confirmed''::text, ''Not Interested''::text, ''Lost Lead''::text])))',
    coalesce((SELECT pg_get_constraintdef(c.oid) FROM pg_constraint AS c
              WHERE c.conrelid = to_regclass('public.leads') AND c.conname = 'leads_status_check'), '(missing)')

  UNION ALL
  SELECT fp.id, 'fingerprint ' || fp.sig, fp.expected,
    coalesce((SELECT md5(replace(p.prosrc, E'\r', '')) FROM pg_proc AS p WHERE p.oid = to_regprocedure(fp.sig)), 'MISSING')
  FROM fp

  UNION ALL
  SELECT 'P07', 'update_lead_with_history is SECURITY INVOKER with search_path=public', 'invoker; search_path=public',
    coalesce((SELECT CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'invoker' END || '; '
                     || coalesce(array_to_string(p.proconfig, ','), '(no settings)')
              FROM pg_proc AS p WHERE p.oid = to_regprocedure('public.update_lead_with_history(uuid,text,jsonb,jsonb)')),
             'MISSING')

  UNION ALL
  SELECT 'P08', 'leads workflow + client triggers exist and are enabled', 'leads_enforce_workflow:O,leads_sync_client:O',
    coalesce((SELECT string_agg(t.tgname::text || ':' || t.tgenabled::text, ',' ORDER BY t.tgname)
              FROM pg_trigger AS t
              WHERE t.tgrelid = to_regclass('public.leads') AND NOT t.tgisinternal
                AND t.tgname IN ('leads_enforce_workflow', 'leads_sync_client')), '(none)')

  UNION ALL
  SELECT 'P09', 'clients.lead_id is UNIQUE (one client per lead)', 'unique',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_constraint AS c
      WHERE c.conrelid = to_regclass('public.clients') AND c.contype = 'u'
        AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute AS a
                              WHERE a.attrelid = to_regclass('public.clients') AND a.attname = 'lead_id')]
    ) THEN 'unique' ELSE 'NOT UNIQUE' END

  UNION ALL
  SELECT 'P10', 'sessions.appointment_id is UNIQUE (one session per appointment)', 'unique',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_constraint AS c
      WHERE c.conrelid = to_regclass('public.sessions') AND c.contype = 'u'
        AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute AS a
                              WHERE a.attrelid = to_regclass('public.sessions') AND a.attname = 'appointment_id')]
    ) THEN 'unique' ELSE 'NOT UNIQUE' END

  UNION ALL
  SELECT 'P11', 'leads that are not Confirmed but already have a client', '0',
    (SELECT count(*)::text FROM public.clients AS c JOIN public.leads AS l ON l.id = c.lead_id
     WHERE l.status IS DISTINCT FROM 'Confirmed')

  UNION ALL
  SELECT 'P12', 'authenticated can EXECUTE the functions the RPC calls',
    'update_lead_with_history,book_appointment,is_crm_staff,clinic_timezone',
    concat_ws(',',
      CASE WHEN coalesce(has_function_privilege('authenticated', to_regprocedure('public.update_lead_with_history(uuid,text,jsonb,jsonb)'), 'EXECUTE'), false) THEN 'update_lead_with_history' END,
      CASE WHEN coalesce(has_function_privilege('authenticated', to_regprocedure('public.book_appointment(uuid,uuid,uuid,timestamptz,text,uuid,text)'), 'EXECUTE'), false) THEN 'book_appointment' END,
      CASE WHEN coalesce(has_function_privilege('authenticated', to_regprocedure('public.is_crm_staff()'), 'EXECUTE'), false) THEN 'is_crm_staff' END,
      CASE WHEN coalesce(has_function_privilege('authenticated', to_regprocedure('public.clinic_timezone()'), 'EXECUTE'), false) THEN 'clinic_timezone' END)

  UNION ALL
  SELECT 'P13', 'is_crm_staff() is membership-based (202611130001)', 'membership-based',
    coalesce((SELECT CASE WHEN p.prosrc ILIKE '%crm_staff_members%' THEN 'membership-based' ELSE 'OTHER' END
              FROM pg_proc AS p WHERE p.oid = to_regprocedure('public.is_crm_staff()')), 'MISSING')

  UNION ALL
  SELECT 'P14', 'convert_lead_to_appointment not deployed yet', 'absent',
    CASE WHEN to_regprocedure('public.convert_lead_to_appointment(uuid,text,uuid,uuid,timestamptz,text)') IS NULL
         THEN 'absent' ELSE 'present (already applied)' END

  UNION ALL
  SELECT 'P15', 'at least one active CRM staff member (needed to use the RPC)', 'yes',
    CASE WHEN EXISTS (SELECT 1 FROM public.crm_staff_members WHERE is_active) THEN 'yes' ELSE 'NO' END
)
SELECT id, check_name, actual IS NOT DISTINCT FROM expected AS ok, expected, actual
FROM checks
ORDER BY (actual IS NOT DISTINCT FROM expected), id;
