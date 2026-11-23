-- Kappiness CRM: PREFLIGHT REPORT for production deployment 202611130003. READ-ONLY (one SELECT).
-- GENERATED FILE: DO NOT EDIT. Regenerate with: node scripts/build-production-deploy.mjs (verify with --check)
-- Sources (sha256 with LF line endings):
--   supabase/migrations/202611130001_remediate_role_helpers_and_availability.sql  c4a81f279e2636a13301a88aea0357727e467afadb0678a1454fce3510ad7040
--   supabase/migrations/202611130002_appointment_reminders.sql  7db1cb568e5a80065e5d817fcd504240e36121958637b484f139cf6277203d52
--   supabase/deploy/parts/202611130003_preflight_checks.sql  549cb938eadd218627ebb5395c296242cc561e27a9416c8ab618705e949088a1
--   supabase/deploy/parts/202611130003_admin_assignment.sql  a779e02558ab32668a6213aec7edb8aaf31ecaf14fe55f133041fc0faf8ec2f5
--   supabase/deploy/parts/202611130003_behaviour_checks.sql  694c8d5c93828477e0248443391e89e853b6f9d540ceebf42b7fca126e19975a
--   supabase/deploy/parts/202611130003_postdeploy_checks.sql  5af5882929f3d73bb5c2b09d19409ec0ec266d96e203b55cab61444d34dfb9c2
--
-- Run BEFORE the deployment, alone, in the SQL Editor of the MAIN project. Every row must show ok = true
-- (failing rows sort first). The deployment runs the same checks and aborts on any failure.

