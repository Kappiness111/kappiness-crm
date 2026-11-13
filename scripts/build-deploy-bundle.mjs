#!/usr/bin/env node
/*
  Kappiness CRM: builds ONE atomic deployment file from several migrations.
  Owner: Aswathy (backend / security).

  WHY
    202611040001 must never be committed without 202611040003 (insecure role helpers), and 202611030002
    must never be committed without 202611040001 + 202611040004 (weaker lead workflow). Each migration ends
    with its own COMMIT, so they cannot simply be run one after another. This script removes each file's
    exact outer "BEGIN;" / "COMMIT;" lines and wraps everything in a single BEGIN/COMMIT.

  SAFETY
    * Never executes SQL and never connects to any database. It only reads files and writes one file.
    * Source migrations are read-only inputs; they are never modified.
    * Output is deterministic: same inputs -> byte-identical output (LF line endings, no timestamps).
    * Fails (exit code 1) on anything unexpected: a missing file, not exactly one outer BEGIN/COMMIT,
      SQL outside the wrapper, or any transaction-control / non-transactional statement inside a file.

  USAGE
    node scripts/build-deploy-bundle.mjs              build supabase/deploy/202611040005_atomic_bundle.sql
    node scripts/build-deploy-bundle.mjs --check      verify the existing output is up to date (no writes)
    node scripts/build-deploy-bundle.mjs --validate   validate the source migrations only (no writes)
*/

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
const OUTPUT = join(ROOT, "supabase", "deploy", "202611040005_atomic_bundle.sql");

// Order matters: each file's prerequisite checks expect the previous ones in the same transaction.
export const SOURCES = [
  "202611030002_lead_status_lost_and_psychologist.sql",
  "202611040001_clients_appointments_sessions.sql",
  "202611040003_role_helpers_use_staff_membership.sql",
  "202611040004_preserve_live_lead_function.sql",
  "202611040005_psychologist_availability_security.sql",
];

/* ------------------------------------------------------------------------------------------------
   SQL scanner: splits text into top-level statements, skipping comments, quoted strings, quoted
   identifiers and dollar-quoted bodies. Returns statements plus the dollar-quoted bodies.
   ------------------------------------------------------------------------------------------------ */
const IDENT_CHAR = /[A-Za-z0-9_$]/;

export function scanSql(text) {
  const statements = []; // { text, line } with comments removed, quoted content replaced by placeholders
  const dollarBodies = []; // { body, line }
  const errors = [];
  let current = "";
  let currentLine = null;
  let line = 1;
  let i = 0;
  const n = text.length;

  const mark = () => {
    if (currentLine === null) currentLine = line;
  };
  const advance = (count) => {
    for (let k = 0; k < count; k += 1) if (text[i + k] === "\n") line += 1;
    i += count;
  };

  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === "-" && next === "-") {
      const end = text.indexOf("\n", i);
      advance(end === -1 ? n - i : end - i);
      continue;
    }
    if (ch === "/" && next === "*") {
      const startLine = line;
      let depth = 0;
      while (i < n) {
        if (text[i] === "/" && text[i + 1] === "*") {
          depth += 1;
          advance(2);
        } else if (text[i] === "*" && text[i + 1] === "/") {
          depth -= 1;
          advance(2);
          if (depth === 0) break;
        } else advance(1);
      }
      if (depth !== 0) errors.push(`line ${startLine}: unterminated block comment`);
      current += " ";
      continue;
    }
    if (ch === "'") {
      mark();
      const prev = text[i - 1];
      const escapeStyle = (prev === "E" || prev === "e") && !IDENT_CHAR.test(text[i - 2] || "");
      const startLine = line;
      advance(1);
      let closed = false;
      while (i < n) {
        if (escapeStyle && text[i] === "\\") {
          advance(2);
        } else if (text[i] === "'" && text[i + 1] === "'") {
          advance(2);
        } else if (text[i] === "'") {
          advance(1);
          closed = true;
          break;
        } else advance(1);
      }
      if (!closed) errors.push(`line ${startLine}: unterminated string literal`);
      current += "'?'";
      continue;
    }
    if (ch === '"') {
      mark();
      const startLine = line;
      advance(1);
      let closed = false;
      while (i < n) {
        if (text[i] === '"' && text[i + 1] === '"') advance(2);
        else if (text[i] === '"') {
          advance(1);
          closed = true;
          break;
        } else advance(1);
      }
      if (!closed) errors.push(`line ${startLine}: unterminated quoted identifier`);
      current += '"?"';
      continue;
    }
    if (ch === "$" && !IDENT_CHAR.test(text[i - 1] || "")) {
      const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64));
      if (match) {
        mark();
        const tag = match[0];
        const startLine = line;
        const bodyStart = i + tag.length;
        const end = text.indexOf(tag, bodyStart);
        if (end === -1) {
          errors.push(`line ${startLine}: unterminated dollar-quoted body ${tag}`);
          advance(n - i);
          continue;
        }
        dollarBodies.push({ body: text.slice(bodyStart, end), line: startLine });
        advance(end + tag.length - i);
        current += "$body$";
        continue;
      }
    }
    if (ch === ";") {
      if (current.trim()) statements.push({ text: current.trim().replace(/\s+/g, " "), line: currentLine });
      current = "";
      currentLine = null;
      advance(1);
      continue;
    }
    if (!/\s/.test(ch)) mark();
    current += ch;
    advance(1);
  }
  if (current.trim()) {
    errors.push(`line ${currentLine}: statement without a terminating semicolon: ${current.trim().slice(0, 60)}`);
  }
  return { statements, dollarBodies, errors };
}

