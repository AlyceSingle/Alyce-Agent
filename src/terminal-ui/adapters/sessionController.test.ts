import assert from "node:assert/strict";
import type { SessionSettingsState } from "../../config/runtime.js";
import type { BackgroundProcessRecord } from "../../core/background-process/backgroundProcessTypes.js";
import { createInitialTerminalUiState } from "../state/actions.js";
import { createTerminalUiStore } from "../state/store.js";
import type { TerminalUiMessage } from "../state/types.js";
import type { SessionRuntime } from "../../cli/sessionRuntime.js";
import { __SESSION_CONTROLLER_TESTING__, createSessionController } from "./sessionController.js";

async function runTests() {
  testMergeThinkingContentSkipsWhitespaceChunk();
  testMergeThinkingContentAcceptsInitialChunk();
  testMergeThinkingContentPrefersCumulativeSnapshot();
  testMergeThinkingContentAppendsDeltaChunkWithoutLosingWhitespace();
  testMergeThinkingContentAvoidsDuplicateTailDelta();
  testMergeThinkingContentAppendsOnlyNonOverlappingSuffix();
  testExtractThinkingDeltaForInitialSnapshot();
  testExtractThinkingDeltaForSuffixGrowth();
  testExtractThinkingDeltaForUnchangedSnapshot();
  testExtractThinkingDeltaForOverlap();
  testShouldSkipApprovalDialog();
  testBuildApprovalModePermissionRules();
  testIsFileRestoreAvailable();
  testBackgroundPanelOnlyShowsRunningNonAutoReviewerTasks();
  testBackgroundProcessCountOnlyIncludesRunningProcesses();
  testParseAutoReviewDecision();
  testFormatPromptSkillSummary();
  await testSettingsCommandOpensSessionSettings();
  await testSettingsConnectionCommandOpensConnectDialog();
  await testConnectCommandOpensInteractiveDialog();
  await testModelCommandOpensInteractiveDialog();
  await testLegacyModelCommandShowsMigrationError();
  await testSkillsCommandListsAvailableSkills();
  await testSkillsCommandEmptyStateShowsSkillRoots();
  await testSkillsCommandShowsSkillDetails();
  await testLegacySkillsShowCommandShowsMigrationError();
  await testSkillsDisableCommandUpdatesRuntime();
  await testSkillsRefreshCommandShowsRefreshSummary();
  await testSkillsCommandFailureShowsErrorMessage();
  await testMcpListCommandShowsServers();
  await testMcpStatusCommandInitializesRuntime();
  await testMcpStatusCommandEmptyStateShowsConfigPaths();
  await testMcpPromptsCommandShowsPromptSummary();
  await testMcpPromptCommandShowsPromptMessages();
  await testMcpTemplatesCommandShowsTemplates();
  await testMcpAddCommandUpdatesRuntime();
  await testMcpDisableCommandUpdatesRuntime();
  await testMcpCommandFailureShowsErrorMessage();
  await testMcpLoginCommandShowsResult();
  testInitializeShowsRuntimeBootstrapSummary();
  await testConnectDialogSubmissionAppliesProviderConnection();
  await testConnectDialogOAuthFlowAppliesProviderAuth();
  testConnectDialogCancelClearsPendingProviderAuth();
  await testModelDialogSelectionSwitchesModel();
  await testProcessCommandsRouteThroughController();
  await testWaitForUiPaintYieldsToMacrotask();
  console.log("sessionController tests passed");
}

function testMergeThinkingContentSkipsWhitespaceChunk() {
  const merged = __SESSION_CONTROLLER_TESTING__.mergeThinkingContent("hello", "   ");
  assert.equal(merged, "hello");
}

function testMergeThinkingContentAcceptsInitialChunk() {
  const merged = __SESSION_CONTROLLER_TESTING__.mergeThinkingContent("", "hello");
  assert.equal(merged, "hello");
}

function testMergeThinkingContentPrefersCumulativeSnapshot() {
  const merged = __SESSION_CONTROLLER_TESTING__.mergeThinkingContent("hello", "hello world");
  assert.equal(merged, "hello world");
}

function testMergeThinkingContentAppendsDeltaChunkWithoutLosingWhitespace() {
  const merged = __SESSION_CONTROLLER_TESTING__.mergeThinkingContent("hello", " world");
  assert.equal(merged, "hello world");
}

function testMergeThinkingContentAvoidsDuplicateTailDelta() {
  const merged = __SESSION_CONTROLLER_TESTING__.mergeThinkingContent("hello world", " world");
  assert.equal(merged, "hello world");
}

function testMergeThinkingContentAppendsOnlyNonOverlappingSuffix() {
  const merged = __SESSION_CONTROLLER_TESTING__.mergeThinkingContent(
    "The quick brown f",
    "fox jumps"
  );
  assert.equal(merged, "The quick brown fox jumps");
}

function testExtractThinkingDeltaForInitialSnapshot() {
  const delta = __SESSION_CONTROLLER_TESTING__.extractThinkingDelta("", "hello");
  assert.equal(delta, "hello");
}

function testExtractThinkingDeltaForSuffixGrowth() {
  const delta = __SESSION_CONTROLLER_TESTING__.extractThinkingDelta("hello", "hello world");
  assert.equal(delta, " world");
}

function testExtractThinkingDeltaForUnchangedSnapshot() {
  const delta = __SESSION_CONTROLLER_TESTING__.extractThinkingDelta("hello", "hello");
  assert.equal(delta, "");
}

function testExtractThinkingDeltaForOverlap() {
  const delta = __SESSION_CONTROLLER_TESTING__.extractThinkingDelta("The quick brown f", "fox jumps");
  assert.equal(delta, "ox jumps");
}

function testShouldSkipApprovalDialog() {
  const shouldSkip = __SESSION_CONTROLLER_TESTING__.shouldSkipApprovalDialog;

  assert.equal(shouldSkip({ action: "allow" }, { forceAsk: false }, "default"), true);
  assert.equal(shouldSkip({ action: "allow" }, { forceAsk: true }, "default"), false);
  assert.equal(shouldSkip({ action: "allow" }, { forceAsk: true }, "full-access"), true);
  assert.equal(shouldSkip(null, { forceAsk: true }, "full-access"), true);
  assert.equal(shouldSkip({ action: "deny" }, { forceAsk: false }, "full-access"), false);
}

