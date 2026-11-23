#!/usr/bin/env node
/*
  Kappiness CRM: builds the PRODUCTION deployment package 202611130003 (security remediation + reminder tracking).
  Owner: Aswathy (backend / security).

  WHY
    Production is in a hand-applied state (202611030001, 202611030002, 202611040001 live; 202611040002-05 and the
    old atomic bundle NOT applied). The old bundle cannot be replayed: it re-runs 202611030002 and 202611040001.
    This package applies only what is missing, in ONE transaction, behind strict fingerprint pre-flight checks:
      preflight (strict) -> 202611130001 remediation -> 202611130002 reminders -> behaviour checks
      -> post-deployment checks (strict) + row counts unchanged -> COMMIT
    Any failure anywhere rolls everything back.

  SAFETY
    * Never connects to a database and never executes SQL. Reads files, writes four generated files.
    * Migrations and check sources are read-only inputs.
    * Deterministic output (LF line endings, no timestamps). Reuses the scanner/unwrapper of
      scripts/build-deploy-bundle.mjs, so the same rules apply (one outer BEGIN/COMMIT per migration, no
      transaction control or non-transactional statements inside).

  USAGE
    node scripts/build-production-deploy.mjs           build the four files in supabase/deploy/
    node scripts/build-production-deploy.mjs --check   verify they are up to date (no writes)
*/

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanSql, unwrapMigration } from "./build-deploy-bundle.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const DEPLOY = join(ROOT, "supabase", "deploy");
const PARTS = join(DEPLOY, "parts");

const MIGRATION_SOURCES = [
  "202611130001_remediate_role_helpers_and_availability.sql",
  "202611130002_appointment_reminders.sql",
];
const PREFLIGHT = "202611130003_preflight_checks.sql";
const POSTDEPLOY = "202611130003_postdeploy_checks.sql";
const BEHAVIOUR = "202611130003_behaviour_checks.sql";
const ADMIN = "202611130003_admin_assignment.sql";

const OUT = {
  preflight: join(DEPLOY, "202611130003_01_preflight_report.sql"),
  deploy: join(DEPLOY, "202611130003_02_production_deploy.sql"),
  postdeploy: join(DEPLOY, "202611130003_03_postdeploy_report.sql"),
  behaviour: join(DEPLOY, "202611130003_04_behaviour_check.sql"),
};

// The 15 pre-existing public tables whose CONTENT must not change (except active access_level, see FINGERPRINT_SQL).
const EXISTING_TABLES = [
  "appointment_status_history", "appointments", "clients", "crm_staff_members", "follow_up_recommendations",
  "lead_activities", "leads", "leads_status_backup_202611030002", "psychologist_availability",
  "psychologist_availability_exceptions", "psychologists", "services", "session_notes", "session_status_history",
  "sessions",
];

const lf = (s) => s.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const fail = (msg) => {
  console.error(`FAIL     ${msg}`);
  process.exitCode = 1;
};

// A check source: leading comment block + exactly ONE SELECT (optionally ending in ';').
function loadQuery(name) {
  const raw = lf(readFileSync(join(PARTS, name), "utf8"));
  const scan = scanSql(raw);
  if (scan.errors.length) scan.errors.forEach((e) => fail(`${name}: ${e}`));
  if (scan.statements.length !== 1 || !/^WITH\b|^SELECT\b/i.test(scan.statements[0].text)) {
    fail(`${name}: expected exactly one SELECT statement, found ${scan.statements.length}`);
  }
  if (/\$(preflight|postcheck|snap)\$/.test(raw)) fail(`${name}: must not contain the wrapper dollar tags`);
  const query = raw.replace(/;\s*$/, "").replace(/\s+$/, "");
  return { raw, query, sha: sha256(raw) };
}

function loadStatements(name) {
  const raw = lf(readFileSync(join(PARTS, name), "utf8"));
  const scan = scanSql(raw);
  if (scan.errors.length) scan.errors.forEach((e) => fail(`${name}: ${e}`));
  scan.statements.forEach((s) => {
    if (/^(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE)\b/i.test(s.text)) {
      fail(`${name}: transaction control is not allowed (line ${s.line})`);
    }
  });
  return { raw, body: raw.replace(/\s+$/, ""), sha: sha256(raw) };
}

