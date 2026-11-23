// Unit tests for the closed-status reason rules shared by the lead drawer (LeadDetailsModal.js) and the page-level
// save check (page.js). Run with:  node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOST_STATUS,
  REASON_REQUIRED_STATUSES,
  STATUSES,
  buildLostReason,
  closedReasonErrors,
  closedReasonFor,
  confirmPathHint,
  statusOptions,
  isReasonRequired,
  missingReasonMessage,
  parseLostReason,
  reasonChangeFor,
  reasonFieldsFor,
  reasonLabel,
  reasonUpdateText,
  statusChangeText,
  validateLostReason,
} from "../app/lib/leads.js";

// A drawer draft as makeDraft() builds it (only the fields these rules read).
const draftFor = (lead, overrides = {}) => ({ status: lead.status, ...reasonFieldsFor(lead), ...overrides });

test("both closed statuses require a reason; nothing else does", () => {
  assert.deepEqual(REASON_REQUIRED_STATUSES, ["Not Interested", "Lost Lead"]);
  for (const status of REASON_REQUIRED_STATUSES) assert.equal(isReasonRequired(status), true);
  for (const status of ["New Lead", "Contacted", "Interested", "Follow-up Required", "Awaiting Confirmation", "Confirmed"]) {
    assert.equal(isReasonRequired(status), false, status);
  }
});

for (const status of REASON_REQUIRED_STATUSES) {
  test(`${status}: selecting it without a reason is refused (drawer and page check)`, () => {
    const lead = { status: "Interested", not_converted_reason: null };
    const errors = closedReasonErrors(draftFor(lead, { status, lost_reason: "", lost_detail: "" }), lead);
    assert.ok(errors.lost_reason, "drawer shows a reason error");
    assert.notEqual(missingReasonMessage(lead, { status, not_converted_reason: "" }), "");
    assert.notEqual(missingReasonMessage(lead, { status, not_converted_reason: "   " }), "");
    assert.notEqual(missingReasonMessage(lead, { status }), "");
    // "Other" needs its explanation.
    const other = closedReasonErrors(draftFor(lead, { status, lost_reason: "Other", lost_detail: " " }), lead);
    assert.ok(other.lost_detail);
  });

  test(`${status}: selecting it with a valid reason saves the reason and names the status in history`, () => {
    const lead = { status: "Awaiting Confirmation", not_converted_reason: null };
    const draft = draftFor(lead, { status, lost_reason: "No response", lost_detail: "" });
    assert.deepEqual(closedReasonErrors(draft, lead), {});
    assert.equal(closedReasonFor(draft, lead), "No response");
    assert.deepEqual(reasonChangeFor(lead.status, status, "No response"), { not_converted_reason: "No response" });
    assert.equal(missingReasonMessage(lead, { status, not_converted_reason: "No response" }), "");
    assert.equal(
      statusChangeText(lead.status, status, "No response"),
      `Status changed from Awaiting Confirmation to ${status}. Reason: No response`
    );
  });

  test(`${status}: an unchanged existing reason is preserved exactly, even a legacy free-text one`, () => {
    for (const saved of ["Budget constraints", "Other: Moved abroad", "called twice, no answer"]) {
      const lead = { status, not_converted_reason: saved };
      const draft = draftFor(lead);
      assert.deepEqual(closedReasonErrors(draft, lead), {});
      assert.equal(closedReasonFor(draft, lead), saved);
    }
    // An older closed record without a reason stays editable until its reason is touched.
    const legacy = { status, not_converted_reason: null };
    assert.deepEqual(closedReasonErrors(draftFor(legacy), legacy), {});
  });

  test(`${status}: editing the reason is validated, saved and recorded`, () => {
    const lead = { status, not_converted_reason: "Budget constraints" };
    const edited = draftFor(lead, { lost_reason: "Other", lost_detail: "Moved to Dubai" });
    assert.deepEqual(closedReasonErrors(edited, lead), {});
    assert.equal(closedReasonFor(edited, lead), "Other: Moved to Dubai");
    assert.equal(
      reasonUpdateText(status, "Other: Moved to Dubai"),
      status === LOST_STATUS ? "Lost reason updated: Other: Moved to Dubai" : `${status} reason updated: Other: Moved to Dubai`
    );
    const cleared = draftFor(lead, { lost_reason: "", lost_detail: "" });
    assert.ok(closedReasonErrors(cleared, lead).lost_reason, "a cleared reason is refused");
  });

  test(`${status}: has its own field label`, () => {
    assert.equal(reasonLabel(status), status === LOST_STATUS ? "Lost reason" : "Reason (Not Interested)");
  });
}

