import assert from "node:assert/strict";
import {
  getSlashCommandSuggestions,
  isSlashCommandInput,
  shouldCompleteSlashCommandInput
} from "./PromptInput.js";

function runTests() {
  testSlashInputDetection();
  testSlashSuggestionsFilterByPrefix();
  testSlashCompletionRules();
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

function testSlashCompletionRules() {
  const model = getSlashCommandSuggestions("/model")[0];
  assert.equal(model?.completion, "/model ");
  assert.equal(model ? shouldCompleteSlashCommandInput("/model", model) : false, true);
  assert.equal(model ? shouldCompleteSlashCommandInput("/model ", model) : true, false);

  const help = getSlashCommandSuggestions("/help")[0];
  assert.equal(help?.completion, "/help");
  assert.equal(help ? shouldCompleteSlashCommandInput("/help", help) : true, false);
}

runTests();