// Top-level statements that are never allowed inside a migration body (the bundle owns the transaction),
// and statements PostgreSQL refuses to run inside a transaction block.
const FORBIDDEN_STATEMENTS = [
  [/^(BEGIN|START\s+TRANSACTION)\b/i, "transaction control (BEGIN / START TRANSACTION)"],
  [/^(COMMIT|END|ROLLBACK|ABORT)\b/i, "transaction control (COMMIT / END / ROLLBACK / ABORT)"],
  [/^(SAVEPOINT|RELEASE)\b/i, "transaction control (SAVEPOINT / RELEASE)"],
  [/^(PREPARE\s+TRANSACTION|COMMIT\s+PREPARED|ROLLBACK\s+PREPARED)\b/i, "two-phase commit"],
  [/^SET\s+(SESSION\s+)?TRANSACTION\b/i, "transaction characteristics"],
  [/^VACUUM\b/i, "VACUUM cannot run inside a transaction"],
  [/^(CREATE|DROP)\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i, "INDEX CONCURRENTLY cannot run inside a transaction"],
  [/^REINDEX\b.*\bCONCURRENTLY\b/i, "REINDEX CONCURRENTLY cannot run inside a transaction"],
  [/^ALTER\s+SYSTEM\b/i, "ALTER SYSTEM cannot run inside a transaction"],
  [/^(CREATE|DROP|ALTER)\s+DATABASE\b/i, "database-level DDL cannot run inside a transaction"],
  [/^(CREATE|DROP)\s+TABLESPACE\b/i, "tablespace DDL cannot run inside a transaction"],
  [/^ALTER\s+TYPE\b.*\bADD\s+VALUE\b/i, "ALTER TYPE ... ADD VALUE (new value unusable in the same transaction)"],
  [/^CREATE\s+SUBSCRIPTION\b/i, "CREATE SUBSCRIPTION cannot run inside a transaction"],
  [/^COPY\b.*\bFROM\s+STDIN\b/i, "COPY FROM STDIN needs client-side data"],
  [/^CALL\b/i, "CALL may commit inside a procedure"],
];

// Transaction control inside function / DO bodies (would fail or commit early inside the bundle).
const FORBIDDEN_IN_BODY = /^\s*(COMMIT|ROLLBACK)(\s+AND\s+(NO\s+)?CHAIN)?\s*;/im;