test("leaving a closed status clears the reason; other moves do not touch it", () => {
  assert.deepEqual(reasonChangeFor("Lost Lead", "Contacted", ""), { not_converted_reason: "" });
  assert.deepEqual(reasonChangeFor("Not Interested", "Contacted", ""), { not_converted_reason: "" });
  assert.deepEqual(reasonChangeFor("Contacted", "Interested", ""), {});
  const lead = { status: "Not Interested", not_converted_reason: "No response" };
  assert.equal(closedReasonFor(draftFor(lead, { status: "Contacted" }), lead), "");
  assert.deepEqual(closedReasonErrors(draftFor(lead, { status: "Contacted", lost_reason: "", lost_detail: "" }), lead), {});
});

test("non-closed status changes need no reason and keep the plain history text", () => {
  const lead = { status: "New Lead", not_converted_reason: null };
  assert.equal(missingReasonMessage(lead, { status: "Contacted" }), "");
  assert.deepEqual(closedReasonErrors(draftFor(lead, { status: "Contacted" }), lead), {});
  assert.equal(statusChangeText("New Lead", "Contacted"), "Status changed from New Lead to Contacted");
});

test("existing Lost Lead behaviour is unchanged", () => {
  // Reason format and parsing.
  assert.equal(buildLostReason("Other", "  Moved abroad "), "Other: Moved abroad");
  assert.equal(buildLostReason("Budget constraints"), "Budget constraints");
  assert.deepEqual(parseLostReason("Other: Moved abroad"), { choice: "Other", detail: "Moved abroad" });
  assert.deepEqual(parseLostReason("free text from an old record"), { choice: "Other", detail: "free text from an old record" });
  // Validation messages for Lost are the same as before.
  assert.deepEqual(validateLostReason("", ""), { choice: "Choose why this lead was lost." });
  assert.deepEqual(validateLostReason("Other", ""), { detail: "Add a short explanation for Other." });
  assert.deepEqual(validateLostReason("Other", "x".repeat(201)), { detail: "Keep the explanation under 200 characters." });
  assert.deepEqual(validateLostReason("No response", ""), {});
  // The page check still blocks Lost without a reason, and not an unchanged Lost lead.
  const lost = { status: LOST_STATUS, not_converted_reason: "No response" };
  assert.equal(missingReasonMessage({ status: "Interested" }, { status: LOST_STATUS }), "Choose a lost reason before marking this lead as Lost Lead.");
  assert.equal(missingReasonMessage(lost, { status: LOST_STATUS, notes: "x" }), "");
  // Not Interested gets its own wording.
  assert.deepEqual(validateLostReason("", "", "Not Interested"), { choice: "Choose why this lead is not interested." });
});

// The grouping StatusOptions (LeadDetailsModal.js) renders: active options, then "Close the lead" = every
// REASON_REQUIRED_STATUSES entry the lead may move to.
const groups = (current) => {
  const options = statusOptions(current);
  return { active: options.filter((s) => !isReasonRequired(s)), closing: options.filter((s) => isReasonRequired(s)) };
};

test("StatusOptions grouping: both closed statuses sit under Close the lead for every open status", () => {
  for (const status of ["New Lead", "Contacted", "Interested", "Follow-up Required", "Awaiting Confirmation"]) {
    const { active, closing } = groups(status);
    assert.deepEqual(closing, ["Not Interested", "Lost Lead"], status);
    assert.ok(active.includes(status), `${status} keeps its own status in the active group`);
    assert.ok(active.every((s) => !REASON_REQUIRED_STATUSES.includes(s)));
  }
  assert.deepEqual(groups("Interested").active, ["Interested", "Follow-up Required", "Awaiting Confirmation", "Confirmed"]);
});

test("StatusOptions grouping: final statuses offer only themselves", () => {
  assert.deepEqual(groups("Confirmed"), { active: ["Confirmed"], closing: [] });
  assert.deepEqual(groups("Not Interested"), { active: [], closing: ["Not Interested"] });
  assert.deepEqual(groups("Lost Lead"), { active: [], closing: ["Lost Lead"] });
});

test("confirmPathHint follows the eight-status matrix", () => {
  assert.equal(confirmPathHint("New Lead"), "To confirm: move to Interested, Follow-up Required or Awaiting Confirmation first, then Confirmed.");
  assert.equal(confirmPathHint("Contacted"), "To confirm: move to Interested, Follow-up Required or Awaiting Confirmation first, then Confirmed.");
  for (const status of ["Interested", "Follow-up Required", "Awaiting Confirmation", "Confirmed", "Not Interested", "Lost Lead"]) {
    assert.equal(confirmPathHint(status), "", status);
  }
  for (const old of ["Enquiry", "Yet to Confirm", "Will Inform", "Lost"]) assert.equal(confirmPathHint(old), "");
  assert.equal(STATUSES.length, 8);
});