function strictBlock(tag, title, query, failurePrefix) {
  return [
    `DO $${tag}$`,
    `DECLARE`,
    `  deploy_check record;  -- name chosen so it cannot collide with aliases inside the query`,
    `  failures text := '';`,
    `  passed integer := 0;`,
    `BEGIN`,
    `  FOR deploy_check IN`,
    query.split("\n").map((l) => (l ? `    ${l}` : l)).join("\n"),
    `  LOOP`,
    `    IF deploy_check.ok IS DISTINCT FROM true THEN`,
    `      failures := failures || format(E'\\n  %s | expected: %s | actual: %s', deploy_check.check_name, deploy_check.expected, deploy_check.actual);`,
    `    ELSE`,
    `      passed := passed + 1;`,
    `    END IF;`,
    `  END LOOP;`,
    `  IF failures <> '' THEN`,
    `    RAISE EXCEPTION '${failurePrefix}%', failures;`,
    `  END IF;`,
    `  RAISE NOTICE '${title}: % checks passed', passed;`,
    `END`,
    `$${tag}$;`,
  ].join("\n");
}

function build() {
  const migrations = MIGRATION_SOURCES.map((name) => {
    const path = join(MIGRATIONS, name);
    if (!existsSync(path)) {
      fail(`missing ${name}`);
      return null;
    }
    const raw = readFileSync(path, "utf8");
    const result = unwrapMigration(name, raw);
    result.problems.forEach((p) => fail(`${name}: ${p}`));
    return { name, sha: sha256(lf(raw)), ...result };
  });
  const pre = loadQuery(PREFLIGHT);
  const post = loadQuery(POSTDEPLOY);
  const beh = loadStatements(BEHAVIOUR);
  const adm = loadStatements(ADMIN);
  if (process.exitCode) return null;

  const sources = [
    ...migrations.map((m) => `--   supabase/migrations/${m.name}  ${m.sha}`),
    `--   supabase/deploy/parts/${PREFLIGHT}  ${pre.sha}`,
    `--   supabase/deploy/parts/${ADMIN}  ${adm.sha}`,
    `--   supabase/deploy/parts/${BEHAVIOUR}  ${beh.sha}`,
    `--   supabase/deploy/parts/${POSTDEPLOY}  ${post.sha}`,
  ];
  const generated = [
    "-- GENERATED FILE: DO NOT EDIT. Regenerate with: node scripts/build-production-deploy.mjs (verify with --check)",
    "-- Sources (sha256 with LF line endings):",
    ...sources,
  ];

  const tableList = EXISTING_TABLES.map((t) => `'${t}'`).join(", ");
  // Per table: row count + md5 of every row's text form, computed inside the database (only the md5 and the count
  // are kept, in a transaction-local setting). For crm_staff_members the access_level of ACTIVE rows is masked:
  // that single column is what PART 2 is allowed to change; user_id, is_active, created_at, created_by and the
  // whole of every inactive row must stay identical.
  const fingerprintFn = [
    "  -- (shared by the before/after blocks)",
    "  sql := CASE WHEN t = 'crm_staff_members' THEN",
    "      'SELECT count(*), md5(coalesce(string_agg(x::text, E''\\n'' ORDER BY x::text), '''')) FROM ('",
    "      || 'SELECT user_id, is_active, created_at, created_by, CASE WHEN is_active THEN NULL ELSE access_level END'",
    "      || ' AS inactive_access_level FROM public.crm_staff_members) AS x'",
    "    ELSE format('SELECT count(*), md5(coalesce(string_agg(x::text, E''\\n'' ORDER BY x::text), '''')) FROM public.%I AS x', t)",
    "  END;",
    "  EXECUTE sql INTO n, h;",
  ].map((l) => `  ${l}`).join("\n");
  const snapshot = [
    "-- Content fingerprint (row count + md5 of all rows) of the 15 existing tables before any change.",
    "DO $snap$",
    "DECLARE",
    "  t text;",
    "  sql text;",
    "  n bigint;",
    "  h text;",
    "  fp jsonb := '{}'::jsonb;",
    "BEGIN",
    `  FOREACH t IN ARRAY ARRAY[${tableList}] LOOP`,
    fingerprintFn,
    "    fp := fp || jsonb_build_object(t, jsonb_build_object('rows', n, 'md5', h));",
    "  END LOOP;",
    "  PERFORM set_config('deploy.content_before', fp::text, true);",
    "END",
    "$snap$;",
  ].join("\n");
  const countsCheck = [
    "-- Existing data unchanged: same row count AND same content in all 15 pre-existing tables (crm_staff_members:",
    "-- everything except access_level of active rows). Any difference rolls the whole deployment back.",
    "DO $snap$",
    "DECLARE",
    "  t text;",
    "  sql text;",
    "  n bigint;",
    "  h text;",
    "  before jsonb := current_setting('deploy.content_before')::jsonb;",
    "  diffs text := '';",
    "BEGIN",
    `  FOREACH t IN ARRAY ARRAY[${tableList}] LOOP`,
    fingerprintFn,
    "    IF n IS DISTINCT FROM (before -> t ->> 'rows')::bigint OR h IS DISTINCT FROM (before -> t ->> 'md5') THEN",
    "      diffs := diffs || format(E'\\n  %s: rows %s -> %s, content %s', t, before -> t ->> 'rows', n,",
    "                                CASE WHEN h IS DISTINCT FROM (before -> t ->> 'md5') THEN 'CHANGED' ELSE 'same' END);",
    "    END IF;",
    "  END LOOP;",
    "  IF diffs <> '' THEN",
    "    RAISE EXCEPTION 'POST-DEPLOYMENT CHECK FAILED (existing data changed) - everything rolled back:%', diffs;",
    "  END IF;",
    "  RAISE NOTICE 'Content of the 15 existing tables unchanged (only active crm_staff_members.access_level may differ)';",
    "END",
    "$snap$;",
  ].join("\n");

  const banner = (title) => `\n-- ${"=".repeat(100)}\n-- ${title}\n-- ${"=".repeat(100)}\n`;
  const migrationPart = (n, m) =>
    banner(`PART ${n}: supabase/migrations/${m.name}  (its outer BEGIN; line ${m.beginLine} and COMMIT; line ${m.commitLine} removed)`) +
    m.body;

  const deploy = [
    "-- Kappiness CRM: PRODUCTION DEPLOYMENT 202611130003 = security remediation + admin access for the 4 active",
    "-- staff members + appointment reminder tracking.",
    ...generated,
    "--",
    "-- WHAT IT DOES (one transaction; any error rolls back EVERYTHING, so production is either fully deployed or",
    "-- exactly as before):",
    "--   PART 0  strict preflight: fingerprints of 15 functions, exact table/trigger/policy/column sets, status",
    "--           vocabulary, no FORCE RLS, owners, EXACTLY 4 active staff, 0 accounts losing access, not deployed.",
    "--           Then a content fingerprint of the 15 existing tables.",
    "--   PART 1  supabase/migrations/202611130001_remediate_role_helpers_and_availability.sql",
    "--   PART 2  supabase/deploy/parts/202611130003_admin_assignment.sql (4 active memberships -> admin)",
    "--   PART 3  supabase/migrations/202611130002_appointment_reminders.sql",
    "--   PART 4  behaviour checks with simulated logins (anon, stranger, staff, admins, psychologist). Writes nothing.",
    "--   PART 5  strict post-deployment checks + content of the 15 existing tables unchanged (except active",
    "--           crm_staff_members.access_level).",
    "--",
    "-- HOW TO RUN: supabase/migrations/README.md, section \"Production deployment 202611130003\".",
    "--   Supabase Dashboard > MAIN project > SQL Editor > New query > paste this WHOLE file > Run (whole script,",
    "--   nothing selected). Confirm the destructive-operation prompt (DROP POLICY IF EXISTS / REVOKE).",
    "--   Success: \"Success. No rows returned\". Any red error: nothing was changed.",
    "-- Do NOT run twice: the preflight refuses a second run (is_crm_staff fingerprint, objects already present).",
    "-- Do NOT use supabase db push.",
    "",
    "BEGIN;",
    "",
    "SET LOCAL lock_timeout = '5s';",
    "SET LOCAL statement_timeout = '120s';",
    banner("PART 0: PREFLIGHT (strict). Source: supabase/deploy/parts/" + PREFLIGHT),
    strictBlock("preflight", "PREFLIGHT PASSED", pre.query, "PREFLIGHT FAILED - nothing was changed:"),
    "",
    snapshot,
    migrationPart(1, migrations[0]),
    banner("PART 2: ADMIN ACCESS FOR THE 4 ACTIVE STAFF MEMBERS. Source: supabase/deploy/parts/" + ADMIN),
    adm.body,
    migrationPart(3, migrations[1]),
    banner("PART 4: BEHAVIOUR CHECKS. Source: supabase/deploy/parts/" + BEHAVIOUR),
    beh.body,
    banner("PART 5: POST-DEPLOYMENT CHECKS (strict). Source: supabase/deploy/parts/" + POSTDEPLOY),
    strictBlock("postcheck", "POST-DEPLOYMENT CHECKS PASSED", post.query,
      "POST-DEPLOYMENT CHECK FAILED - everything rolled back:"),
    "",
    countsCheck,
    "",
    "COMMIT;",
    "",
  ].join("\n");

  // Validate the deployment file: one BEGIN (first statement), one COMMIT (last), no other transaction control.
  const scan = scanSql(deploy);
  scan.errors.forEach((e) => fail(`deploy: ${e}`));
  const control = scan.statements.filter((s) =>
    /^(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE)\b/i.test(s.text)
  );
  if (control.length !== 2 || scan.statements[0].text !== "BEGIN" || scan.statements.at(-1).text !== "COMMIT") {
    fail("deploy: expected exactly one BEGIN (first statement) and one COMMIT (last statement)");
  }

  const preflightReport = [
    "-- Kappiness CRM: PREFLIGHT REPORT for production deployment 202611130003. READ-ONLY (one SELECT).",
    ...generated,
    "--",
    "-- Run BEFORE the deployment, alone, in the SQL Editor of the MAIN project. Every row must show ok = true",
    "-- (failing rows sort first). The deployment runs the same checks and aborts on any failure.",
    "",
    `${pre.query};`,
    "",
  ].join("\n");

  const postReport = [
    "-- Kappiness CRM: POST-DEPLOYMENT REPORT for production deployment 202611130003. READ-ONLY (one SELECT).",
    ...generated,
    "--",
    "-- Run AFTER the deployment committed. Every row must show ok = true (failing rows sort first).",
    "-- Also safe through the read-only MCP connection.",
    "",
    `${post.query};`,
    "",
  ].join("\n");

  const behaviour = [
    "-- Kappiness CRM: BEHAVIOUR CHECK for production deployment 202611130003. Ends in ROLLBACK: changes nothing.",
    ...generated,
    "--",
    "-- Run AFTER the deployment. Success = \"Success. No rows returned\"; any failure shows BEHAVIOUR FAIL ...",
    "",
    "BEGIN;",
    "",
    beh.body,
    "",
    "ROLLBACK;",
    "",
  ].join("\n");

  return { [OUT.preflight]: preflightReport, [OUT.deploy]: deploy, [OUT.postdeploy]: postReport, [OUT.behaviour]: behaviour };
}

function main() {
  const mode = process.argv[2] || "--build";
  if (!["--build", "--check"].includes(mode)) {
    console.error("Use no option to build, or --check.");
    process.exit(2);
  }
  const files = build();
  if (!files) {
    console.error("Nothing written.");
    process.exit(1);
  }
  let stale = false;
  for (const [path, content] of Object.entries(files)) {
    const rel = relative(ROOT, path);
    if (mode === "--check") {
      const current = existsSync(path) ? readFileSync(path, "utf8") : null;
      if (current !== content) {
        console.error(`STALE    ${rel}`);
        stale = true;
      } else console.log(`OK       ${rel}  sha256 ${sha256(content)}`);
    } else {
      writeFileSync(path, content, "utf8");
      console.log(`WROTE    ${rel}  sha256 ${sha256(content)}`);
    }
  }
  if (stale) {
    console.error("Run: node scripts/build-production-deploy.mjs");
    process.exit(1);
  }
}

main();
