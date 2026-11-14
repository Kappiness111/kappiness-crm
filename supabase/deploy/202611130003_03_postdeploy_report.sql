-- Kappiness CRM: POST-DEPLOYMENT REPORT for production deployment 202611130003. READ-ONLY (one SELECT).
-- GENERATED FILE: DO NOT EDIT. Regenerate with: node scripts/build-production-deploy.mjs (verify with --check)
-- Sources (sha256 with LF line endings):
--   supabase/migrations/202611130001_remediate_role_helpers_and_availability.sql  c4a81f279e2636a13301a88aea0357727e467afadb0678a1454fce3510ad7040
--   supabase/migrations/202611130002_appointment_reminders.sql  7db1cb568e5a80065e5d817fcd504240e36121958637b484f139cf6277203d52
--   supabase/deploy/parts/202611130003_preflight_checks.sql  549cb938eadd218627ebb5395c296242cc561e27a9416c8ab618705e949088a1
--   supabase/deploy/parts/202611130003_admin_assignment.sql  a779e02558ab32668a6213aec7edb8aaf31ecaf14fe55f133041fc0faf8ec2f5
--   supabase/deploy/parts/202611130003_behaviour_checks.sql  694c8d5c93828477e0248443391e89e853b6f9d540ceebf42b7fca126e19975a
--   supabase/deploy/parts/202611130003_postdeploy_checks.sql  5af5882929f3d73bb5c2b09d19409ec0ec266d96e203b55cab61444d34dfb9c2
--
-- Run AFTER the deployment committed. Every row must show ok = true (failing rows sort first).
-- Also safe through the read-only MCP connection.

