import assert from "node:assert/strict";
import {
  getReplCommandHelpLines,
  parseReplCommand,
  REPL_COMMAND_DEFINITIONS
} from "./commandRouter.js";

function runTests() {
  testHelpUsesSharedCommandDefinitions();
  testCommandMetadataCompletionsAreUnique();
  testArgumentCommandsUseBareCompletions();
  testParserHandlesRepresentedCommands();
  testDeprecatedCommandsAreHiddenFromHelp();
  testAdjacentCommandPrefixesRemainUnknown();
  testPlanBuildScopeDoesNotExposeDeferredModes();
  console.log("commandRouter tests passed");
}

function testHelpUsesSharedCommandDefinitions() {
  const help = getReplCommandHelpLines("test-model").join("\n");

  for (const command of REPL_COMMAND_DEFINITIONS) {
    assert.ok(
      help.includes(command.usage),
      `Expected /help output to include ${command.usage}`
    );
  }

  assert.ok(help.includes("current: test-model"));
}

function testCommandMetadataCompletionsAreUnique() {
  const completions = REPL_COMMAND_DEFINITIONS.map((command) => command.completion);
  assert.equal(new Set(completions).size, completions.length);
}

function testArgumentCommandsUseBareCompletions() {
  const connect = REPL_COMMAND_DEFINITIONS.find((command) => command.command === "/connect");
  const logout = REPL_COMMAND_DEFINITIONS.find((command) => command.command === "/logout");
  const remember = REPL_COMMAND_DEFINITIONS.find((command) => command.command === "/remember");

  assert.equal(connect?.completion, "/connect");
  assert.equal(logout?.completion, "/logout");
  assert.equal(remember?.completion, "/remember");
}