-- Kappiness CRM production deployment 202611130003: PREFLIGHT CHECKS.
-- ONE read-only SELECT returning (check_name, expected, actual, ok). Edit here, then run
--   node scripts/build-production-deploy.mjs
-- It is embedded twice: as a table in 202611130003_01_preflight_report.sql, and as a strict check at the top of
-- 202611130003_02_production_deploy.sql (any ok = false aborts the transaction before anything changes).
-- No client or patient record content is read: only catalog data, function fingerprints and counts.
--
-- Fingerprint = md5 of pg_proc.prosrc with carriage returns removed.
--   AUDITED  values were read from production on 13 Nov 2026.
--   REPO     values come from 202611040001 as committed; the four audited ones match the repo exactly, which
--            shows production was built from these files. A mismatch means production changed: stop and review.
WITH expected_fp(fn, md5, source) AS (
  VALUES
    ('public.is_crm_staff()',                                                   '927078351f956d8e482743322e0f2b22', 'AUDITED'),
    ('public.is_crm_admin()',                                                   'f1e062ddce8e0265fc72a7d662e0e0ee', 'AUDITED'),
    ('public.update_lead_with_history(uuid, text, jsonb, jsonb)',               '2dc29d7ea4dade1797b141a2b86c408c', 'AUDITED'),
    ('public.enforce_lead_workflow()',                                          'a1a07bca19718034c78c824014060747', 'AUDITED'),
    ('public.crm_role()',                                                       '8b7bb33b96afb015b6af4c62d1ab2b53', 'REPO'),
    ('public.current_psychologist_id()',                                        '6a5e058441a5d4257c1b7d695947ac0a', 'REPO'),
    ('public.current_actor_name()',                                             '3bcf440ff185b01884a4bd608445b380', 'REPO'),
    ('public._can_manage_psychologist(uuid)',                                   '909bbbcea4ee38fbb66dc1790d3a0217', 'REPO'),
    ('public.book_appointment(uuid, uuid, uuid, timestamptz, text, uuid, text)', '0c25ffb3cfa622fdeb53041a496b7ade', 'REPO'),
    ('public.reschedule_appointment(uuid, timestamptz, uuid, text)',            'b2dfe8c23125444174baece37fdc9bb1', 'REPO'),
    ('public.cancel_appointment(uuid, text)',                                   'ac4778a4b105e7e242dc6db37bbdfd37', 'REPO'),
    ('public.confirm_appointment(uuid)',                                        '885bf2ed11541f4bc5b51bbdb48da11f', 'REPO'),
    ('public.record_attendance(uuid, boolean, text)',                           'b5acfeb14dad087caf5c38438d612a48', 'REPO'),
    ('public.appointments_before_write()',                                      '93261248f0492e3dbf7f5a9171ddde52', 'REPO'),
    ('public.log_appointment_status()',                                         'e0d2d13fcb9f9f0537d86226bac65fb8', 'REPO')
),
status_def AS (
  SELECT coalesce(string_agg(pg_get_constraintdef(c.oid), ' '), '') AS def
  FROM pg_constraint AS c
  WHERE c.conrelid = 'public.appointments'::regclass AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%status%'
),
checks(check_name, expected, actual, ok) AS (
  SELECT '01 connected role', 'postgres', current_user::text, current_user = 'postgres'

  UNION ALL
  SELECT '02 fingerprint ' || f.fn || ' [' || f.source || ']', f.md5, coalesce(a.m, 'MISSING'), a.m IS NOT DISTINCT FROM f.md5
  FROM expected_fp AS f
  LEFT JOIN LATERAL (SELECT md5(replace(p.prosrc, E'\r', '')) AS m FROM pg_proc AS p
                     WHERE p.oid = to_regprocedure(f.fn)) AS a ON true

  UNION ALL
  SELECT '03 public tables (exact set)', x.e, x.a, x.e = x.a
  FROM (SELECT 'appointment_status_history,appointments,clients,crm_staff_members,follow_up_recommendations,'
               || 'lead_activities,leads,leads_status_backup_202611030002,psychologist_availability,'
               || 'psychologist_availability_exceptions,psychologists,services,session_notes,session_status_history,sessions' AS e,
               (SELECT coalesce(string_agg(relname, ',' ORDER BY relname), '') FROM pg_class
                WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p')) AS a) AS x

  UNION ALL
  SELECT '04 objects this deployment creates are absent', 'none', coalesce(string_agg(o, ', '), 'none'), count(*) = 0
  FROM (VALUES
          (to_regclass('public.appointment_reminders')::text),
          (to_regclass('public.appointment_reminder_events')::text),
          (to_regclass('public.appointment_reminder_settings')::text),
          (to_regprocedure('public.is_own_psychologist(uuid)')::text),
          (to_regprocedure('public._assert_crm_staff_member(boolean)')::text),
          (to_regprocedure('public._create_appointment_reminders(uuid)')::text),
          (to_regprocedure('public.record_reminder_delivery(uuid, text, timestamptz, text)')::text),
          (to_regprocedure('public.record_reminder_response(uuid, text, text, timestamptz)')::text),
          (to_regprocedure('public.update_reminder_due_at(uuid, timestamptz, text)')::text),
          (to_regprocedure('public.set_reminder_offsets(interval, interval)')::text),
          ((SELECT 'policy availability_require_staff_or_owner' FROM pg_policy
            WHERE polrelid = 'public.psychologist_availability'::regclass AND polname = 'availability_require_staff_or_owner'))
       ) AS v(o)
  WHERE o IS NOT NULL

  UNION ALL
  SELECT '05 psychologist_availability policies (exact set)', x.e, x.a, x.e = x.a
  FROM (SELECT 'Active CRM staff can view psychologist availability,availability_delete_scoped,availability_insert_scoped,'
               || 'availability_read_scoped,availability_update_scoped,psychologists_delete_own_availability,'
               || 'psychologists_insert_own_availability,psychologists_read_own_availability,psychologists_update_own_availability' AS e,
               (SELECT coalesce(string_agg(polname, ',' ORDER BY polname), '') FROM pg_policy
                WHERE polrelid = 'public.psychologist_availability'::regclass) AS a) AS x

  UNION ALL
  SELECT '06 triggers on public tables (exact set)', x.e, x.a, x.e = x.a
  FROM (SELECT 'appointments.appointments_before_write,appointments.appointments_log_status,leads.leads_enforce_workflow,'
               || 'leads.leads_sync_client,leads.set_lead_code,psychologist_availability.availability_no_overlap,'
               || 'sessions.sessions_log_status,sessions.sessions_log_status_insert' AS e,
               (SELECT coalesce(string_agg(c.relname || '.' || t.tgname, ',' ORDER BY c.relname, t.tgname), '')
                FROM pg_trigger AS t JOIN pg_class AS c ON c.oid = t.tgrelid
                WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal) AS a) AS x

  UNION ALL
  SELECT '07 appointments.status allows', 'Scheduled,Confirmed,Rescheduled,Cancelled,Completed,Missed',
         coalesce((SELECT string_agg(u.status, ',' ORDER BY u.n) FROM unnest(ARRAY['Scheduled', 'Confirmed', 'Rescheduled',
                    'Cancelled', 'Completed', 'Missed']) WITH ORDINALITY AS u(status, n)
                   WHERE position(quote_literal(u.status) IN d.def) > 0), ''),
         (SELECT count(*) FROM unnest(ARRAY['Scheduled', 'Confirmed', 'Rescheduled', 'Cancelled', 'Completed', 'Missed']) AS u(status)
          WHERE position(quote_literal(u.status) IN d.def) > 0) = 6
  FROM status_def AS d

  UNION ALL
  SELECT '08 appointments columns used', 'id,recommendation_id,rescheduled_from_id,starts_at,status,cancellation_reason',
         coalesce(string_agg(column_name, ',' ORDER BY array_position(ARRAY['id', 'recommendation_id', 'rescheduled_from_id',
           'starts_at', 'status', 'cancellation_reason']::text[], column_name::text)), ''),
         count(*) = 6
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'appointments'
    AND column_name IN ('id', 'recommendation_id', 'rescheduled_from_id', 'starts_at', 'status', 'cancellation_reason')

  UNION ALL
  SELECT '09 tables with FORCE ROW LEVEL SECURITY', 'none',
         coalesce(string_agg(relname, ','), 'none'), count(*) = 0
  FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relforcerowsecurity

  UNION ALL
  SELECT '10 owner of tables read by definer functions', 'postgres',
         string_agg(DISTINCT pg_get_userbyid(relowner), ','), bool_and(relowner = 'postgres'::regrole::oid)
  FROM pg_class
  WHERE oid IN ('public.crm_staff_members'::regclass, 'public.psychologists'::regclass,
                'public.psychologist_availability'::regclass, 'public.appointments'::regclass)

  UNION ALL
  SELECT '11 active staff memberships (exactly 4: all become admin)', '4', count(*)::text, count(*) = 4
  FROM public.crm_staff_members WHERE is_active

  UNION ALL
  SELECT '12 accounts that would LOSE staff access', '0', count(*)::text, count(*) = 0
  FROM auth.users AS u
  WHERE NOT EXISTS (SELECT 1 FROM public.crm_staff_members AS m WHERE m.user_id = u.id AND m.is_active)
    AND NOT EXISTS (SELECT 1 FROM public.psychologists AS p WHERE p.auth_user_id = u.id)

  UNION ALL
  SELECT '13 psychologists who also have active staff membership (info: they become staff)', 'info',
         count(*)::text, true
  FROM public.psychologists AS p JOIN public.crm_staff_members AS m ON m.user_id = p.auth_user_id AND m.is_active

  UNION ALL
  SELECT '14 migration history has no 202611130001/202611130002', 'none',
         coalesce(string_agg(version, ','), 'none'), count(*) = 0
  FROM supabase_migrations.schema_migrations WHERE version IN ('202611130001', '202611130002')

  UNION ALL
  SELECT '15 follow-up appointments the reminder backfill will cover (info)', 'info', count(*)::text, true
  FROM public.appointments
  WHERE recommendation_id IS NOT NULL AND status IN ('Scheduled', 'Confirmed') AND starts_at > now()

  UNION ALL
  SELECT '16 crm_staff_members columns (exact set)', 'access_level,created_at,created_by,is_active,user_id',
         coalesce(string_agg(column_name::text, ',' ORDER BY column_name), ''),
         coalesce(string_agg(column_name::text, ',' ORDER BY column_name), '') = 'access_level,created_at,created_by,is_active,user_id'
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'crm_staff_members'

  UNION ALL
  SELECT '17 crm_staff_members.access_level CHECK allows staff and admin only', '(staff, admin)',
         coalesce(string_agg(pg_get_constraintdef(c.oid), ' '), 'MISSING'),
         count(*) = 1 AND bool_and(pg_get_constraintdef(c.oid) LIKE '%''staff''%'
                                   AND pg_get_constraintdef(c.oid) LIKE '%''admin''%')
  FROM pg_constraint AS c
  WHERE c.conrelid = 'public.crm_staff_members'::regclass AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%access_level%'

  UNION ALL
  SELECT '18 access levels now (info: active staff become admin, inactive untouched)', 'info',
         coalesce((SELECT string_agg(k || '=' || n, ', ' ORDER BY k)
                   FROM (SELECT CASE WHEN is_active THEN 'active ' ELSE 'inactive ' END || access_level AS k, count(*) AS n
                         FROM public.crm_staff_members GROUP BY 1) AS x), 'none'),
         true
)
SELECT check_name, expected, actual, ok FROM checks ORDER BY ok, check_name;