function testBuildApprovalModePermissionRules() {
  const rules = __SESSION_CONTROLLER_TESTING__.buildApprovalModePermissionRules;

  assert.deepEqual(rules("read-only"), []);
  assert.deepEqual(
    rules("default").map((rule) => `${rule.permission}:${rule.pattern}:${rule.action}`),
    [
      "file.write:workspace:*:allow",
      "file.edit:workspace:*:allow",
      "file.patch:workspace:*:allow",
      "shell:*:allow",
      "powershell:*:allow"
    ]
  );
  assert.deepEqual(
    rules("auto-review").map((rule) => `${rule.permission}:${rule.pattern}:${rule.action}`),
    [
      "file.write:workspace:*:allow",
      "file.edit:workspace:*:allow",
      "file.patch:workspace:*:allow",
      "shell:*:allow",
      "powershell:*:allow"
    ]
  );
  assert.deepEqual(
    rules("full-access").map((rule) => `${rule.permission}:${rule.pattern}:${rule.action}`),
    ["*:*:allow"]
  );
}

function testIsFileRestoreAvailable() {
  const isAvailable = __SESSION_CONTROLLER_TESTING__.isFileRestoreAvailable;

  assert.equal(isAvailable({
    hasTrackedChanges: true,
    canRestore: true,
    alreadyRestored: false
  }), true);
  assert.equal(isAvailable({
    hasTrackedChanges: true,
    canRestore: false,
    alreadyRestored: true
  }), true);
  assert.equal(isAvailable({
    hasTrackedChanges: true,
    canRestore: false,
    alreadyRestored: false
  }), false);
  assert.equal(isAvailable({
    hasTrackedChanges: false,
    canRestore: true,
    alreadyRestored: true
  }), false);
}

function testBackgroundPanelOnlyShowsRunningNonAutoReviewerTasks() {
  const isVisible = __SESSION_CONTROLLER_TESTING__.isVisibleBackgroundTask;

  assert.equal(isVisible({ agentType: "auto-reviewer", status: "running" }), false);
  assert.equal(isVisible({ agentType: "review", status: "running" }), true);
  assert.equal(isVisible({ agentType: "general", status: "running" }), true);
  assert.equal(isVisible({ agentType: "review", status: "completed" }), false);
  assert.equal(isVisible({ agentType: "review", status: "failed" }), false);
  assert.equal(isVisible({ agentType: "review", status: "stopped" }), false);
}

function testBackgroundProcessCountOnlyIncludesRunningProcesses() {
  const isVisible = __SESSION_CONTROLLER_TESTING__.isVisibleBackgroundProcess;

  assert.equal(isVisible({ status: "running" }), true);
  assert.equal(isVisible({ status: "starting" }), false);
  assert.equal(isVisible({ status: "exited" }), false);
  assert.equal(isVisible({ status: "failed" }), false);
  assert.equal(isVisible({ status: "stopped" }), false);
}

function testParseAutoReviewDecision() {
  const parse = __SESSION_CONTROLLER_TESTING__.parseAutoReviewDecision;

  assert.deepEqual(
    parse('{"decision":"approve","confidence":0.9,"reason":"Scoped request."}'),
    {
      decision: "approve",
      confidence: 0.9,
      reason: "Scoped request."
    }
  );
  assert.deepEqual(
    parse('```json\n{"decision":"reject","confidence":2,"reason":"Too broad."}\n```'),
    {
      decision: "reject",
      confidence: 1,
      reason: "Too broad."
    }
  );
  assert.equal(parse('{"decision":"maybe","confidence":0.9}'), null);
  assert.equal(parse("not json"), null);
}

function testFormatPromptSkillSummary() {
  const format = __SESSION_CONTROLLER_TESTING__.formatPromptSkillSummary;

  assert.equal(format({
    generatedMessages: [],
    loadedSkillNames: [],
    unresolvedMentions: ["HOME"],
    disabledMentions: [],
    duplicateWarnings: [],
    dependencyWarnings: []
  }), null);

  assert.match(
    format({
      generatedMessages: [],
      loadedSkillNames: ["code-review"],
      unresolvedMentions: ["missing-skill"],
      disabledMentions: ["disabled-skill"],
      duplicateWarnings: ["Project skill 'code-review' overrides user skill."],
      dependencyWarnings: ["Skill 'code-review' requires MCP server 'github', but it is not configured."]
    }) ?? "",
    /Loaded skill context from prompt mentions: code-review/
  );
  assert.match(
    format({
      generatedMessages: [],
      loadedSkillNames: ["code-review"],
      unresolvedMentions: ["missing-skill"],
      disabledMentions: ["disabled-skill"],
      duplicateWarnings: ["Project skill 'code-review' overrides user skill."],
      dependencyWarnings: ["Skill 'code-review' requires MCP server 'github', but it is not configured."]
    }) ?? "",
    /requires MCP server 'github'/
  );
}

async function testSettingsCommandOpensSessionSettings() {
  const runtime = createRuntimeStub({});
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);

  await controller.submit("/settings");

  const dialog = store.getState().dialogQueue[0];
  assert.equal(dialog?.type, "settings");
}

async function testSettingsConnectionCommandOpensConnectDialog() {
  const runtime = createRuntimeStub({});
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);

  await controller.submit("/settings connection");

  assert.equal(store.getState().dialogQueue[0]?.type, "connect-provider");
}

async function testConnectCommandOpensInteractiveDialog() {
  const runtime = createRuntimeStub({});
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);

  await controller.submit("/connect");

  assert.equal(store.getState().dialogQueue[0]?.type, "connect-provider");
}

async function testModelCommandOpensInteractiveDialog() {
  let refreshCalled = false;
  const runtime = createRuntimeStub({
    refreshCurrentProviderModels: async () => {
      refreshCalled = true;
      return {
        providerId: "openai",
        providerLabel: "OpenAI",
        models: {
          "gpt-live": { label: "GPT Live" }
        },
        source: "live"
      };
    }
  });
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);

  await controller.submit("/model");

  const dialog = store.getState().dialogQueue[0];
  assert.equal(refreshCalled, true);
  assert.equal(dialog?.type, "model-picker");
  assert.equal(dialog?.type === "model-picker" ? dialog.state.status : "", "ready");
  assert.equal(dialog?.type === "model-picker" ? dialog.state.source : "", "live");
}

async function testLegacyModelCommandShowsMigrationError() {
  const runtime = createRuntimeStub({});
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);

  await controller.submit("/models");

  assert.match(lastMessage(store.getState().messages)?.content ?? "", /Use \/model/);
}

