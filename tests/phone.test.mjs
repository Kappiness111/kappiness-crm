// Unit tests for app/lib/phone.js (Day 24). The examples are the same as T1 in
// supabase/tests/client_management_day24_test.sql, so the browser and the database agree. Run with:  node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePhone, samePhone } from "../app/lib/phone.js";

const EXAMPLES = [
  ["9876543210", "+919876543210"],
  ["98765 43210", "+919876543210"],
  ["98765-43210", "+919876543210"],
  ["(98765) 43210", "+919876543210"],
  ["+91 98765 43210", "+919876543210"],
  ["+91-98765-43210", "+919876543210"],
  ["+91 (0) 98765 43210", "+919876543210"],
  ["+9109876543210", "+919876543210"],
  ["09876543210", "+919876543210"],
  ["919876543210", "+919876543210"],
  ["0091 98765 43210", "+919876543210"],
  ["  +91.98765.43210  ", "+919876543210"],
  ["+91 98765 43210 ext 12", "+919876543210"],
  ["+44 7911 123456", "+447911123456"],
  ["0044 7911 123456", "+447911123456"],
  ["+44 98765 43210", "+449876543210"],
  ["+1 (202) 555-0123", "+12025550123"],
  ["+971 50 123 4567", "+971501234567"],
  ["(+44) 7911 123456", "+447911123456"],
  ["\xa0+44 7911 123456", "+447911123456"],
  ["\t+44 7911 123456", "+447911123456"],
  ["Tel: +44 7911 123456", "+447911123456"],
  ["(+1) 202 555 0123", "+12025550123"],
  ["1234567", "1234567"],
  ["12345", null],
  ["", null],
  ["not a number", null],
  ["+123", null],
];

test("normalizePhone matches the database rules", () => {
  for (const [input, expected] of EXAMPLES) {
    assert.equal(normalizePhone(input), expected, `normalizePhone(${JSON.stringify(input)})`);
  }
  assert.equal(normalizePhone(null), null);
  assert.equal(normalizePhone(undefined), null);
});

test("formatting differences are the same number", () => {
  assert.ok(samePhone("98765 43210", "+91-98765-43210"));
  assert.ok(samePhone("(0) 98765-43210", "0091 9876543210"));
});

test("the same national digits in another country are a different number", () => {
  assert.ok(!samePhone("+44 98765 43210", "+91 98765 43210"));
  assert.ok(!samePhone("+44 98765 43210", "9876543210"));
  assert.ok(!samePhone("+1 202 555 0123", "2025550123"));
});

test("bracketed or prefixed country codes are recognised", () => {
  assert.ok(samePhone("(+44) 7911 123456", "+44 7911 123456"));
  assert.ok(samePhone("\xa0+44 7911 123456", "Tel: +44 7911 123456"));
  assert.ok(samePhone("\t+44 7911 123456", "0044 7911 123456"));
  assert.ok(!samePhone("(+44) 7911 123456", "(+91) 79111 23456"));
});

test("unrecognisable numbers never match", () => {
  assert.ok(!samePhone("123", "123"));
  assert.ok(!samePhone("", ""));
});
