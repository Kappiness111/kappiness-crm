-- Kappiness CRM Day 24: POST-DEPLOYMENT REPORT for 20261125120000. Read-only (ends in ROLLBACK).
-- Every row's "result" must be OK.

BEGIN;

SELECT check_name, result FROM (
  SELECT 1 AS ord, 'sync_client_from_lead is the Day 24 body' AS check_name,
    CASE WHEN md5(replace((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.sync_client_from_lead()')), E'\r', ''))
              = '913c7560fceaa9e09468c3e6cb298a83' THEN 'OK' ELSE 'FAIL' END AS result
  UNION ALL SELECT 2, 'protected functions unchanged (Day 21, Day 23, book_appointment)',
    CASE WHEN md5(replace((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.convert_lead_to_appointment(uuid,text,uuid,uuid,timestamptz,text)')), E'\r', '')) = 'd61213476b5d2537d729a08e91a008eb'
          AND md5(replace((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.update_lead_with_history(uuid,text,jsonb,jsonb)')), E'\r', '')) = '0a62ea753396e7da751446e34373c29e'
          AND md5(replace((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.enforce_lead_workflow()')), E'\r', '')) = '7c9f820ac5dd11e57e6b4a11b2785a6b'
          AND md5(replace((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.book_appointment(uuid,uuid,uuid,timestamptz,text,uuid,text)')), E'\r', '')) = '0c25ffb3cfa622fdeb53041a496b7ade'
         THEN 'OK' ELSE 'FAIL' END
  UNION ALL SELECT 3, 'triggers on leads unchanged and enabled',
    CASE WHEN (SELECT string_agg(t.tgname::text || ':' || t.tgenabled::text, ',' ORDER BY t.tgname) FROM pg_trigger AS t
               WHERE t.tgrelid = 'public.leads'::regclass AND NOT t.tgisinternal)
              = 'leads_enforce_workflow:O,leads_sync_client:O,set_lead_code:O' THEN 'OK' ELSE 'FAIL' END
  UNION ALL SELECT 4, 'shared phone numbers allowed: non-unique lookup index valid, no unique index on phone_normalized',
    CASE WHEN EXISTS (SELECT 1 FROM pg_index AS i JOIN pg_class AS c ON c.oid = i.indexrelid
                      WHERE c.relname = 'idx_clients_phone_normalized' AND NOT i.indisunique AND i.indisvalid)
          AND to_regclass('public.clients_phone_normalized_key') IS NULL THEN 'OK' ELSE 'FAIL' END
  UNION ALL SELECT 41, 'client audit readable via activity_log_client_audit_read; activity_log not writable by API roles',
    CASE WHEN EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'activity_log'
                      AND policyname = 'activity_log_client_audit_read' AND cmd = 'SELECT')
          AND NOT has_table_privilege('authenticated', 'public.activity_log', 'INSERT, UPDATE, DELETE')
          AND NOT has_table_privilege('anon', 'public.activity_log', 'SELECT') THEN 'OK' ELSE 'FAIL' END
  UNION ALL SELECT 5, 'every client phone_normalized = normalize_phone(phone)',
    CASE WHEN NOT EXISTS (SELECT 1 FROM public.clients WHERE phone_normalized IS DISTINCT FROM public.normalize_phone(phone)) THEN 'OK' ELSE 'FAIL' END
  UNION ALL SELECT 6, 'referral source backfilled where the original lead has a source',
    CASE WHEN NOT EXISTS (SELECT 1 FROM public.clients AS c JOIN public.leads AS l ON l.id = c.lead_id
                          WHERE c.referral_source IS NULL AND nullif(btrim(l.source), '') IS NOT NULL) THEN 'OK' ELSE 'FAIL' END
  UNION ALL SELECT 7, 'RLS on lead_client_links and communication_events',
    CASE WHEN (SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('public.lead_client_links'::regclass, 'public.communication_events'::regclass))
         THEN 'OK' ELSE 'FAIL' END
  UNION ALL SELECT 8, 'no write privileges for API roles on new tables; anon reads nothing',
    CASE WHEN NOT has_table_privilege('authenticated', 'public.communication_events', 'INSERT, UPDATE, DELETE')
          AND NOT has_table_privilege('authenticated', 'public.lead_client_links', 'INSERT, UPDATE, DELETE')
          AND NOT has_table_privilege('anon', 'public.communication_events', 'SELECT')
          AND NOT has_table_privilege('anon', 'public.lead_client_links', 'SELECT')
          AND NOT has_table_privilege('anon', 'public.client_directory', 'SELECT') THEN 'OK' ELSE 'FAIL' END
  UNION ALL SELECT 9, 'Day 24 functions: authenticated only',
    CASE WHEN NOT EXISTS (
      SELECT 1 FROM unnest(ARRAY[
        'public.record_communication(uuid,uuid,text,text,text,timestamptz)', 'public.update_client_details(uuid,jsonb,timestamptz)',
        'public.set_client_active(uuid,boolean,text)', 'public.find_phone_matches(text,uuid)', 'public.link_lead_to_client(uuid,uuid,text)',
        'public.unlink_lead_from_client(uuid,text)', 'public.convert_lead_to_existing_client(uuid,text,uuid,uuid,uuid,timestamptz,text,text)']) AS s
      WHERE to_regprocedure(s) IS NULL OR has_function_privilege('anon', s, 'EXECUTE') OR NOT has_function_privilege('authenticated', s, 'EXECUTE'))
         THEN 'OK' ELSE 'FAIL' END
) AS r
ORDER BY ord;

-- Informational
SELECT (SELECT count(*) FROM public.clients) AS clients,
       (SELECT count(*) FROM public.clients WHERE referral_source IS NOT NULL) AS clients_with_referral_source,
       (SELECT count(*) FROM public.clients WHERE phone_normalized IS NULL) AS clients_without_recognisable_phone,
       (SELECT count(*) FROM public.lead_client_links) AS linked_enquiries,
       (SELECT count(*) FROM public.communication_events) AS communication_events;

ROLLBACK;