async function testSkillsCommandListsAvailableSkills() {
  const runtime = createRuntimeStub({
    listSkills: async () => ({
      skills: [
        {
          id: "project:code-review:123456",
          name: "code-review",
          normalizedName: "code-review",
          description: "Review code changes.",
          shortDescription: "Review code changes.",
          whenToUse: "Use when the user asks for a review.",
          allowedTools: ["Read"],
          activationPaths: [],
          dependencies: [],
          source: "project",
          skillFilePath: "C:\\workspace\\.alyce\\skills\\code-review\\SKILL.md",
          baseDirectory: "C:\\workspace\\.alyce\\skills\\code-review",
          content: "# skill",
          sampleFiles: [],
          duplicatePaths: []
        }
      ],
      disabledSkills: [],
      duplicateWarnings: [],
      disabledWarnings: [],
      configWarnings: []
    })
  });
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);

  await controller.submit("/skills");

  assert.match(lastMessage(store.getState().messages)?.content ?? "", /Available skills/);
  assert.match(lastMessage(store.getState().messages)?.content ?? "", /code-review/);
}

async function testSkillsCommandEmptyStateShowsSkillRoots() {
  const runtime = createRuntimeStub({});
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);

  await controller.submit("/skills");

  const output = lastMessage(store.getState().messages)?.content ?? "";
  assert.match(output, /Skill roots:/);
  assert.match(output, /No SKILL\.md files were found/);
  assert.match(output, /C:\\workspace\\\.alyce\\skills/);
}

async function testSkillsCommandShowsSkillDetails() {
  const runtime = createRuntimeStub({
    listSkills: async () => ({
      skills: [
        {
          id: "project:code-review:123456",
          name: "code-review",
          normalizedName: "code-review",
          description: "Review code changes.",
          shortDescription: "Review code changes.",
          whenToUse: "Use when the user asks for a review.",
          allowedTools: ["Read", "Edit"],
          activationPaths: ["src/**/*.ts"],
          dependencies: [],
          source: "project",
          skillFilePath: "C:\\workspace\\.alyce\\skills\\code-review\\SKILL.md",
          baseDirectory: "C:\\workspace\\.alyce\\skills\\code-review",
          content: "# skill",
          sampleFiles: ["template.md"],
          duplicatePaths: []
        }
      ],
      disabledSkills: [],
      duplicateWarnings: [],
      disabledWarnings: [],
      configWarnings: []
    })
  });
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);

  await controller.submit("/skills code-review");

  assert.match(lastMessage(store.getState().messages)?.content ?? "", /Skill code-review/);
  assert.match(lastMessage(store.getState().messages)?.content ?? "", /Allowed tools: Read, Edit/);
}

async function testLegacySkillsShowCommandShowsMigrationError() {
  const runtime = createRuntimeStub({});
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);

  await controller.submit("/skills show code-review");

  assert.match(lastMessage(store.getState().messages)?.content ?? "", /Use \/skills code-review/);
}

async function testSkillsDisableCommandUpdatesRuntime() {
  let received: { enabled: boolean; target: string; kind: string; value?: string } | null = null;
  const runtime = createRuntimeStub({
    setSkillEnabled: async (reference, enabled, target) => {
      received = { enabled, target, kind: reference.kind, value: "value" in reference ? reference.value : undefined };
      return {
        changed: true,
        target,
        configPath: "C:\\workspace\\.alyce\\skills.json",
        catalog: {
          skills: [],
          disabledSkills: [],
          duplicateWarnings: [],
          disabledWarnings: [],
          configWarnings: []
        },
        message: "Disabled skill 'code-review' in project config."
      };
    }
  });
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);

  await controller.submit("/skills disable code-review");

  assert.deepEqual(received, {
    enabled: false,
    target: "project",
    kind: "name",
    value: "code-review"
  });
  assert.match(lastMessage(store.getState().messages)?.content ?? "", /Disabled skill 'code-review'/);
}

async function testSkillsRefreshCommandShowsRefreshSummary() {
  const runtime = createRuntimeStub({
    refreshSkills: async () => ({
      skills: [],
      disabledSkills: [
        {
          id: "bundled:test-fix:test-fix",
          name: "test-fix",
          normalizedName: "test-fix",
          description: "Fix tests.",
          shortDescription: "Fix tests.",
          allowedTools: [],
          activationPaths: [],
          dependencies: [],
          source: "bundled",
          skillFilePath: "bundled://test-fix/SKILL.md",
          baseDirectory: "bundled://test-fix",
          content: "# skill",
          sampleFiles: [],
          duplicatePaths: [],
          disabledReason: "bundled skills are disabled by config"
        }
      ],
      duplicateWarnings: [],
      disabledWarnings: [],
      configWarnings: []
    })
  });
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);

  await controller.submit("/skills refresh");

  assert.match(lastMessage(store.getState().messages)?.content ?? "", /Skill catalog refreshed/);
  assert.match(lastMessage(store.getState().messages)?.content ?? "", /Disabled: 1/);
}

async function testSkillsCommandFailureShowsErrorMessage() {
  const runtime = createRuntimeStub({
    setSkillEnabled: async () => {
      throw new Error("Unknown skill: missing-skill");
    }
  });
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);

  await controller.submit("/skills enable missing-skill");

  assert.match(lastMessage(store.getState().messages)?.content ?? "", /Command failed: Unknown skill: missing-skill/);
  assert.equal(store.getState().statusText, "Error");
}

async function testMcpListCommandShowsServers() {
  const runtime = createRuntimeStub({
    getMcpStatus: async () => ({
      servers: [{
        name: "chrome",
        scope: "project",
        enabled: true,
        required: false,
        status: "not_initialized",
        transport: "stdio",
        endpoint: "npx -y chrome-devtools-mcp@latest",
        capabilities: {
          tools: false,
          resources: false,
          prompts: false
        },
        toolCount: 0,
        directToolCount: 0,
        hiddenToolCount: 0,
        toolExposure: "direct"
      }]
    })
  });
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);

  await controller.submit("/mcp");

  assert.match(lastMessage(store.getState().messages)?.content ?? "", /Configured MCP servers/);
  assert.match(lastMessage(store.getState().messages)?.content ?? "", /chrome/);
}

async function testMcpStatusCommandInitializesRuntime() {
  const initializeValues: Array<boolean | undefined> = [];
  const runtime = createRuntimeStub({
    getMcpStatus: async (options) => {
      initializeValues.push(options?.initialize);
      return { servers: [] };
    }
  });
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);

  await controller.submit("/mcp status");

  assert.deepEqual(initializeValues, [true]);
  assert.match(lastMessage(store.getState().messages)?.content ?? "", /MCP status/);
}

