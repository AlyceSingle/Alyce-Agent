import assert from "node:assert/strict";
import {
  createPlanModeOverlayRules,
  getPlanModeToolViolation,
  isToolAllowedInPlanMode,
  PLAN_MODE_SYSTEM_INSTRUCTIONS
} from "./planMode.js";

function runTests() {
  testPlanModeToolAllowlist();
  testPlanModeOverlayRules();
  testPlanModeInstructionsDescribeVerification();
  console.log("planMode tests passed");
}

function testPlanModeToolAllowlist() {
  assert.equal(isToolAllowedInPlanMode("Read"), true);
  assert.equal(isToolAllowedInPlanMode("Grep"), true);
  assert.equal(isToolAllowedInPlanMode("TodoWrite"), true);
  assert.equal(isToolAllowedInPlanMode("PtyList"), true);
  assert.equal(isToolAllowedInPlanMode("PtyRead"), true);
  assert.equal(isToolAllowedInPlanMode("PtyCreate"), false);
  assert.equal(isToolAllowedInPlanMode("PtyWrite"), false);
  assert.equal(isToolAllowedInPlanMode("Write"), false);
  assert.equal(isToolAllowedInPlanMode("Edit"), false);
  assert.equal(isToolAllowedInPlanMode("apply_patch"), false);
  assert.equal(isToolAllowedInPlanMode("AgentTool"), false);
  assert.equal(isToolAllowedInPlanMode("mcp__demo__mutate"), false);
  assert.match(getPlanModeToolViolation("Write") ?? "", /blocked in Plan Mode/);
}

function testPlanModeOverlayRules() {
  assert.deepEqual(createPlanModeOverlayRules(false), []);

  const rules = createPlanModeOverlayRules(true);
  assert.equal(
    rules.some((rule) =>
      rule.permission === "file.write" &&
      rule.action === "deny"
    ),
    true
  );
  assert.equal(
    rules.some((rule) =>
      rule.permission === "shell" &&
      rule.action === "ask"
    ),
    true
  );
  assert.equal(
    rules.some((rule) =>
      rule.permission === "directory.external" &&
      rule.action === "ask"
    ),
    true
  );
}

function testPlanModeInstructionsDescribeVerification() {
  assert.match(PLAN_MODE_SYSTEM_INSTRUCTIONS, /Do not modify files/);
  assert.match(PLAN_MODE_SYSTEM_INSTRUCTIONS, /PtyList and PtyRead/);
  assert.match(PLAN_MODE_SYSTEM_INSTRUCTIONS, /verification steps/);
}

runTests();
