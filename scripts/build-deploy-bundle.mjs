#!/usr/bin/env node
/*
  Kappiness CRM: SQL scanner library. (Former bundle builder; the bundle function was retired 13 Nov 2026.)
  Owner: Aswathy (backend / security).

  PURPOSE
    This file is kept ONLY for its two SQL scanner exports, which scripts/build-production-deploy.mjs imports:
      scanSql(text)               split SQL into top-level statements and dollar-quoted bodies
      unwrapMigration(name, raw)  validate and strip a migration's single outer BEGIN; / COMMIT;
    Both are unchanged from the original builder.

  WHAT IT NO LONGER DOES
    It does not build, check, validate or regenerate any bundle, and has no options. The 202611040005 atomic
    bundle it used to produce is retired: it is kept only as a record in supabase/deploy/retired/ (where it aborts
    if run) and must never be run. Reasons: supabase/migrations_superseded/README.md.

  RUNNING THIS FILE
    Running it directly does nothing except print a short notice and exit with code 1. For the production
    deployment package, use scripts/build-production-deploy.mjs.
*/

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

function main() {
  console.error(
    [
      "scripts/build-deploy-bundle.mjs is a library: it only exports scanSql / unwrapMigration and has nothing to run.",
      "  The 202611040005 atomic bundle is retired (supabase/deploy/retired/, aborts if run); there is no way to rebuild it.",
      "  Reasons: supabase/migrations_superseded/README.md",
      "  Production deployment package: scripts/build-production-deploy.mjs",
    ].join("\n")
  );
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