async function testMcpStatusCommandEmptyStateShowsConfigPaths() {
  const runtime = createRuntimeStub({});
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);

  await controller.submit("/mcp status");

  const output = lastMessage(store.getState().messages)?.content ?? "";
  assert.match(output, /Config files:/);
  assert.match(output, /No MCP config files exist yet/);
  assert.match(output, /C:\\workspace\\\.alyce\\mcp\.json/);
}

async function testMcpPromptsCommandShowsPromptSummary() {
  const runtime = createRuntimeStub({
    listMcpPrompts: async () => ({
      servers: [{
        server: "remote",
        status: "completed",
        prompts: [{
          server: "remote",
          name: "summarize",
          description: "Summarize a topic.",
          arguments: [{
            name: "topic",
            required: true
          }]
        }]
      }],
      promptCount: 1
    })
  });
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);

  await controller.submit("/mcp prompts");

  assert.match(lastMessage(store.getState().messages)?.content ?? "", /MCP prompts/);
  assert.match(lastMessage(store.getState().messages)?.content ?? "", /summarize/);
}

async function testMcpPromptCommandShowsPromptMessages() {
  const runtime = createRuntimeStub({
    getMcpPrompt: async () => ({
      status: "completed",
      server: "remote",
      name: "summarize",
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: "Summarize the release notes.",
          length: 28,
          truncated: false
        }]
      }]
    })
  });
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);

  await controller.submit("/mcp prompt remote summarize topic=notes");

  assert.match(lastMessage(store.getState().messages)?.content ?? "", /MCP prompt remote\/summarize/);
  assert.match(lastMessage(store.getState().messages)?.content ?? "", /Summarize the release notes/);
}

async function testMcpTemplatesCommandShowsTemplates() {
  const runtime = createRuntimeStub({
    listMcpResourceTemplates: async () => ({
      servers: [{
        server: "remote",
        status: "completed",
        resourceTemplates: [{
          server: "remote",
          uriTemplate: "repo://{owner}/{name}",
          name: "Repository",
          mimeType: "application/json"
        }]
      }],
      resourceTemplateCount: 1
    })
  });
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);

  await controller.submit("/mcp templates");

  assert.match(lastMessage(store.getState().messages)?.content ?? "", /MCP resource templates/);
  assert.match(lastMessage(store.getState().messages)?.content ?? "", /repo:\/\/\{owner\}\/\{name\}/);
}

async function testMcpAddCommandUpdatesRuntime() {
  let received: { name: string; scope?: string; type: string; command?: string } | null = null;
  const runtime = createRuntimeStub({
    addMcpServer: async (name, config, scope) => {
      received = {
        name,
        scope,
        type: config.type,
        command: config.type === "stdio" ? config.command : undefined
      };
      return {
        changed: true,
        scope: scope ?? "project",
        serverName: name,
        configPath: "C:\\workspace\\.alyce\\mcp.json",
        state: {
          paths: {
            project: "C:\\workspace\\.alyce\\mcp.json",
            local: "C:\\workspace\\.alyce\\mcp.local.json",
            user: "C:\\Users\\Single\\.alyce\\mcp.json"
          },
          configs: {
            project: { mcpServers: {} },
            local: { mcpServers: {} },
            user: { mcpServers: {} }
          },
          effective: { mcpServers: { [name]: config } },
          sources: { [name]: scope ?? "project" }
        }
      };
    }
  });
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);

  await controller.submit("/mcp add chrome stdio npx -y chrome-devtools-mcp@latest");

  assert.deepEqual(received, {
    name: "chrome",
    scope: "project",
    type: "stdio",
    command: "npx"
  });
  assert.match(lastMessage(store.getState().messages)?.content ?? "", /Added MCP server 'chrome'/);
}

async function testMcpDisableCommandUpdatesRuntime() {
  let received: { name: string; enabled: boolean; scope?: string } | null = null;
  const runtime = createRuntimeStub({
    setMcpServerEnabled: async (name, enabled, scope) => {
      received = { name, enabled, scope };
      return {
        changed: true,
        scope: scope ?? "project",
        serverName: name,
        configPath: "C:\\workspace\\.alyce\\mcp.json",
        state: {
          paths: {
            project: "C:\\workspace\\.alyce\\mcp.json",
            local: "C:\\workspace\\.alyce\\mcp.local.json",
            user: "C:\\Users\\Single\\.alyce\\mcp.json"
          },
          configs: {
            project: { mcpServers: {} },
            local: { mcpServers: {} },
            user: { mcpServers: {} }
          },
          effective: { mcpServers: {} },
          sources: {}
        }
      };
    }
  });
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);

  await controller.submit("/mcp disable --user chrome");

  assert.deepEqual(received, {
    name: "chrome",
    enabled: false,
    scope: "user"
  });
  assert.match(lastMessage(store.getState().messages)?.content ?? "", /Disabled MCP server 'chrome'/);
}

async function testMcpCommandFailureShowsErrorMessage() {
  const runtime = createRuntimeStub({
    setMcpServerEnabled: async () => {
      throw new Error("Unknown MCP server: missing");
    }
  });
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);

  await controller.submit("/mcp enable missing");

  assert.match(lastMessage(store.getState().messages)?.content ?? "", /Command failed: Unknown MCP server: missing/);
  assert.equal(store.getState().statusText, "Error");
}

async function testMcpLoginCommandShowsResult() {
  let seenAuthorizationUrl = "";
  const runtime = createRuntimeStub({
    loginMcpServer: async (_serverName, options) => {
      options?.onAuthorizationUrl?.({
        server: "remote",
        authorizationUrl: "https://example.com/auth",
        redirectUrl: "http://127.0.0.1:4000/callback"
      });
      seenAuthorizationUrl = "https://example.com/auth";
      return {
        status: "completed",
        server: "remote",
        message: "Logged in."
      };
    }
  });
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);

  await controller.submit("/mcp login remote");

  const combined = store.getState().messages.map((message) => message.content).join("\n");
  assert.equal(seenAuthorizationUrl, "https://example.com/auth");
  assert.match(combined, /https:\/\/example\.com\/auth/);
  assert.match(combined, /Logged in/);
}

