-- Kappiness CRM Day 23: POST-DEPLOYMENT REPORT for migration 20261123223548_convert_lead_to_appointment.sql.
-- READ-ONLY: one SELECT, no writes. Safe on production MAIN. Run it AFTER the deployment.
-- Every row must show ok = true (failing rows sort first).
--
-- Q03: fingerprint of the deployed function body, computed from the repository file (md5 of the body without CR).
--      A mismatch means a different version was deployed than the one reviewed.
-- Q06-Q09: the Day 21 workflow, the client trigger and ordinary booking are unchanged by this deployment.

WITH sig AS (
  SELECT to_regprocedure('public.convert_lead_to_appointment(uuid,text,uuid,uuid,timestamptz,text)') AS oid
),
fn AS (
  SELECT p.* FROM pg_proc AS p, sig WHERE p.oid = sig.oid
),
fp(id, sig, expected) AS (
  VALUES
    ('Q06', 'public.update_lead_with_history(uuid,text,jsonb,jsonb)', '0a62ea753396e7da751446e34373c29e'),
    ('Q07', 'public.enforce_lead_workflow()', '7c9f820ac5dd11e57e6b4a11b2785a6b'),
    ('Q08', 'public.sync_client_from_lead()', '4109aa9bd681941e084d44732f35a38c'),
    ('Q09', 'public.book_appointment(uuid,uuid,uuid,timestamptz,text,uuid,text)', '0c25ffb3cfa622fdeb53041a496b7ade')
),
checks(id, check_name, expected, actual) AS (
  SELECT 'Q01', 'convert_lead_to_appointment exists and returns jsonb', 'present; jsonb',
    coalesce((SELECT 'present; ' || format_type(fn.prorettype, NULL) FROM fn), 'MISSING')

  UNION ALL
  SELECT 'Q02', 'SECURITY INVOKER, search_path=public, plpgsql', 'invoker; search_path=public; plpgsql',
    coalesce((SELECT CASE WHEN fn.prosecdef THEN 'DEFINER' ELSE 'invoker' END || '; '
                     || coalesce(array_to_string(fn.proconfig, ','), '(no settings)') || '; '
                     || (SELECT l.lanname FROM pg_language AS l WHERE l.oid = fn.prolang)
              FROM fn), 'MISSING')

  UNION ALL
  SELECT 'Q03', 'deployed body matches the reviewed repository version', 'd61213476b5d2537d729a08e91a008eb',
    coalesce((SELECT md5(replace(fn.prosrc, E'\r', '')) FROM fn), 'MISSING')

  UNION ALL
  SELECT 'Q04', 'EXECUTE: authenticated yes; anon and PUBLIC no', 'authenticated=yes anon=no public=no',
    coalesce((SELECT
        'authenticated=' || CASE WHEN has_function_privilege('authenticated', fn.oid, 'EXECUTE') THEN 'yes' ELSE 'no' END
        || ' anon=' || CASE WHEN has_function_privilege('anon', fn.oid, 'EXECUTE') THEN 'yes' ELSE 'no' END
        || ' public=' || CASE WHEN EXISTS (
             SELECT 1 FROM aclexplode(coalesce(fn.proacl, acldefault('f', fn.proowner))) AS a
             WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN 'yes' ELSE 'no' END
      FROM fn), 'MISSING')

  UNION ALL
  SELECT 'Q05', 'leads workflow + client triggers still enabled', 'leads_enforce_workflow:O,leads_sync_client:O',
    coalesce((SELECT string_agg(t.tgname::text || ':' || t.tgenabled::text, ',' ORDER BY t.tgname)
              FROM pg_trigger AS t
              WHERE t.tgrelid = to_regclass('public.leads') AND NOT t.tgisinternal
                AND t.tgname IN ('leads_enforce_workflow', 'leads_sync_client')), '(none)')

  UNION ALL
  SELECT fp.id, 'unchanged: ' || fp.sig, fp.expected,
    coalesce((SELECT md5(replace(p.prosrc, E'\r', '')) FROM pg_proc AS p WHERE p.oid = to_regprocedure(fp.sig)), 'MISSING')
  FROM fp

  UNION ALL
  SELECT 'Q10', 'leads that are not Confirmed but have a client', '0',
    (SELECT count(*)::text FROM public.clients AS c JOIN public.leads AS l ON l.id = c.lead_id
     WHERE l.status IS DISTINCT FROM 'Confirmed')

  UNION ALL
  SELECT 'Q11', 'leads_status_check still the Day 21 eight-status constraint',
    'CHECK ((status = ANY (ARRAY[''New Lead''::text, ''Contacted''::text, ''Interested''::text, ''Follow-up Required''::text, ''Awaiting Confirmation''::text, ''Confirmed''::text, ''Not Interested''::text, ''Lost Lead''::text])))',
    coalesce((SELECT pg_get_constraintdef(c.oid) FROM pg_constraint AS c
              WHERE c.conrelid = to_regclass('public.leads') AND c.conname = 'leads_status_check'), '(missing)')
)
SELECT id, check_name, actual IS NOT DISTINCT FROM expected AS ok, expected, actual
FROM checks
ORDER BY (actual IS NOT DISTINCT FROM expected), id;
