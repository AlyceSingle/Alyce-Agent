import assert from "node:assert/strict";
import {
  getSlashCommandSuggestions,
  getVisibleSlashCommandSuggestions,
  isSlashCommandInput,
  resolvePromptPlaceholderState,
  shouldCompleteSlashCommandInput,
  shouldToggleModeFromPromptKey
} from "./PromptInput.js";
import { terminalUiTheme } from "../theme/theme.js";

function runTests() {
  testSlashInputDetection();
  testSlashSuggestionsFilterByPrefix();
  testSlashSuggestionsKeepAllMatches();
  testVisibleSlashSuggestionsAreCappedAndScrollable();
  testSlashCompletionRules();
  testModeToggleKeyRules();
  testLockedPlaceholderUsesWarningTextInsideInput();
  console.log("PromptInput tests passed");
}

function testSlashInputDetection() {
  assert.equal(isSlashCommandInput("/"), true);
  assert.equal(isSlashCommandInput("/help"), true);
  assert.equal(isSlashCommandInput("hello /help"), false);
  assert.equal(isSlashCommandInput("/help\nnext"), false);
}

function testSlashSuggestionsFilterByPrefix() {
  assert.ok(getSlashCommandSuggestions("/").length > 0);
  assert.deepEqual(
    getSlashCommandSuggestions("/memory c").map((command) => command.command),
    ["/memory"]
  );
  assert.deepEqual(
    getSlashCommandSuggestions("/tasks cleanup").map((command) => command.command),
    ["/tasks"]
  );
  assert.deepEqual(getSlashCommandSuggestions("/model g"), []);
}

function testSlashSuggestionsKeepAllMatches() {
  assert.equal(getSlashCommandSuggestions("/").length > 10, true);
}

function testVisibleSlashSuggestionsAreCappedAndScrollable() {
  const suggestions = getSlashCommandSuggestions("/");
  const firstWindow = getVisibleSlashCommandSuggestions(suggestions, 0);
  const laterWindow = getVisibleSlashCommandSuggestions(suggestions, 12);

  assert.equal(firstWindow.suggestions.length, 10);
  assert.equal(firstWindow.startIndex, 0);
  assert.equal(laterWindow.suggestions.length, 10);
  assert.equal(laterWindow.startIndex > 0, true);
  assert.equal(
    laterWindow.suggestions.some((suggestion) => suggestion.command === suggestions[12]?.command),
    true
  );
}

function testSlashCompletionRules() {
  const model = getSlashCommandSuggestions("/model")[0];
  assert.equal(model?.completion, "/model");
  assert.equal(model ? shouldCompleteSlashCommandInput("/model", model) : true, false);

  const connect = getSlashCommandSuggestions("/connect")[0];
  assert.equal(connect?.completion, "/connect");
  assert.equal(connect ? shouldCompleteSlashCommandInput("/connect", connect) : true, false);

  const stop = getSlashCommandSuggestions("/stop")[0];
  assert.equal(stop?.completion, "/stop");
  assert.equal(stop ? shouldCompleteSlashCommandInput("/stop", stop) : true, false);

  const help = getSlashCommandSuggestions("/help")[0];
  assert.equal(help?.completion, "/help");
  assert.equal(help ? shouldCompleteSlashCommandInput("/help", help) : true, false);
}

function testModeToggleKeyRules() {
  const tabKey = {
    tab: true,
    shift: false,
    meta: false,
    ctrl: false
  };
  assert.equal(shouldToggleModeFromPromptKey("", false, tabKey), true);
  assert.equal(shouldToggleModeFromPromptKey("inspect this", false, tabKey), true);
  assert.equal(shouldToggleModeFromPromptKey("/", false, tabKey), false);
  assert.equal(shouldToggleModeFromPromptKey("/help", false, tabKey), false);
  assert.equal(shouldToggleModeFromPromptKey("", true, tabKey), false);
  assert.equal(shouldToggleModeFromPromptKey("", false, { ...tabKey, shift: true }), false);
}

function testLockedPlaceholderUsesWarningTextInsideInput() {
  const locked = resolvePromptPlaceholderState({
    disabled: true,
    disabledPlaceholder: "Input locked while Alyce is working. Press ESC to interrupt."
  });
  const normal = resolvePromptPlaceholderState({
    disabled: false,
    disabledPlaceholder: "Input locked while Alyce is working. Press ESC to interrupt."
  });

  assert.deepEqual(locked, {
    text: "Input locked while Alyce is working. Press ESC to interrupt.",
    color: terminalUiTheme.colors.warning,
    dimColor: false
  });
  assert.equal(normal.text, "Ask Alyce to inspect, edit, or explain something...");
  assert.equal(normal.color, terminalUiTheme.colors.inputPlaceholder);
  assert.equal(normal.dimColor, true);
}

runTests();