async function testConnectDialogSubmissionAppliesProviderConnection() {
  let connectionState = createInitialState().connectionState;
  let appliedProviderId = "";
  const runtime = createRuntimeStub({
    getConnectionConfigState: () => connectionState,
    applyProviderConnection: async (plan) => {
      appliedProviderId = plan.providerId;
      connectionState = {
        ...connectionState,
        effective: {
          ...connectionState.effective,
          model: plan.model
        },
        providerProfiles: {
          ...connectionState.providerProfiles,
          [plan.providerId]: {
            ...connectionState.providerProfiles[plan.providerId]!,
            ...(plan.apiKey ? { apiKey: plan.apiKey } : {})
          }
        }
      };
    },
    getAuthStorePath: () => "C:\\Users\\Single\\.alyce\\auth.json"
  });
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);
  await controller.submit("/connect");

  const result = await controller.connectProviderFromDialog("openrouter", ["router-key"]);

  assert.equal(result.ok, true);
  assert.equal(appliedProviderId, "openrouter");
  assert.equal(store.getState().dialogQueue.length, 0);
  assert.match(lastMessage(store.getState().messages)?.content ?? "", /Connected OpenRouter/);
  assert.doesNotMatch(lastMessage(store.getState().messages)?.content ?? "", /router-key/);
}

async function testConnectDialogOAuthFlowAppliesProviderAuth() {
  let completed = false;
  const runtime = createRuntimeStub({
    authorizeProviderAuth: async () => ({
      type: "flow",
      flow: {
        method: "auto",
        url: "https://github.com/login/device",
        instructions: "Enter code: ABCD-1234",
        callback: async () => ({
          type: "oauth",
          accessToken: "secret-token"
        })
      }
    }),
    completeProviderAuth: async (providerId) => {
      completed = true;
      return {
        providerId,
        model: `${providerId}/gpt-5.2`
      };
    }
  });
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);
  await controller.submit("/connect");

  const started = await controller.authorizeProviderAuthFromDialog("github-copilot", 0, {
    deploymentType: "github.com"
  });
  const finished = await controller.completeProviderAuthFromDialog("github-copilot", 0);

  assert.equal(started.ok, true);
  assert.equal(started.ok ? started.type : "", "flow");
  assert.equal(finished.ok, true);
  assert.equal(completed, true);
  assert.equal(store.getState().dialogQueue.length, 0);
  assert.match(lastMessage(store.getState().messages)?.content ?? "", /Connected github-copilot/);
  assert.doesNotMatch(lastMessage(store.getState().messages)?.content ?? "", /secret-token/);
}

function testConnectDialogCancelClearsPendingProviderAuth() {
  let clearedProvider = "";
  const runtime = createRuntimeStub({
    clearProviderAuthFlow: (providerId) => {
      clearedProvider = providerId ?? "";
    }
  });
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);

  controller.cancelProviderAuthFromDialog("github-copilot", 0);

  assert.equal(clearedProvider, "github-copilot");
}

async function testModelDialogSelectionSwitchesModel() {
  let connectionState = {
    ...createInitialState().connectionState,
    effective: {
      apiKey: "key",
      baseURL: "https://api.githubcopilot.com",
      model: "github-copilot/gpt-5.2"
    },
    providerProfiles: {
      "github-copilot": {
        id: "github-copilot",
        label: "GitHub Copilot",
        kind: "openai-compatible" as const,
        apiKey: "copilot-token",
        baseURL: "https://api.githubcopilot.com",
        defaultModel: "gpt-5.2",
        models: {
          "gpt-5.2": {},
          "claude-sonnet-4.5": {}
        }
      }
    }
  };
  let selectedModel = "";
  const runtime = createRuntimeStub({
    getConnectionConfigState: () => connectionState,
    getCurrentModel: () => connectionState.effective.model,
    setCurrentModel: async (model) => {
      selectedModel = model;
      connectionState = {
        ...connectionState,
        effective: {
          ...connectionState.effective,
          model
        }
      };
    }
  });
  const store = createTerminalUiStore({
    ...createInitialState(),
    connectionState,
    connection: connectionState.effective
  });
  const controller = createSessionController(runtime, store);
  await controller.submit("/model");

  const result = await controller.switchModelFromDialog("github-copilot/claude-sonnet-4.5");

  assert.equal(result.ok, true);
  assert.equal(selectedModel, "github-copilot/claude-sonnet-4.5");
  assert.equal(store.getState().dialogQueue.length, 0);
  assert.match(lastMessage(store.getState().messages)?.content ?? "", /Switched model to: github-copilot\/claude-sonnet-4\.5/);
}

async function testProcessCommandsRouteThroughController() {
  const runningProcess = createBackgroundProcessRecord({ status: "running" });
  const startingProcess = createBackgroundProcessRecord({ id: "bg_starting", status: "starting" });
  const exitedProcess = createBackgroundProcessRecord({ id: "bg_exited", status: "exited" });
  const failedProcess = createBackgroundProcessRecord({ id: "bg_failed", status: "failed" });
  const stoppedProcess = createBackgroundProcessRecord({ status: "stopped" });
  let processes: BackgroundProcessRecord[] = [
    runningProcess,
    startingProcess,
    exitedProcess,
    failedProcess,
    stoppedProcess
  ];
  let stoppedProcessId = "";
  const runtime = createRuntimeStub({
    listBackgroundProcesses: () => processes,
    stopBackgroundProcess: async (processId) => {
      stoppedProcessId = processId;
      processes = [];
      return {
        processId,
        status: "stopped",
        message: `Background process ${processId} stopped.`,
        record: stoppedProcess
      };
    }
  });
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);

  await controller.submit("/processes");
  assert.equal(store.getState().backgroundProcessCount, 1);
  assert.match(lastMessage(store.getState().messages)?.content ?? "", /Background Processes/);
  assert.match(lastMessage(store.getState().messages)?.content ?? "", /bg_test/);

  await controller.submit("/stop bg_test");
  assert.equal(stoppedProcessId, "bg_test");
  assert.equal(store.getState().backgroundProcessCount, 0);
  assert.match(lastMessage(store.getState().messages)?.content ?? "", /Status: stopped/);
}

async function testWaitForUiPaintYieldsToMacrotask() {
  let settled = false;
  const paintPromise = __SESSION_CONTROLLER_TESTING__.waitForUiPaint().then(() => {
    settled = true;
  });

  assert.equal(settled, false);
  await Promise.resolve();
  assert.equal(settled, false);

  await paintPromise;
  assert.equal(settled, true);
}

