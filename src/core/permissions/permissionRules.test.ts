import assert from "node:assert/strict";
import {
  createDefaultPermissionRuleSet,
  createPermissionRuleSet,
  evaluatePermission,
  getPermissionCategoriesForLegacyKind,
  getPermissionCategoriesForToolKind,
  matchesPermissionRule
} from "./permissionRules.js";

function runTests() {
  testBuiltInWorkspaceReadAllows();
  testBuiltInShellAsks();
  testSessionAllowOverridesBuiltInAsk();
  testDenyBeatsAllowAcrossSources();
  testSourcePriorityAllowsUserToOverrideProjectAsk();
  testHigherSourceAskOverridesLowerSourceAllow();
  testWildcardMatching();
  testExpiredRulesAreIgnored();
  testToolKindMapping();
  console.log("permissionRules tests passed");
}

function testBuiltInWorkspaceReadAllows() {
  const result = evaluatePermission({
    permission: "file.read",
    pattern: "workspace:src/index.ts",
    rulesets: [createDefaultPermissionRuleSet()]
  });

  assert.equal(result.action, "allow");
  assert.equal(result.matchedRule?.source, "built-in-default");
}

function testBuiltInShellAsks() {
  const result = evaluatePermission({
    permission: "shell",
    pattern: "npm run build",
    rulesets: [createDefaultPermissionRuleSet()]
  });

  assert.equal(result.action, "ask");
}

function testSessionAllowOverridesBuiltInAsk() {
  const result = evaluatePermission({
    permission: "shell",
    pattern: "npm run build",
    rulesets: [
      createDefaultPermissionRuleSet(),
      createPermissionRuleSet("session-approval", [
        {
          permission: "shell",
          pattern: "npm run build",
          action: "allow",
          scope: "session"
        }
      ])
    ]
  });

  assert.equal(result.action, "allow");
  assert.equal(result.matchedRule?.source, "session-approval");
}

function testDenyBeatsAllowAcrossSources() {
  const result = evaluatePermission({
    permission: "shell",
    pattern: "git reset --hard",
    rulesets: [
      createPermissionRuleSet("session-approval", [
        {
          permission: "shell",
          pattern: "*",
          action: "allow",
          scope: "session"
        }
      ]),
      createPermissionRuleSet("project-settings", [
        {
          permission: "shell",
          pattern: "git reset*",
          action: "deny",
          scope: "persistent"
        }
      ])
    ]
  });

  assert.equal(result.action, "deny");
  assert.equal(result.matchedRule?.source, "project-settings");
}

function testSourcePriorityAllowsUserToOverrideProjectAsk() {
  const result = evaluatePermission({
    permission: "web.fetch",
    pattern: "https://docs.example.com/page",
    rulesets: [
      createPermissionRuleSet("project-settings", [
        {
          permission: "web.fetch",
          pattern: "https://docs.example.com/*",
          action: "ask",
          scope: "persistent"
        }
      ]),
      createPermissionRuleSet("user-settings", [
        {
          permission: "web.fetch",
          pattern: "https://docs.example.com/*",
          action: "allow",
          scope: "persistent"
        }
      ])
    ]
  });

  assert.equal(result.action, "allow");
  assert.equal(result.matchedRule?.source, "user-settings");
}

function testHigherSourceAskOverridesLowerSourceAllow() {
  const result = evaluatePermission({
    permission: "directory.external",
    pattern: "D:\\Code\\external",
    rulesets: [
      createPermissionRuleSet("session-approval", [
        {
          permission: "directory.external",
          pattern: "*",
          action: "allow",
          scope: "session"
        }
      ]),
      createPermissionRuleSet("plan-mode-overlay", [
        {
          permission: "directory.external",
          pattern: "*",
          action: "ask",
          scope: "session"
        }
      ])
    ]
  });

  assert.equal(result.action, "ask");
  assert.equal(result.matchedRule?.source, "plan-mode-overlay");
}

function testWildcardMatching() {
  assert.equal(
    matchesPermissionRule(
      {
        permission: "directory.external",
        pattern: "D:\\Code\\*"
      },
      {
        permission: "directory.external",
        pattern: "D:\\Code\\opencode"
      }
    ),
    true
  );
  assert.equal(
    matchesPermissionRule(
      {
        permission: "web.search",
        pattern: "openai ?"
      },
      {
        permission: "web.search",
        pattern: "openai 5"
      }
    ),
    true
  );
}

function testExpiredRulesAreIgnored() {
  const result = evaluatePermission({
    permission: "powershell",
    pattern: "Get-ChildItem",
    now: new Date("2026-05-13T00:00:00.000Z"),
    rulesets: [
      createDefaultPermissionRuleSet(),
      createPermissionRuleSet("session-approval", [
        {
          permission: "powershell",
          pattern: "Get-ChildItem",
          action: "allow",
          scope: "session",
          expiresAt: "2026-05-12T00:00:00.000Z"
        }
      ])
    ]
  });

  assert.equal(result.action, "ask");
  assert.equal(result.matchedRule?.source, "built-in-default");
}

function testToolKindMapping() {
  assert.deepEqual(getPermissionCategoriesForToolKind("command", "PowerShell"), ["powershell"]);
  assert.deepEqual(getPermissionCategoriesForToolKind("file-read", "Read"), ["file.read"]);
  assert.deepEqual(getPermissionCategoriesForToolKind("file-write", "Edit"), ["file.edit"]);
  assert.deepEqual(getPermissionCategoriesForToolKind("file-write", "apply_patch"), ["file.patch"]);
  assert.deepEqual(getPermissionCategoriesForToolKind("web", "WebSearch"), ["web.search"]);
  assert.deepEqual(getPermissionCategoriesForToolKind("mcp", "custom__tool"), ["mcp.tool"]);
  assert.deepEqual(getPermissionCategoriesForLegacyKind("command"), ["shell", "powershell"]);
}

runTests();
