import assert from "node:assert/strict";
import {
  getSlashCommandSuggestions,
  getVisibleSlashCommandSuggestions,
  isSlashCommandInput,
  shouldCompleteSlashCommandInput,
  shouldToggleModeFromPromptKey
} from "./PromptInput.js";

function runTests() {
  testSlashInputDetection();
  testSlashSuggestionsFilterByPrefix();
  testSlashSuggestionsKeepAllMatches();
  testVisibleSlashSuggestionsAreCappedAndScrollable();
  testSlashCompletionRules();
  testModeToggleKeyRules();
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
    ["/memory clear", "/memory clear --all"]
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
  assert.equal(model?.completion, "/model ");
  assert.equal(model ? shouldCompleteSlashCommandInput("/model", model) : false, true);
  assert.equal(model ? shouldCompleteSlashCommandInput("/model ", model) : true, false);

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

runTests();