function testInitializeShowsRuntimeBootstrapSummary() {
  const runtime = createRuntimeStub({
    config: createRuntimeConfigStub({
      bootstrap: {
        createdPaths: [
          "C:\\Users\\Single\\.alyce\\workspace-state\\workspace",
          "C:\\Users\\Single\\.alyce\\workspace-state\\workspace\\sessions"
        ],
        existingPaths: [],
        failedPaths: [],
        firstRun: true
      }
    })
  });
  const store = createTerminalUiStore(createInitialState());
  const controller = createSessionController(runtime, store);

  controller.initialize();

  const message = store.getState().messages.find((entry) =>
    entry.kind === "system" && entry.title === "Runtime"
  );
  assert.ok(message);
  assert.match(message.content, /^Runtime storage ready: 2 path\(s\) initialized; /);
  assert.match(message.content, /state: C:\\Users\\Single\\\.alyce\\workspace-state\\workspace/);
  assert.match(message.content, /user skills: C:\\Users\\Single\\\.alyce\\skills/);
  assert.match(message.content, /project assets load after \/trust/);
  assert.equal(message.content.includes("\n"), false);
}

function createRuntimeStub(overrides: Partial<{
  config: SessionRuntime["config"];
  hasConnectionConfig: SessionRuntime["hasConnectionConfig"];
  getSettingsState: SessionRuntime["getSettingsState"];
  setPlanModeEnabled: SessionRuntime["setPlanModeEnabled"];
  updateConnectionConfig: SessionRuntime["updateConnectionConfig"];
  updateSettings: SessionRuntime["updateSettings"];
  getCurrentModel: SessionRuntime["getCurrentModel"];
  getResolvedModelProfile: SessionRuntime["getResolvedModelProfile"];
  getConnectionConfigState: SessionRuntime["getConnectionConfigState"];
  refreshCurrentProviderModels: SessionRuntime["refreshCurrentProviderModels"];
  setCurrentModel: SessionRuntime["setCurrentModel"];
  applyProviderConnection: SessionRuntime["applyProviderConnection"];
  listSkills: SessionRuntime["listSkills"];
  setSkillEnabled: SessionRuntime["setSkillEnabled"];
  setBundledSkillsEnabled: SessionRuntime["setBundledSkillsEnabled"];
  refreshSkills: SessionRuntime["refreshSkills"];
  getMcpStatus: SessionRuntime["getMcpStatus"];
  listMcpTools: SessionRuntime["listMcpTools"];
  listMcpResources: SessionRuntime["listMcpResources"];
  listMcpPrompts: SessionRuntime["listMcpPrompts"];
  getMcpPrompt: SessionRuntime["getMcpPrompt"];
  listMcpResourceTemplates: SessionRuntime["listMcpResourceTemplates"];
  addMcpServer: SessionRuntime["addMcpServer"];
  removeMcpServer: SessionRuntime["removeMcpServer"];
  setMcpServerEnabled: SessionRuntime["setMcpServerEnabled"];
  loginMcpServer: SessionRuntime["loginMcpServer"];
  setMcpInteractionHandlers: SessionRuntime["setMcpInteractionHandlers"];
  authorizeProviderAuth: SessionRuntime["authorizeProviderAuth"];
  completeProviderAuth: SessionRuntime["completeProviderAuth"];
  clearProviderAuthFlow: SessionRuntime["clearProviderAuthFlow"];
  getAuthStorePath: SessionRuntime["getAuthStorePath"];
  listBackgroundProcesses: SessionRuntime["listBackgroundProcesses"];
  stopBackgroundProcess: SessionRuntime["stopBackgroundProcess"];
}>): SessionRuntime {
  const settingsState = createSettingsState();
  const settings = settingsState.effective;
  const connectionState = createInitialState().connectionState;
  const config = overrides.config ?? createRuntimeConfigStub();
  return {
    config,
    workspaceRoot: config.paths.workspaceRoot,
    messages: [],
    requestPatches: config.requestPatches,
    getSettings: () => settings,
    getSettingsState: overrides.getSettingsState ?? (() => settingsState),
    getPlanModeState: () => ({ enabled: false }),
    setPlanModeEnabled: overrides.setPlanModeEnabled ?? (async (enabled) => ({ enabled })),
    hasConnectionConfig:
      overrides.hasConnectionConfig ??
      (() => connectionState.effective.apiKey.trim().length > 0),
    getConnectionConfig: () => connectionState.effective,
    getCurrentModel: overrides.getCurrentModel ?? (() => connectionState.effective.model),
    getResolvedModelProfile: overrides.getResolvedModelProfile ?? (() => ({
      providerId: "openai",
      modelId: "gpt-5.2",
      modelRef: { providerId: "openai", modelId: "gpt-5.2" },
      label: "gpt-5.2",
      provider: {
        id: "openai",
        label: "OpenAI",
        kind: "openai",
        apiKey: "key",
        baseURL: "https://api.openai.com/v1"
      },
      kind: "openai",
      apiKey: "key",
      baseURL: "https://api.openai.com/v1",
      contextWindow: 400_000,
      contextWindowSource: "fallback",
      contextWindowLabel: "fallback"
    })),
    getConnectionConfigState: overrides.getConnectionConfigState ?? (() => connectionState),
    refreshCurrentProviderModels: overrides.refreshCurrentProviderModels ?? (async () => ({
      providerId: "openai",
      providerLabel: "OpenAI",
      models: {},
      source: "fallback"
    })),
    setCurrentModel: overrides.setCurrentModel ?? (async () => undefined),
    getProviderAuthRecords: () => ({}),
    updateConnectionConfig: overrides.updateConnectionConfig ?? (async () => undefined),
    updateSettings: overrides.updateSettings ?? (async () => undefined),
    applyProviderConnection: overrides.applyProviderConnection ?? (async () => undefined),
    listSkills: overrides.listSkills ?? (async () => ({
      skills: [],
      disabledSkills: [],
      duplicateWarnings: [],
      disabledWarnings: [],
      configWarnings: []
    })),
    getSkill: async () => undefined,
    setSkillEnabled: overrides.setSkillEnabled ?? (async () => ({
      changed: true,
      target: "project",
      configPath: "C:\\workspace\\.alyce\\skills.json",
      catalog: {
        skills: [],
        disabledSkills: [],
        duplicateWarnings: [],
        disabledWarnings: [],
        configWarnings: []
      },
      message: "Updated skill config."
    })),
    setBundledSkillsEnabled: overrides.setBundledSkillsEnabled ?? (async () => ({
      changed: true,
      target: "project",
      configPath: "C:\\workspace\\.alyce\\skills.json",
      catalog: {
        skills: [],
        disabledSkills: [],
        duplicateWarnings: [],
        disabledWarnings: [],
        configWarnings: []
      },
      message: "Updated bundled skill config."
    })),
    refreshSkills: overrides.refreshSkills ?? (async () => ({
      skills: [],
      disabledSkills: [],
      duplicateWarnings: [],
      disabledWarnings: [],
      configWarnings: []
    })),
    getMcpStatus: overrides.getMcpStatus ?? (async () => ({ servers: [] })),
    listMcpTools: overrides.listMcpTools ?? (async () => ({ servers: [], toolCount: 0 })),
    listMcpResources: overrides.listMcpResources ?? (async () => ({ servers: [], resourceCount: 0 })),
    listMcpPrompts: overrides.listMcpPrompts ?? (async () => ({ servers: [], promptCount: 0 })),
    getMcpPrompt: overrides.getMcpPrompt ?? (async (serverName, promptName) => ({
      status: "not_found",
      server: serverName,
      name: promptName,
      messages: [],
      error: "not found"
    })),
    listMcpResourceTemplates: overrides.listMcpResourceTemplates ?? (async () => ({
      servers: [],
      resourceTemplateCount: 0
    })),
    addMcpServer: overrides.addMcpServer ?? (async (name, config, scope = "project") => ({
      changed: true,
      scope,
      serverName: name,
      configPath: "C:\\workspace\\.alyce\\mcp.json",
      state: {
        paths: {
          project: "C:\\workspace\\.alyce\\mcp.json",
          local: "C:\\workspace\\.alyce\\mcp.local.json",
          user: "C:\\Users\\Single\\.alyce\\mcp.json"
        },
        configs: {
          project: { mcpServers: {} },
          local: { mcpServers: {} },
          user: { mcpServers: {} }
        },
        effective: { mcpServers: { [name]: config } },
        sources: { [name]: scope }
      }
    })),
    removeMcpServer: overrides.removeMcpServer ?? (async (name, scope = "project") => ({
      changed: true,
      scope,
      serverName: name,
      configPath: "C:\\workspace\\.alyce\\mcp.json",
      state: {
        paths: {
          project: "C:\\workspace\\.alyce\\mcp.json",
          local: "C:\\workspace\\.alyce\\mcp.local.json",
          user: "C:\\Users\\Single\\.alyce\\mcp.json"
        },
        configs: {
          project: { mcpServers: {} },
          local: { mcpServers: {} },
          user: { mcpServers: {} }
        },
        effective: { mcpServers: {} },
        sources: {}
      }
    })),
    setMcpServerEnabled: overrides.setMcpServerEnabled ?? (async (name, _enabled, scope = "project") => ({
      changed: true,
      scope,
      serverName: name,
      configPath: "C:\\workspace\\.alyce\\mcp.json",
      state: {
        paths: {
          project: "C:\\workspace\\.alyce\\mcp.json",
          local: "C:\\workspace\\.alyce\\mcp.local.json",
          user: "C:\\Users\\Single\\.alyce\\mcp.json"
        },
        configs: {
          project: { mcpServers: {} },
          local: { mcpServers: {} },
          user: { mcpServers: {} }
        },
        effective: { mcpServers: {} },
        sources: {}
      }
    })),
    loginMcpServer: overrides.loginMcpServer ?? (async (serverName) => ({
      status: "completed",
      server: serverName,
      message: "Logged in."
    })),
    setMcpInteractionHandlers: overrides.setMcpInteractionHandlers ?? (() => undefined),
    preparePromptSkillContext: async () => ({
      generatedMessages: [],
      loadedSkillNames: [],
      unresolvedMentions: [],
      disabledMentions: [],
      duplicateWarnings: [],
      dependencyWarnings: []
    }),
    authorizeProviderAuth: overrides.authorizeProviderAuth ?? (async (providerId) => ({
      type: "stored",
      providerId,
      model: `${providerId}/model`
    })),
    completeProviderAuth: overrides.completeProviderAuth ?? (async (providerId) => ({
      providerId,
      model: `${providerId}/model`
    })),
    clearProviderAuthFlow: overrides.clearProviderAuthFlow ?? (() => undefined),
    getAuthStorePath: overrides.getAuthStorePath ?? (() => "C:\\Users\\Single\\.alyce\\auth.json"),
    listSubagentTasks: () => [],
    listBackgroundProcesses: overrides.listBackgroundProcesses ?? (() => []),
    stopBackgroundProcess: overrides.stopBackgroundProcess ?? (async () => ({
      processId: "bg_test",
      status: "not_found",
      message: "Background process not found."
    })),
    stopAllBackgroundProcesses: async () => [],
    listPtySessions: () => [],
    closeAllPtySessions: () => [],
    flushSessionHistory: async () => undefined
  } as unknown as SessionRuntime;
}

