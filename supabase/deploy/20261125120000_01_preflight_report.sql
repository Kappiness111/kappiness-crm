-- Kappiness CRM Day 24: PREFLIGHT REPORT for 20261125120000_client_management_duplicates_communication.sql.
-- Run BEFORE the migration, in the SQL Editor, as one script. It ends in ROLLBACK and changes nothing: the only object
-- it creates is a temporary copy of normalize_phone (pg_temp), which disappears with the rollback.
--
-- Result sets:
--   R1  dependencies: fingerprints of the functions the migration relies on (all must say OK)
--   R2  summary: shared-number groups (ALLOWED), possible duplicate profiles, unrecognisable phones
--   R3  every existing client that shares a normalised phone number, one row per client, grouped by number.
--       Shared numbers are ALLOWED (team decision 25 Nov 2026) and do NOT block the migration. The "review" column
--       separates the two cases:
--         'Possible duplicate profile' : same number AND same name (lower-case, trimmed): likely one person twice
--         'Shared number (allowed)'    : same number, different names: likely family members; no action needed
--       Minimal personal data: masked phone (last 4 digits), name initials, Client ID, original lead code, dates,
--       status and counts. Look a Client ID up in the CRM to see the full profile.
--   R4  data-quality: clients whose phone is not a recognisable number (never matched until corrected)
--   R5  counts: clients, clients that will get a referral source from their original lead, open leads whose number
--       matches an existing client (staff will see the suggestion in the lead drawer)
--
-- Nothing in this report, and nothing in the migration, merges, deletes, changes, deactivates or links any client.
-- See "Reviewing shared numbers" at the end of this file.

BEGIN;

