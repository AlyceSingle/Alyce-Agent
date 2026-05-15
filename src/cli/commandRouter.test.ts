import assert from "node:assert/strict";
import {
  getReplCommandHelpLines,
  parseReplCommand,
  REPL_COMMAND_DEFINITIONS
} from "./commandRouter.js";

function runTests() {
  testHelpUsesSharedCommandDefinitions();
  testCommandMetadataCompletionsAreUnique();
  testParserHandlesRepresentedCommands();
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

function testParserHandlesRepresentedCommands() {
  assert.deepEqual(parseReplCommand("/help"), { type: "help" });
  assert.deepEqual(parseReplCommand("/doctor"), { type: "doctor" });
  assert.deepEqual(parseReplCommand("/plan"), { type: "plan-enter" });
  assert.deepEqual(parseReplCommand("/plan exit"), { type: "plan-exit" });
  assert.deepEqual(parseReplCommand("/build"), { type: "plan-exit" });
  assert.deepEqual(parseReplCommand("/settings"), { type: "open-settings", section: "session" });
  assert.deepEqual(parseReplCommand("/setup"), { type: "open-settings", section: "connection" });
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
    type: "tasks-get",
    taskId: "task-1"
  });
  assert.deepEqual(parseReplCommand("/tasks stop task-1"), {
    type: "tasks-stop",
    taskId: "task-1"
  });
  assert.deepEqual(parseReplCommand("/tasks cleanup --apply"), {
    type: "tasks-cleanup",
    apply: true
  });
  assert.deepEqual(parseReplCommand("/usage"), { type: "usage-view" });
  assert.deepEqual(parseReplCommand("/usage now"), {
    type: "command-error",
    input: "/usage now",
    message: "Unsupported /usage argument. Use /usage."
  });
  assert.deepEqual(parseReplCommand("/tasks resume task-1"), {
    type: "command-error",
    input: "/tasks resume task-1",
    message: "/tasks resume is not supported yet. Use AgentTool with an existing task_id when a resumable task model is available."
  });
  assert.deepEqual(parseReplCommand("/revert"), {
    type: "revert",
    mode: "prompt"
  });
  assert.deepEqual(parseReplCommand("/revert --files-only"), {
    type: "revert",
    mode: "files-only"
  });
  assert.deepEqual(parseReplCommand("/revert --conversation-only"), {
    type: "revert",
    mode: "conversation-only"
  });
  assert.deepEqual(parseReplCommand("/revert last"), {
    type: "command-error",
    input: "/revert last",
    message: "Unsupported /revert argument. Use /revert, /revert --files-only, or /revert --conversation-only."
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
  assert.deepEqual(parseReplCommand("/model"), { type: "model-view" });
  assert.deepEqual(parseReplCommand("/model list"), { type: "model-view" });
  assert.deepEqual(parseReplCommand("/models"), { type: "model-view" });
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