-- Kappiness CRM production deployment 202611130003: POST-DEPLOYMENT CHECKS.
-- ONE read-only SELECT returning (check_name, expected, actual, ok). Edit here, then run
--   node scripts/build-production-deploy.mjs
-- Embedded twice: at the end of 202611130003_02_production_deploy.sql (any ok = false rolls the whole deployment
-- back before COMMIT) and as the table in 202611130003_03_postdeploy_report.sql (run after COMMIT).
-- Read-only; no client or patient record content.
WITH unchanged_fp(fn, md5) AS (
  -- Functions this deployment must NOT change (same values as the preflight).
  VALUES
    ('public.update_lead_with_history(uuid, text, jsonb, jsonb)',               '2dc29d7ea4dade1797b141a2b86c408c'),
    ('public.enforce_lead_workflow()',                                          'a1a07bca19718034c78c824014060747'),
    ('public.crm_role()',                                                       '8b7bb33b96afb015b6af4c62d1ab2b53'),
    ('public.current_psychologist_id()',                                        '6a5e058441a5d4257c1b7d695947ac0a'),
    ('public.current_actor_name()',                                             '3bcf440ff185b01884a4bd608445b380'),
    ('public._can_manage_psychologist(uuid)',                                   '909bbbcea4ee38fbb66dc1790d3a0217'),
    ('public.book_appointment(uuid, uuid, uuid, timestamptz, text, uuid, text)', '0c25ffb3cfa622fdeb53041a496b7ade'),
    ('public.reschedule_appointment(uuid, timestamptz, uuid, text)',            'b2dfe8c23125444174baece37fdc9bb1'),
    ('public.cancel_appointment(uuid, text)',                                   'ac4778a4b105e7e242dc6db37bbdfd37'),
    ('public.confirm_appointment(uuid)',                                        '885bf2ed11541f4bc5b51bbdb48da11f'),
    ('public.record_attendance(uuid, boolean, text)',                           'b5acfeb14dad087caf5c38438d612a48'),
    ('public.appointments_before_write()',                                      '93261248f0492e3dbf7f5a9171ddde52'),
    ('public.log_appointment_status()',                                         'e0d2d13fcb9f9f0537d86226bac65fb8')
),
helper AS (
  SELECT h.fn, p.prosecdef, p.provolatile, p.proconfig, p.prosrc,
         has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
         EXISTS (SELECT 1 FROM aclexplode(p.proacl) AS a WHERE a.grantee = 0) AS public_x
  FROM (VALUES ('public.is_crm_staff()'), ('public.is_crm_admin()'), ('public.is_own_psychologist(uuid)')) AS h(fn)
  LEFT JOIN pg_proc AS p ON p.oid = to_regprocedure(h.fn)
),
reminder_tables(t) AS (
  VALUES ('public.appointment_reminders'), ('public.appointment_reminder_events'), ('public.appointment_reminder_settings')
),
checks(check_name, expected, actual, ok) AS (
  SELECT 'A1 unchanged ' || f.fn, f.md5, coalesce(a.m, 'MISSING'), a.m IS NOT DISTINCT FROM f.md5
  FROM unchanged_fp AS f
  LEFT JOIN LATERAL (SELECT md5(replace(p.prosrc, E'\r', '')) AS m FROM pg_proc AS p
                     WHERE p.oid = to_regprocedure(f.fn)) AS a ON true

  UNION ALL
  SELECT 'B1 helper ' || h.fn, 'definer, stable, search_path="", no JWT role, EXECUTE authenticated only',
         format('definer=%s volatile=%s config=%s anon=%s authenticated=%s public=%s',
                h.prosecdef, h.provolatile, h.proconfig, h.anon_x, h.auth_x, h.public_x),
         coalesce(h.prosecdef AND h.provolatile = 's' AND 'search_path=""' = ANY (h.proconfig)
                  AND position('crm_role' IN h.prosrc) = 0 AND position('app_metadata' IN h.prosrc) = 0
                  AND NOT h.anon_x AND h.auth_x AND NOT h.public_x, false)
  FROM helper AS h

  UNION ALL
  SELECT 'B2 is_crm_staff() uses active crm_staff_members only', 'crm_staff_members + is_active, no psychologists',
         left(regexp_replace(prosrc, '\s+', ' ', 'g'), 200),
         position('crm_staff_members' IN prosrc) > 0 AND position('is_active' IN prosrc) > 0
           AND position('psychologists' IN prosrc) = 0
  FROM pg_proc WHERE oid = 'public.is_crm_staff()'::regprocedure

  UNION ALL
  SELECT 'B3 is_crm_admin() uses crm_staff_members.access_level', 'crm_staff_members + access_level = admin',
         left(regexp_replace(prosrc, '\s+', ' ', 'g'), 200),
         position('crm_staff_members' IN prosrc) > 0 AND position('access_level' IN prosrc) > 0
  FROM pg_proc WHERE oid = 'public.is_crm_admin()'::regprocedure

  UNION ALL
  SELECT 'B4 no other public function decides access from crm_role()', 'none',
         coalesce(string_agg(oid::regprocedure::text, ', '), 'none'), count(*) = 0
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname <> 'crm_role' AND prosrc ~ 'crm_role\(\)\s*(IN|=|<>)'

  UNION ALL
  SELECT 'C1 restrictive availability policy', 'RESTRICTIVE ALL {authenticated}',
         coalesce((SELECT CASE WHEN polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END || ' '
                          || CASE polcmd WHEN '*' THEN 'ALL' ELSE polcmd::text END || ' '
                          || (SELECT array_agg(rolname)::text FROM pg_roles WHERE oid = ANY (polroles))
                   FROM pg_policy WHERE polrelid = 'public.psychologist_availability'::regclass
                     AND polname = 'availability_require_staff_or_owner'), 'MISSING'),
         EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.psychologist_availability'::regclass
                   AND polname = 'availability_require_staff_or_owner' AND NOT polpermissive AND polcmd = '*'
                   AND polroles = ARRAY['authenticated'::regrole::oid])

  UNION ALL
  SELECT 'C2 psychologist_availability policy count', '10 (9 existing + 1 restrictive)', count(*)::text, count(*) = 10
  FROM pg_policy WHERE polrelid = 'public.psychologist_availability'::regclass

  UNION ALL
  SELECT 'C3 anon privileges on ' || u.tbl, 'none',
         coalesce(nullif(concat_ws(',',
           CASE WHEN has_table_privilege('anon', u.tbl, 'SELECT') THEN 'SELECT' END,
           CASE WHEN has_table_privilege('anon', u.tbl, 'INSERT') THEN 'INSERT' END,
           CASE WHEN has_table_privilege('anon', u.tbl, 'UPDATE') THEN 'UPDATE' END,
           CASE WHEN has_table_privilege('anon', u.tbl, 'DELETE') THEN 'DELETE' END,
           CASE WHEN has_table_privilege('anon', u.tbl, 'TRUNCATE') THEN 'TRUNCATE' END,
           CASE WHEN has_table_privilege('anon', u.tbl, 'REFERENCES') THEN 'REFERENCES' END,
           CASE WHEN has_table_privilege('anon', u.tbl, 'TRIGGER') THEN 'TRIGGER' END), ''), 'none'),
         NOT has_table_privilege('anon', u.tbl, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
  FROM unnest(ARRAY['public.psychologist_availability', 'public.psychologists',
                    'public.appointment_reminders', 'public.appointment_reminder_events',
                    'public.appointment_reminder_settings']) AS u(tbl)

  UNION ALL
  SELECT 'C4 authenticated TRUNCATE/REFERENCES/TRIGGER on ' || u.tbl, 'none',
         CASE WHEN has_table_privilege('authenticated', u.tbl, 'TRUNCATE, REFERENCES, TRIGGER') THEN 'present' ELSE 'none' END,
         NOT has_table_privilege('authenticated', u.tbl, 'TRUNCATE, REFERENCES, TRIGGER')
  FROM unnest(ARRAY['public.psychologist_availability', 'public.psychologists', 'public.services']) AS u(tbl)

  UNION ALL
  SELECT 'C5 app privileges kept (availability SIUD, psychologists S, services SIU)', 'all true',
         format('avail=%s/%s/%s/%s psych=%s services=%s/%s/%s',
           has_table_privilege('authenticated', 'public.psychologist_availability', 'SELECT'),
           has_table_privilege('authenticated', 'public.psychologist_availability', 'INSERT'),
           has_table_privilege('authenticated', 'public.psychologist_availability', 'UPDATE'),
           has_table_privilege('authenticated', 'public.psychologist_availability', 'DELETE'),
           has_table_privilege('authenticated', 'public.psychologists', 'SELECT'),
           has_table_privilege('authenticated', 'public.services', 'SELECT'),
           has_table_privilege('authenticated', 'public.services', 'INSERT'),
           has_table_privilege('authenticated', 'public.services', 'UPDATE')),
         has_table_privilege('authenticated', 'public.psychologist_availability', 'SELECT')
           AND has_table_privilege('authenticated', 'public.psychologist_availability', 'INSERT')
           AND has_table_privilege('authenticated', 'public.psychologist_availability', 'UPDATE')
           AND has_table_privilege('authenticated', 'public.psychologist_availability', 'DELETE')
           AND has_table_privilege('authenticated', 'public.psychologists', 'SELECT')
           AND has_table_privilege('authenticated', 'public.services', 'SELECT')
           AND has_table_privilege('authenticated', 'public.services', 'INSERT')
           AND has_table_privilege('authenticated', 'public.services', 'UPDATE')

  UNION ALL
  SELECT 'D1 reminder table ' || r.t, 'RLS on; authenticated SELECT only; staff read policy',
         CASE WHEN to_regclass(r.t) IS NULL THEN 'MISSING' ELSE
           format('rls=%s auth_select=%s auth_write=%s staff_policy=%s',
             (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass(r.t)),
             has_table_privilege('authenticated', r.t, 'SELECT'),
             has_table_privilege('authenticated', r.t, 'INSERT, UPDATE, DELETE, TRUNCATE'),
             EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = to_regclass(r.t) AND polcmd = 'r'
                       AND pg_get_expr(polqual, polrelid) LIKE '%crm_staff_members%is_active%')) END,
         to_regclass(r.t) IS NOT NULL
           AND coalesce((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass(r.t)), false)
           AND has_table_privilege('authenticated', r.t, 'SELECT')
           AND NOT has_table_privilege('authenticated', r.t, 'INSERT, UPDATE, DELETE, TRUNCATE')
           AND EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = to_regclass(r.t) AND polcmd = 'r'
                         AND pg_get_expr(polqual, polrelid) LIKE '%crm_staff_members%is_active%')
           AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = to_regclass(r.t)
                             AND pg_get_expr(polqual, polrelid) ~ 'is_crm_(staff|admin)')
  FROM reminder_tables AS r

  UNION ALL
  SELECT 'D2 triggers on appointments', 'appointments_before_write,appointments_cancel_pending_reminders,appointments_create_reminders,appointments_log_status',
         coalesce(string_agg(tgname, ',' ORDER BY tgname), ''),
         coalesce(string_agg(tgname, ',' ORDER BY tgname), '')
           = 'appointments_before_write,appointments_cancel_pending_reminders,appointments_create_reminders,appointments_log_status'
  FROM pg_trigger WHERE tgrelid = 'public.appointments'::regclass AND NOT tgisinternal

  UNION ALL
  SELECT 'D3 reminder RPCs: authenticated only', 'anon=false authenticated=true (x4)',
         string_agg(format('%s anon=%s auth=%s', proname, has_function_privilege('anon', oid, 'EXECUTE'),
                           has_function_privilege('authenticated', oid, 'EXECUTE')), '; ' ORDER BY proname),
         count(*) = 4 AND bool_and(NOT has_function_privilege('anon', oid, 'EXECUTE')
                                   AND has_function_privilege('authenticated', oid, 'EXECUTE'))
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace
    AND proname IN ('record_reminder_delivery', 'record_reminder_response', 'update_reminder_due_at', 'set_reminder_offsets')

  UNION ALL
  SELECT 'D4 internal reminder functions not callable through the API', 'none callable',
         coalesce(string_agg(proname, ',') FILTER (WHERE has_function_privilege('authenticated', oid, 'EXECUTE')
                                                      OR has_function_privilege('anon', oid, 'EXECUTE')), 'none callable'),
         count(*) = 7 AND NOT bool_or(has_function_privilege('authenticated', oid, 'EXECUTE')
                                      OR has_function_privilege('anon', oid, 'EXECUTE'))
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace
    AND proname IN ('_assert_crm_staff_member', '_create_appointment_reminders', 'appointment_reminders_before_write',
                    'appointment_reminders_log_event', 'appointment_reminders_block_delete',
                    'appointment_reminders_on_appointment_insert', 'appointment_reminders_on_appointment_status')

  UNION ALL
  SELECT 'D5 reminder timing configured', 'reminder 1 > reminder 2 > 0',
         coalesce(string_agg(reminder_number || '=' || offset_before_start, ', ' ORDER BY reminder_number), 'MISSING'),
         count(*) = 2 AND max(offset_before_start) FILTER (WHERE reminder_number = 1)
                          > max(offset_before_start) FILTER (WHERE reminder_number = 2)
  FROM public.appointment_reminder_settings

  UNION ALL
  SELECT 'D6 every appointment with reminders has exactly slots 1 and 2', '0 violations', count(*)::text, count(*) = 0
  FROM (SELECT appointment_id FROM public.appointment_reminders GROUP BY appointment_id
        HAVING array_agg(reminder_number ORDER BY reminder_number) <> ARRAY[1, 2]::smallint[]) AS bad

  UNION ALL
  SELECT 'D7 active future follow-ups without reminders', '0', count(*)::text, count(*) = 0
  FROM public.appointments AS a
  WHERE a.recommendation_id IS NOT NULL AND a.status IN ('Scheduled', 'Confirmed') AND a.starts_at > now()
    AND NOT EXISTS (SELECT 1 FROM public.appointment_reminders AS r WHERE r.appointment_id = a.id)

  UNION ALL
  SELECT 'E1 active memberships: exactly 4, all admin', 'active=4 admin=4 not_admin=0',
         format('active=%s admin=%s not_admin=%s', count(*), count(*) FILTER (WHERE access_level = 'admin'),
                count(*) FILTER (WHERE access_level IS DISTINCT FROM 'admin')),
         count(*) = 4 AND count(*) FILTER (WHERE access_level = 'admin') = 4
  FROM public.crm_staff_members WHERE is_active = true

  UNION ALL
  SELECT 'E2 inactive memberships (info: never changed by this deployment)', 'info',
         coalesce((SELECT string_agg(access_level || '=' || n, ', ' ORDER BY access_level)
                   FROM (SELECT access_level, count(*) AS n FROM public.crm_staff_members
                         WHERE NOT is_active GROUP BY 1) AS x), 'none'),
         true
)
SELECT check_name, expected, actual, ok FROM checks ORDER BY ok, check_name;
