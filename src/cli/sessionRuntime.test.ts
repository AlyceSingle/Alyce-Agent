import assert from "node:assert/strict";
import path from "node:path";
import { resolveSubagentAllowedRoots } from "./subagentAllowedRoots.js";
import { normalizePersistedSubagentProgress } from "./subagentProgress.js";

interface TestSettings {
  additionalDirectories: string[];
}

function runTests() {
  testSubagentAllowedRootsInheritDefaultWhenUnset();
  testSubagentAllowedRootsRestrictWhenSet();
  testPersistedSubagentProgressIsSanitized();
  testPersistedSubagentProgressIsLimited();
  console.log("sessionRuntime tests passed");
}

function createSettings(patch: Partial<TestSettings> = {}): TestSettings {
  return {
    additionalDirectories: [],
    ...patch
  };
}

function testSubagentAllowedRootsInheritDefaultWhenUnset() {
  const workspaceRoot = path.resolve("workspace");
  const projectExtra = path.resolve("project-extra");
  const sessionExtra = path.resolve("session-extra");

  const roots = resolveSubagentAllowedRoots(
    workspaceRoot,
    {
      policy: {}
    },
    createSettings({
      additionalDirectories: [projectExtra]
    }),
    [sessionExtra]
  );

  assert.deepEqual(roots, [
    workspaceRoot,
    projectExtra,
    sessionExtra
  ]);
}

function testSubagentAllowedRootsRestrictWhenSet() {
  const workspaceRoot = path.resolve("workspace");
  const projectExtra = path.resolve("project-extra");
  const sessionExtra = path.resolve("session-extra");
  const subagentRoot = path.resolve(workspaceRoot, "src");

  const roots = resolveSubagentAllowedRoots(
    workspaceRoot,
    {
      policy: {
        allowedRoots: ["src"]
      }
    },
    createSettings({
      additionalDirectories: [projectExtra]
    }),
    [sessionExtra]
  );

  assert.deepEqual(roots, [subagentRoot]);
}

function testPersistedSubagentProgressIsSanitized() {
  const progress = normalizePersistedSubagentProgress([
    {
      timestamp: "2026-05-06T00:00:01.000Z",
      type: "status",
      message: "x".repeat(4_100)
    },
    {
      timestamp: "2026-05-06T00:00:02.000Z",
      type: "unknown",
      message: "drop me"
    },
    "drop me too",
    {
      timestamp: "2026-05-06T00:00:03.000Z",
      type: "tool_result",
      toolName: "Read",
      rawArguments: "y".repeat(8_100),
      result: { invalid: true }
    }
  ]);

  assert.equal(progress.length, 2);
  assert.equal(progress[0]?.type, "status");
  assert.match(progress[0]?.message ?? "", /\[truncated 100 chars\]/);
  assert.equal(progress[1]?.type, "tool_result");
  assert.equal(progress[1]?.toolName, "Read");
  assert.match(progress[1]?.rawArguments ?? "", /\[truncated 100 chars\]/);
  assert.equal(progress[1]?.result, undefined);
}

function testPersistedSubagentProgressIsLimited() {
  const progress = normalizePersistedSubagentProgress(
    Array.from({ length: 105 }, (_, index) => ({
      timestamp: `2026-05-06T00:00:00.${String(index).padStart(3, "0")}Z`,
      type: "status",
      message: `event ${index}`
    }))
  );

  assert.equal(progress.length, 100);
  assert.equal(progress[0]?.message, "event 5");
  assert.equal(progress[99]?.message, "event 104");
}

runTests();