function createBackgroundProcessRecord(
  overrides: Partial<BackgroundProcessRecord> = {}
): BackgroundProcessRecord {
  return {
    id: "bg_test",
    command: "npm run dev",
    cwd: "C:\\workspace",
    pid: 12345,
    status: "running",
    startedAt: "2026-05-10T00:00:00.000Z",
    updatedAt: "2026-05-10T00:00:01.000Z",
    stdoutLogPath: "C:\\workspace\\.alyce\\background-processes\\bg_test\\stdout.log",
    stderrLogPath: "C:\\workspace\\.alyce\\background-processes\\bg_test\\stderr.log",
    combinedLogPath: "C:\\workspace\\.alyce\\background-processes\\bg_test\\output.log",
    recordPath: "C:\\workspace\\.alyce\\background-processes\\bg_test\\process.json",
    stdoutPreview: "Local: http://localhost:5173/",
    stderrPreview: "",
    detectedUrls: ["http://localhost:5173/"],
    detectedPorts: [5173],
    warnings: [],
    ...overrides
  };
}

function createRuntimeConfigStub(
  overrides: Partial<SessionRuntime["config"]> = {}
): SessionRuntime["config"] {
  const settingsState = createSettingsState();
  const connectionState = createInitialState().connectionState;

  return {
    paths: {
      workspaceRoot: "C:\\workspace",
      projectAlyceDirectory: "C:\\workspace\\.alyce",
      alyceDirectory: "C:\\Users\\Single\\.alyce\\workspace-state\\workspace",
      connectionConfigPath: "C:\\workspace\\.alyce\\config.json",
      settingsConfigPath: "C:\\workspace\\.alyce\\settings.json",
      projectSkillsDirectory: "C:\\workspace\\.alyce\\skills",
      projectAgentsDirectory: "C:\\workspace\\.alyce\\agents",
      projectPluginsDirectory: "C:\\workspace\\.alyce\\plugins",
      userAlyceDirectory: "C:\\Users\\Single\\.alyce",
      userConnectionConfigPath: "C:\\Users\\Single\\.alyce\\config.json",
      userSettingsConfigPath: "C:\\Users\\Single\\.alyce\\settings.json",
      userSkillsDirectory: "C:\\Users\\Single\\.alyce\\skills",
      userPluginsDirectory: "C:\\Users\\Single\\.alyce\\plugins",
      workspaceRuntimeDirectory: "C:\\Users\\Single\\.alyce\\workspace-state\\workspace",
      memoryDirectory: "C:\\Users\\Single\\.alyce\\workspace-state\\workspace\\memory",
      sessionsDirectory: "C:\\Users\\Single\\.alyce\\workspace-state\\workspace\\sessions",
      backgroundProcessesDirectory: "C:\\Users\\Single\\.alyce\\workspace-state\\workspace\\background-processes",
      mcpOutputDirectory: "C:\\Users\\Single\\.alyce\\workspace-state\\workspace\\mcp-output",
      snapshotsDirectory: "C:\\Users\\Single\\.alyce\\workspace-state\\workspace\\snapshots",
      gitSnapshotsDirectory: "C:\\Users\\Single\\.alyce\\workspace-state\\workspace\\snapshots\\git",
      fileHistoryDirectory: "C:\\Users\\Single\\.alyce\\workspace-state\\workspace\\file-history",
      tasksDirectory: "C:\\Users\\Single\\.alyce\\workspace-state\\workspace\\tasks",
      usageLogPath: "C:\\Users\\Single\\.alyce\\workspace-state\\workspace\\usage.jsonl",
      projectTrustStorePath: "C:\\Users\\Single\\.alyce\\trusted-projects.json"
    },
    bootstrap: {
      createdPaths: [],
      existingPaths: [],
      failedPaths: [],
      firstRun: false
    },
    projectTrust: {
      workspaceRoot: "C:\\workspace",
      projectKey: "workspace",
      trusted: false,
      storePath: "C:\\Users\\Single\\.alyce\\trusted-projects.json"
    },
    connection: connectionState.effective,
    connectionState,
    settings: settingsState.effective,
    settingsState,
    providerConnectors: [],
    providerPluginProfiles: {},
    providerPluginDiagnostics: [],
    requestPatches: [],
    memory: {
      directory: "C:\\workspace\\.alyce\\memory",
      fileName: "MEMORY.md",
      sessionMemoryFileName: "SESSION_MEMORY.md",
      maxSessionEntries: 30,
      maxPersistentEntries: 200,
      maxPromptEntries: 20,
      sessionMemory: {
        enabled: true,
        initialTokens: 10_000,
        updateTokens: 5_000,
        toolCallsBetweenUpdates: 3,
        timeoutMs: 180_000,
        maxFailures: 3,
        staleMs: 60_000,
        maxMessagesForExtraction: 80,
        maxCharsPerMessage: 1_500
      }
    },
    ...overrides
  };
}