function testParserHandlesRepresentedCommands() {
  assert.deepEqual(parseReplCommand("/help"), { type: "help" });
  assert.deepEqual(parseReplCommand("/doctor"), { type: "doctor" });
  assert.deepEqual(parseReplCommand("/plan"), { type: "plan-enter" });
  assert.deepEqual(parseReplCommand("/plan exit"), { type: "plan-exit" });
  assert.deepEqual(parseReplCommand("/build"), { type: "plan-exit" });
  assert.deepEqual(parseReplCommand("/settings"), { type: "open-settings", section: "session" });
  assert.deepEqual(parseReplCommand("/settings session"), { type: "open-settings", section: "session" });
  assert.deepEqual(parseReplCommand("/settings connection"), { type: "open-settings", section: "connection" });
  assert.deepEqual(parseReplCommand("/settings advanced"), {
    type: "command-error",
    input: "/settings advanced",
    message: "Unsupported /settings argument. Use /settings, /settings session, or /settings connection."
  });
  assert.deepEqual(parseReplCommand("/permissions"), { type: "open-permissions" });
  assert.deepEqual(parseReplCommand("/permissions default"), {
    type: "command-error",
    input: "/permissions default",
    message: "Unsupported /permissions argument. Use /permissions."
  });
  assert.deepEqual(parseReplCommand("/trust"), {
    type: "project-trust-set",
    trusted: true
  });
  assert.deepEqual(parseReplCommand("/trust status"), { type: "trust-status" });
  assert.deepEqual(parseReplCommand("/untrust"), {
    type: "project-trust-set",
    trusted: false
  });
  assert.deepEqual(parseReplCommand("/setup"), {
    type: "command-error",
    input: "/setup",
    message: "This command was removed. Use /connect to manage provider connections."
  });
  assert.deepEqual(parseReplCommand("/connect"), {
    type: "connect-provider",
    args: []
  });
  assert.deepEqual(parseReplCommand("/connect openrouter sk-test openai/gpt-5.2"), {
    type: "connect-provider",
    provider: "openrouter",
    args: ["sk-test", "openai/gpt-5.2"]
  });
  assert.deepEqual(parseReplCommand("/logout openrouter"), {
    type: "logout-provider",
    provider: "openrouter"
  });
  assert.deepEqual(parseReplCommand("/logout"), {
    type: "command-error",
    input: "/logout",
    message: "Missing provider. Use /logout <provider>."
  });
  assert.deepEqual(parseReplCommand("/memory clear --all"), {
    type: "memory-clear",
    clearPersistent: true
  });
  assert.deepEqual(parseReplCommand("/tasks"), {
    type: "tasks-list"
  });
  assert.deepEqual(parseReplCommand("/tasks get task-1"), {
    type: "tasks-get",
    taskId: "task-1"
  });
  assert.deepEqual(parseReplCommand("/tasks log task-1"), {
    type: "command-error",
    input: "/tasks log task-1",
    message: "This command was removed. Use /tasks get task-1."
  });
  assert.deepEqual(parseReplCommand("/tasks stop task-1"), {
    type: "tasks-stop",
    taskId: "task-1"
  });
  assert.deepEqual(parseReplCommand("/tasks cleanup --apply"), {
    type: "tasks-cleanup",
    apply: true
  });
  assert.deepEqual(parseReplCommand("/processes"), {
    type: "processes-list"
  });
  assert.deepEqual(parseReplCommand("/bg"), {
    type: "command-error",
    input: "/bg",
    message: "This command was removed. Use /processes."
  });
  assert.deepEqual(parseReplCommand("/stop bg_test"), {
    type: "process-stop",
    processId: "bg_test"
  });
  assert.deepEqual(parseReplCommand("/stop"), {
    type: "command-error",
    input: "/stop",
    message: "Missing process id. Use /stop <id>."
  });
  assert.deepEqual(parseReplCommand("/processes all"), {
    type: "command-error",
    input: "/processes all",
    message: "Unsupported background process list argument. Use /processes."
  });
  assert.deepEqual(parseReplCommand("/usage"), { type: "usage-view" });
  assert.deepEqual(parseReplCommand("/usage now"), {
    type: "command-error",
    input: "/usage now",
    message: "Unsupported /usage argument. Use /usage."
  });
  assert.deepEqual(parseReplCommand("/skills"), { type: "skills-list" });
  assert.deepEqual(parseReplCommand("/skills list"), {
    type: "command-error",
    input: "/skills list",
    message: "This command was removed. Use /skills."
  });
  assert.deepEqual(parseReplCommand("/skills review"), {
    type: "skills-view",
    name: "review"
  });
  assert.deepEqual(parseReplCommand("/skills show review"), {
    type: "command-error",
    input: "/skills show review",
    message: "This command was removed. Use /skills review."
  });
  assert.deepEqual(parseReplCommand("/skills show"), {
    type: "command-error",
    input: "/skills show",
    message: "This command was removed. Use /skills <name>."
  });
  assert.deepEqual(parseReplCommand("/skills refresh"), { type: "skills-refresh" });
  assert.deepEqual(parseReplCommand("/skills disable review"), {
    type: "skills-set-enabled",
    enabled: false,
    target: "project",
    reference: { kind: "name", value: "review" }
  });
  assert.deepEqual(parseReplCommand("/skills enable --user --bundled"), {
    type: "skills-set-enabled",
    enabled: true,
    target: "user",
    reference: { kind: "bundled" }
  });
  assert.deepEqual(parseReplCommand("/skills disable --path .alyce/skills/review/SKILL.md"), {
    type: "skills-set-enabled",
    enabled: false,
    target: "project",
    reference: { kind: "path", value: ".alyce/skills/review/SKILL.md" }
  });
  assert.deepEqual(parseReplCommand("/mcp"), { type: "mcp-list" });
  assert.deepEqual(parseReplCommand("/mcp list"), {
    type: "command-error",
    input: "/mcp list",
    message: "This command was removed. Use /mcp."
  });
  assert.deepEqual(parseReplCommand("/mcp status"), { type: "mcp-status" });
  assert.deepEqual(parseReplCommand("/mcp tools chrome"), {
    type: "mcp-tools",
    serverName: "chrome"
  });
  assert.deepEqual(parseReplCommand("/mcp resources"), {
    type: "mcp-resources"
  });
  assert.deepEqual(parseReplCommand("/mcp prompts"), {
    type: "mcp-prompts"
  });
  assert.deepEqual(parseReplCommand("/mcp templates remote"), {
    type: "mcp-templates",
    serverName: "remote"
  });
  assert.deepEqual(parseReplCommand('/mcp prompt remote summarize topic="release notes" style=short'), {
    type: "mcp-prompt",
    serverName: "remote",
    promptName: "summarize",
    args: {
      topic: "release notes",
      style: "short"
    }
  });
  assert.deepEqual(parseReplCommand("/mcp login remote"), {
    type: "mcp-login",
    serverName: "remote"
  });
  assert.deepEqual(parseReplCommand("/mcp add chrome stdio npx -y chrome-devtools-mcp@latest"), {
    type: "mcp-add",
    scope: "project",
    name: "chrome",
    config: {
      type: "stdio",
      command: "npx",
      args: ["-y", "chrome-devtools-mcp@latest"]
    }
  });
  assert.deepEqual(parseReplCommand('/mcp add --user remote http "https://example.com/mcp"'), {
    type: "mcp-add",
    scope: "user",
    name: "remote",
    config: {
      type: "streamable_http",
      url: "https://example.com/mcp"
    }
  });
  assert.deepEqual(parseReplCommand("/mcp disable --local chrome"), {
    type: "mcp-set-enabled",
    enabled: false,
    scope: "local",
    name: "chrome"
  });
  assert.deepEqual(parseReplCommand("/mcp remove chrome extra"), {
    type: "command-error",
    input: "/mcp remove chrome extra",
    message: "Unsupported /mcp remove argument. Use /mcp remove [--user|--project|--local] <name>."
  });
  assert.deepEqual(parseReplCommand("/mcp prompt remote summarize topic"), {
    type: "command-error",
    input: "/mcp prompt remote summarize topic",
    message: "Unsupported /mcp prompt argument. Use key=value pairs after the prompt name."
  });
  assert.deepEqual(parseReplCommand("/tasks resume task-1"), {
    type: "command-error",
    input: "/tasks resume task-1",
    message: "/tasks resume is not supported yet. Use AgentTool with an existing task_id when a resumable task model is available."
  });
  assert.deepEqual(parseReplCommand("/rewind"), {
    type: "command-error",
    input: "/rewind",
    message: "This command was removed. Use /revert to open revert history."
  });
  assert.deepEqual(parseReplCommand("/revert"), {
    type: "revert"
  });
  assert.deepEqual(parseReplCommand("/revert --files-only"), {
    type: "command-error",
    input: "/revert --files-only",
    message: "Revert flags were removed. Use /revert and choose an action from the revert history."
  });
  assert.deepEqual(parseReplCommand("/revert --conversation-only"), {
    type: "command-error",
    input: "/revert --conversation-only",
    message: "Revert flags were removed. Use /revert and choose an action from the revert history."
  });
  assert.deepEqual(parseReplCommand("/revert last"), {
    type: "command-error",
    input: "/revert last",
    message: "Revert flags were removed. Use /revert and choose an action from the revert history."
  });
  assert.deepEqual(parseReplCommand("/diff"), {
    type: "diff-view",
    target: "overview"
  });
  assert.deepEqual(parseReplCommand("/diff last"), {
    type: "diff-view",
    target: "last"
  });
  assert.deepEqual(parseReplCommand("/diff current"), {
    type: "diff-view",
    target: "current"
  });
  assert.deepEqual(parseReplCommand("/diff turn-123"), {
    type: "diff-view",
    target: { turnId: "turn-123" }
  });
  assert.deepEqual(parseReplCommand("/diff last extra"), {
    type: "command-error",
    input: "/diff last extra",
    message: "Unsupported /diff argument. Use /diff, /diff last, /diff current, or /diff <turn>."
  });
  assert.deepEqual(parseReplCommand("/model"), { type: "open-model-picker" });
  assert.deepEqual(parseReplCommand("/model list"), {
    type: "command-error",
    input: "/model list",
    message: "This command was removed. Use /model to open the model picker."
  });
  assert.deepEqual(parseReplCommand("/models"), {
    type: "command-error",
    input: "/models",
    message: "This command was removed. Use /model to open the model picker."
  });
  assert.deepEqual(parseReplCommand("/model openrouter/openai/gpt-5.2"), {
    type: "switch-model",
    model: "openrouter/openai/gpt-5.2"
  });
  assert.deepEqual(parseReplCommand("/add-dir --save C:\\tmp"), {
    type: "add-directory",
    directory: "C:\\tmp",
    persist: true
  });
  assert.deepEqual(parseReplCommand("/build now"), {
    type: "command-error",
    input: "/build now",
    message: "Unsupported /build argument. In Alyce, /build only exits Plan Mode; run build commands as normal prompts or approved shell commands."
  });
}

function testDeprecatedCommandsAreHiddenFromHelp() {
  const exposedCommands = new Set(REPL_COMMAND_DEFINITIONS.map((command) => command.command));

  for (const command of [
    "/setup",
    "/rewind",
    "/models",
    "/bg"
  ]) {
    assert.equal(exposedCommands.has(command), false);
  }
}

function testAdjacentCommandPrefixesRemainUnknown() {
  assert.deepEqual(parseReplCommand("/memoryfoo"), {
    type: "command-error",
    input: "/memoryfoo",
    message: "Unknown command. Enter /help to view available commands."
  });
}

function testPlanBuildScopeDoesNotExposeDeferredModes() {
  const deferredModeCommands = new Set(["/mode", "/explore", "/review", "/verify"]);
  const exposedCommands = new Set(REPL_COMMAND_DEFINITIONS.map((command) => command.command));

  for (const command of deferredModeCommands) {
    assert.equal(exposedCommands.has(command), false);
    assert.deepEqual(parseReplCommand(command), {
      type: "command-error",
      input: command,
      message: "Unknown command. Enter /help to view available commands."
    });
  }
}

runTests();