CREATE FUNCTION pg_temp.d24_normalize_phone(p_phone text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  v text := btrim(p_phone);
  d text;
  plus boolean;
BEGIN
  v := regexp_replace(v, '\s*(ext\.?|extension|x|#)\s*[0-9]{1,6}\s*$', '', 'i');
  plus := left(regexp_replace(v, '[^0-9+]', '', 'g'), 1) = '+';
  d := regexp_replace(v, '[^0-9]', '', 'g');
  IF d = '' THEN RETURN NULL; END IF;
  IF NOT plus AND left(d, 2) = '00' THEN plus := true; d := substr(d, 3); END IF;
  IF plus THEN
    IF length(d) = 13 AND left(d, 3) = '910' THEN d := '91' || substr(d, 4); END IF;
    IF length(d) BETWEEN 8 AND 15 THEN RETURN '+' || d; END IF;
    RETURN NULL;
  END IF;
  IF length(d) = 10 THEN RETURN '+91' || d; END IF;
  IF length(d) = 11 AND left(d, 1) = '0' THEN RETURN '+91' || substr(d, 2); END IF;
  IF length(d) = 12 AND left(d, 2) = '91' THEN RETURN '+' || d; END IF;
  IF length(d) BETWEEN 7 AND 15 THEN RETURN d; END IF;
  RETURN NULL;
END;
$$;

-- R1
SELECT f.sig AS function_name,
       md5(replace(p.prosrc, E'\r', '')) AS fingerprint,
       CASE WHEN md5(replace(p.prosrc, E'\r', '')) = ANY(f.expected) THEN 'OK' ELSE 'REVIEW: not the expected version' END AS result
FROM (VALUES
  ('public.update_lead_with_history(uuid,text,jsonb,jsonb)', ARRAY['0a62ea753396e7da751446e34373c29e']),
  ('public.enforce_lead_workflow()', ARRAY['7c9f820ac5dd11e57e6b4a11b2785a6b']),
  ('public.book_appointment(uuid,uuid,uuid,timestamptz,text,uuid,text)', ARRAY['0c25ffb3cfa622fdeb53041a496b7ade']),
  ('public.convert_lead_to_appointment(uuid,text,uuid,uuid,timestamptz,text)', ARRAY['d61213476b5d2537d729a08e91a008eb']),
  ('public.sync_client_from_lead()', ARRAY['4109aa9bd681941e084d44732f35a38c', '23111b570f26fbfe2c75dd2d8b74f64f', '913c7560fceaa9e09468c3e6cb298a83'])
) AS f(sig, expected)
LEFT JOIN pg_proc AS p ON p.oid = to_regprocedure(f.sig)
UNION ALL
SELECT 'tables follow_ups / activity_log (Sariga, 202611210002 / 202611210004)', NULL,
       CASE WHEN to_regclass('public.follow_ups') IS NOT NULL AND to_regclass('public.activity_log') IS NOT NULL
            THEN 'OK' ELSE 'MISSING: apply them first' END;

CREATE TEMP TABLE d24_phone ON COMMIT DROP AS
SELECT c.id, c.full_name, c.is_active, c.created_at, c.lead_id,
       pg_temp.d24_normalize_phone(c.phone) AS n, lower(btrim(c.full_name)) AS name_key
FROM public.clients AS c;

-- R2
SELECT
  (SELECT count(*) FROM (SELECT n FROM d24_phone WHERE n IS NOT NULL GROUP BY n HAVING count(*) > 1) AS g)
    AS shared_number_groups_allowed,
  (SELECT count(*) FROM d24_phone AS x WHERE x.n IS NOT NULL
     AND (SELECT count(*) FROM d24_phone AS y WHERE y.n = x.n) > 1) AS clients_in_shared_groups,
  (SELECT count(*) FROM (SELECT 1 FROM d24_phone WHERE n IS NOT NULL GROUP BY n, name_key HAVING count(*) > 1) AS g)
    AS possible_duplicate_profile_groups,
  (SELECT count(*) FROM d24_phone WHERE n IS NULL) AS clients_without_recognisable_phone;

-- R3
SELECT '...' || right(x.n, 4) AS phone_masked,
       dense_rank() OVER (ORDER BY x.n) AS group_no,
       count(*) OVER (PARTITION BY x.n) AS clients_with_this_number,
       CASE WHEN count(*) OVER (PARTITION BY x.n, x.name_key) > 1 THEN 'Possible duplicate profile'
            ELSE 'Shared number (allowed)' END AS review,
       x.id AS client_id,
       (SELECT string_agg(left(w, 1), '' ORDER BY o) FROM regexp_split_to_table(btrim(x.full_name), '\s+') WITH ORDINALITY AS t(w, o))
         AS initials,
       l.lead_code AS original_lead, x.is_active, x.created_at::date AS client_since,
       (SELECT count(*) FROM public.appointments AS a WHERE a.client_id = x.id) AS appointments,
       (SELECT count(*) FROM public.sessions AS s WHERE s.client_id = x.id AND s.status = 'Completed') AS completed_sessions
FROM d24_phone AS x
LEFT JOIN public.leads AS l ON l.id = x.lead_id
WHERE x.n IN (SELECT n FROM d24_phone WHERE n IS NOT NULL GROUP BY n HAVING count(*) > 1)
ORDER BY group_no, x.created_at;

-- R4
SELECT x.id AS client_id, length(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g')) AS digits_in_phone,
       'Phone not recognisable: never matched until corrected' AS review
FROM d24_phone AS x JOIN public.clients AS c ON c.id = x.id
WHERE x.n IS NULL;

-- R5
SELECT
  (SELECT count(*) FROM public.clients) AS clients,
  (SELECT count(*) FROM public.clients AS c JOIN public.leads AS l ON l.id = c.lead_id
   WHERE nullif(btrim(l.source), '') IS NOT NULL) AS clients_getting_referral_source,
  (SELECT count(*) FROM public.leads AS l
   WHERE l.status <> 'Confirmed'
     AND pg_temp.d24_normalize_phone(l.phone) IN (SELECT pg_temp.d24_normalize_phone(c.phone) FROM public.clients AS c))
    AS open_leads_matching_an_existing_client;

ROLLBACK;

-- Reviewing shared numbers (no deadline: the migration does not depend on it). A person decides, per group:
--   'Shared number (allowed)'    : nothing to do if they are different people (family members).
--   'Possible duplicate profile' : check whether it is really one person. If it is, agree which profile is kept
--      (usually the one with the appointment history). Do NOT delete or merge rows by hand: appointments, sessions and
--      follow-ups reference the client with ON DELETE RESTRICT. A merge would be a separate, reviewed change; until
--      then the extra profile can be marked inactive from the client profile (with a reason) once it has no open
--      appointments.
--   R4 rows: correct the phone number on the client profile.
