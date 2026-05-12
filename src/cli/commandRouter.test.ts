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
  assert.deepEqual(parseReplCommand("/settings"), { type: "open-settings", section: "session" });
  assert.deepEqual(parseReplCommand("/setup"), { type: "open-settings", section: "connection" });
  assert.deepEqual(parseReplCommand("/memory clear --all"), {
    type: "memory-clear",
    clearPersistent: true
  });
  assert.deepEqual(parseReplCommand("/tasks cleanup --apply"), {
    type: "tasks-cleanup",
    apply: true
  });
  assert.deepEqual(parseReplCommand("/add-dir --save C:\\tmp"), {
    type: "add-directory",
    directory: "C:\\tmp",
    persist: true
  });
}

runTests();
