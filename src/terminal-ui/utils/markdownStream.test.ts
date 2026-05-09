import assert from "node:assert/strict";
import { stabilizeMarkdownForRender, streamMarkdownForRender } from "./markdownStream.js";

function runTests() {
  testStableMarkdownDoesNotChange();
  testUnterminatedBacktickFenceGetsSyntheticCloser();
  testUnterminatedTildeFenceGetsSyntheticCloser();
  testLiveStreamRepairsDanglingLink();
  testLiveStreamRepairsDanglingQuoteAndListMarker();
  testMixedFenceMarkersInsideCodeDoNotProduceSyntheticClosers();
  testFenceLikeLineWithIndentationDoesNotCloseFence();
  testLiveStreamSplitsTrailingOpenCodeFenceIntoDedicatedBlock();
  console.log("markdownStream tests passed");
}

function testStableMarkdownDoesNotChange() {
  const source = [
    "before",
    "```ts",
    "const value = 1;",
    "```",
    "after"
  ].join("\n");

  assert.equal(stabilizeMarkdownForRender(source), source);
}

function testUnterminatedBacktickFenceGetsSyntheticCloser() {
  const source = [
    "before",
    "```ts",
    "const value = 1;"
  ].join("\n");

  const stabilized = stabilizeMarkdownForRender(source);
  assert.equal(stabilized, `${source}\n\`\`\``);
}

function testUnterminatedTildeFenceGetsSyntheticCloser() {
  const source = [
    "before",
    "~~~python",
    "print('ok')"
  ].join("\n");

  const stabilized = stabilizeMarkdownForRender(source);
  assert.equal(stabilized, `${source}\n~~~`);
}

function testLiveStreamRepairsDanglingLink() {
  const source = "See [example](https://example.com/path";
  const stabilized = stabilizeMarkdownForRender(source, { live: true });
  assert.equal(stabilized, "See [example](https://example.com/path)");
}

function testLiveStreamRepairsDanglingQuoteAndListMarker() {
  assert.equal(stabilizeMarkdownForRender(">\n", { live: true }), ">\n ");
  assert.equal(stabilizeMarkdownForRender("-\n", { live: true }), "-\n ");
  assert.equal(stabilizeMarkdownForRender("1.\n", { live: true }), "1.\n ");
}

function testMixedFenceMarkersInsideCodeDoNotProduceSyntheticClosers() {
  const source = [
    "```md",
    "~~~",
    "literal tildes",
    "```"
  ].join("\n");
  const stabilized = stabilizeMarkdownForRender(source);

  assert.equal(stabilized, source);
}

function testFenceLikeLineWithIndentationDoesNotCloseFence() {
  const source = [
    "```md",
    "    ```",
    "still code",
    "```"
  ].join("\n");
  const stabilized = stabilizeMarkdownForRender(source);

  assert.equal(stabilized, source);
}

function testLiveStreamSplitsTrailingOpenCodeFenceIntoDedicatedBlock() {
  const source = [
    "intro paragraph",
    "",
    "```ts",
    "const value = 1;"
  ].join("\n");

  const blocks = streamMarkdownForRender(source, true);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]?.mode, "live");
  assert.equal(blocks[1]?.mode, "live");
  assert.match(blocks[0]?.src ?? "", /intro paragraph/);
  assert.match(blocks[1]?.src ?? "", /```ts/);
  assert.match(blocks[1]?.src ?? "", /```$/m);
}

runTests();