function createInitialState() {
  const settingsState = createSettingsState();
  return createInitialTerminalUiState({
    connectionState: {
      effective: { apiKey: "key", baseURL: "https://example.com", model: "gpt-5.2" },
      user: {},
      project: {},
      env: {},
      cli: {},
      sources: {
        apiKey: "default",
        baseURL: "default",
        model: "default"
      },
      providerProfiles: {},
      saveTarget: "user",
      saveTargetPath: "C:\\tmp\\config.json",
      userPath: "C:\\tmp\\user-config.json",
      projectPath: "C:\\tmp\\project-config.json"
    },
    settingsState,
    workspaceRoot: "C:\\workspace",
    requestPatchCount: 0
  });
}

function createSettingsState(): SessionSettingsState {
  return {
    effective: {
      approvalMode: "default",
      maxSteps: 50,
      commandTimeoutMs: 120_000,
      scrollSpeed: 2,
      scrollAccelerationEnabled: false,
      historyPagingEnabled: false,
      maxMessagesWithoutVirtualization: 200,
      sessionMemoryEnabled: true,
      messageTimestampsEnabled: false,
      markdownMessageRenderingEnabled: true,
      markdownToolMessageRenderingEnabled: true,
      markdownRenderMaxChars: 32_000,
      thinkingMessagesExpandedByDefault: false,
      diagnosticsPendingTimeoutMs: 120_000,
      diagnosticsFailureThreshold: 3,
      diagnosticsFailureCooldownMs: 300_000,
      snapshot: {
        enabled: true,
        engine: "hybrid",
        maxTextDiffBytes: 524_288,
        maxFileBytes: 2_097_152,
        retentionDays: 7,
        includeIgnoredExplicitPaths: true,
        manifestScan: true
      },
      conversationCompactionEnabled: true,
      autoCompactTimeoutMs: 180_000,
      autoCompactMaxFailures: 3,
      modelContextWindowOverrides: {},
      additionalDirectories: [],
      permissionRules: []
    },
    project: {},
    user: {},
    env: {},
    cli: {},
    sources: {
      approvalMode: "default",
      maxSteps: "default",
      commandTimeoutMs: "default",
      scrollSpeed: "default",
      scrollAccelerationEnabled: "default",
      historyPagingEnabled: "default",
      maxMessagesWithoutVirtualization: "default",
      sessionMemoryEnabled: "default",
      messageTimestampsEnabled: "default",
      markdownMessageRenderingEnabled: "default",
      markdownToolMessageRenderingEnabled: "default",
      markdownRenderMaxChars: "default",
      thinkingMessagesExpandedByDefault: "default",
      diagnosticsPendingTimeoutMs: "default",
      diagnosticsFailureThreshold: "default",
      diagnosticsFailureCooldownMs: "default",
      snapshot: "default",
      conversationCompactionEnabled: "default",
      autoCompactTimeoutMs: "default",
      autoCompactMaxFailures: "default",
      modelContextWindowOverrides: "default",
      languagePreference: "default",
      personaPreset: "default",
      aiPersonalityPrompt: "default",
      appendSystemPrompt: "default",
      additionalDirectories: "default",
      permissionRules: "default"
    },
    saveTargetPath: "C:\\tmp\\settings.json",
    projectPath: "C:\\tmp\\project-settings.json"
  };
}

function lastMessage(messages: readonly TerminalUiMessage[]): TerminalUiMessage | undefined {
  return messages.at(-1);
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