/* ------------------------------------------------------------------------------------------------
   Wrapper handling
   ------------------------------------------------------------------------------------------------ */
export function unwrapMigration(name, raw) {
  const problems = [];
  const text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");

  const beginLines = [];
  const commitLines = [];
  lines.forEach((value, index) => {
    if (value === "BEGIN;") beginLines.push(index);
    if (value === "COMMIT;") commitLines.push(index);
  });
  if (beginLines.length !== 1) problems.push(`expected exactly one outer "BEGIN;" line, found ${beginLines.length}`);
  if (commitLines.length !== 1) problems.push(`expected exactly one outer "COMMIT;" line, found ${commitLines.length}`);
  if (problems.length) return { problems };

  const [b] = beginLines;
  const [c] = commitLines;
  if (c <= b) return { problems: ['"COMMIT;" comes before "BEGIN;"'] };

  const before = lines.slice(0, b).join("\n");
  const after = lines.slice(c + 1).join("\n");
  const body = lines.slice(b + 1, c).join("\n");

  const beforeScan = scanSql(before);
  const afterScan = scanSql(after);
  if (beforeScan.statements.length || beforeScan.dollarBodies.length) problems.push('SQL found before the outer "BEGIN;"');
  if (afterScan.statements.length || afterScan.dollarBodies.length) problems.push('SQL found after the outer "COMMIT;"');

  const scan = scanSql(body);
  scan.errors.forEach((error) => problems.push(`body ${error} (body line numbers start after BEGIN; at file line ${b + 1})`));
  scan.statements.forEach((statement) => {
    for (const [pattern, reason] of FORBIDDEN_STATEMENTS) {
      if (pattern.test(statement.text)) {
        problems.push(`file line ${b + 1 + statement.line}: ${reason}: ${statement.text.slice(0, 80)}`);
      }
    }
  });
  scan.dollarBodies.forEach((item) => {
    if (FORBIDDEN_IN_BODY.test(item.body)) {
      problems.push(`file line ${b + 1 + item.line}: COMMIT/ROLLBACK inside a function or DO body`);
    }
  });
  // psql meta-commands (backslash at the start of a line, outside quoted text) are not SQL.
  body.split("\n").forEach((value, index) => {
    if (/^\s*\\[A-Za-z!?]/.test(value)) problems.push(`file line ${b + 2 + index}: psql meta-command`);
  });

  return {
    problems,
    header: before,
    body: body.replace(/\s+$/, ""),
    beginLine: b + 1,
    commitLine: c + 1,
    statementCount: scan.statements.length,
    bodyCount: scan.dollarBodies.length,
  };
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
// Source fingerprint independent of checkout line endings (core.autocrlf), so --check agrees on every machine.
const normalizedSha256 = (raw) => sha256(raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n"));

export function buildBundle(sources) {
  const parts = [];
  const report = [];
  const failures = [];

  for (const { name, raw } of sources) {
    const result = unwrapMigration(name, raw);
    if (result.problems.length) {
      failures.push(...result.problems.map((problem) => `${name}: ${problem}`));
      continue;
    }
    report.push({
      name,
      sha256: normalizedSha256(raw),
      beginLine: result.beginLine,
      commitLine: result.commitLine,
      statements: result.statementCount,
      bodies: result.bodyCount,
    });
    parts.push(
      `-- =====================================================================================\n` +
        `-- BEGIN ${name}  (outer BEGIN; at line ${result.beginLine} and COMMIT; at line ${result.commitLine} removed)\n` +
        `-- =====================================================================================\n` +
        `${result.body}\n` +
        `-- END ${name}\n`
    );
  }
  if (failures.length) return { failures, report };

  const header = [
    "-- Kappiness CRM: ATOMIC DEPLOYMENT BUNDLE. GENERATED FILE: DO NOT EDIT.",
    "-- Regenerate with: node scripts/build-deploy-bundle.mjs   (verify with --check)",
    "--",
    "-- Everything below runs in ONE transaction. Any error rolls back every part, so the insecure role",
    "-- helpers of 202611040001 and the weaker lead function of 202611030002 are never committed.",
    "-- Run with psql -v ON_ERROR_STOP=1 (or the Supabase SQL editor) ONLY after the reviewed prerequisites.",
    "--",
    "-- Sources (sha256 of each file with LF line endings):",
    ...report.map((item) => `--   ${item.name}  ${item.sha256}`),
    "",
  ].join("\n");

  const bundle = `${header}\nBEGIN;\n\n${parts.join("\n")}\nCOMMIT;\n`;

  // Validate the result: exactly one top-level BEGIN and one top-level COMMIT, first and last.
  const scan = scanSql(bundle);
  const control = scan.statements.filter((statement) => /^(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE)\b/i.test(statement.text));
  if (scan.errors.length) failures.push(...scan.errors.map((error) => `bundle: ${error}`));
  if (
    control.length !== 2 ||
    control[0].text !== "BEGIN" ||
    control[1].text !== "COMMIT" ||
    scan.statements[0].text !== "BEGIN" ||
    scan.statements[scan.statements.length - 1].text !== "COMMIT"
  ) {
    failures.push("bundle: expected exactly one BEGIN (first statement) and one COMMIT (last statement)");
  }
  return { failures, report, bundle, statementCount: scan.statements.length };
}

function loadSources() {
  const missing = SOURCES.filter((name) => !existsSync(join(MIGRATIONS_DIR, name)));
  const present = SOURCES.filter((name) => !missing.includes(name)).map((name) => ({
    name,
    raw: readFileSync(join(MIGRATIONS_DIR, name), "utf8"),
  }));
  return { missing, present };
}

function main() {
  const mode = process.argv[2] || "--build";
  if (!["--build", "--check", "--validate"].includes(mode)) {
    console.error(`Unknown option ${mode}. Use --check or --validate, or no option to build.`);
    process.exit(2);
  }

  const { missing, present } = loadSources();

  if (mode === "--validate") {
    let ok = missing.length === 0;
    missing.forEach((name) => console.error(`MISSING  ${name}`));
    present.forEach(({ name, raw }) => {
      const result = unwrapMigration(name, raw);
      if (result.problems.length) {
        ok = false;
        result.problems.forEach((problem) => console.error(`FAIL     ${name}: ${problem}`));
      } else {
        console.log(
          `OK       ${name}: BEGIN; line ${result.beginLine}, COMMIT; line ${result.commitLine}, ` +
            `${result.statementCount} statements, ${result.bodyCount} dollar-quoted bodies, ` +
            `${/\r\n/.test(raw) ? "CRLF" : "LF"}, sha256(LF) ${normalizedSha256(raw).slice(0, 12)}`
        );
      }
    });
    console.log(ok ? "Validation passed." : "Validation FAILED.");
    process.exit(ok ? 0 : 1);
  }

  if (missing.length) {
    missing.forEach((name) => console.error(`MISSING  ${name}`));
    console.error("Refusing to build a partial bundle: every migration in SOURCES is required.");
    process.exit(1);
  }

  const result = buildBundle(present);
  if (result.failures.length) {
    result.failures.forEach((failure) => console.error(`FAIL     ${failure}`));
    console.error("Bundle NOT written.");
    process.exit(1);
  }

  const target = relative(ROOT, OUTPUT);
  if (mode === "--check") {
    const existing = existsSync(OUTPUT) ? readFileSync(OUTPUT, "utf8") : null;
    if (existing !== result.bundle) {
      console.error(`${target} is missing or out of date. Run: node scripts/build-deploy-bundle.mjs`);
      process.exit(1);
    }
    console.log(`${target} is up to date (sha256 ${sha256(result.bundle)}).`);
    return;
  }

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, result.bundle, "utf8");
  result.report.forEach((item) =>
    console.log(`OK       ${item.name}: ${item.statements} statements, ${item.bodies} dollar-quoted bodies`)
  );
  console.log(`Wrote ${target}: ${result.statementCount} top-level statements, sha256 ${sha256(result.bundle)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
