import assert from "node:assert/strict";
import type { TerminalUiMessage } from "../state/types.js";
import { isEphemeralProgressMessage } from "./messageMapper.js";

function createMessage(overrides: Partial<TerminalUiMessage>): TerminalUiMessage {
  return {
    id: "message-id",
    kind: "system",
    title: "System",
    blocks: [],
    content: "",
    preview: "",
    metadata: [],
    createdAt: "2026-05-01T00:00:00.000Z",
    ...overrides
  };
}

function runTests() {
  testDetectsProgressTitle();
  testDetectsProgressMetadataToken();
  testDetectsProgressMetadataPrefix();
  testIgnoresNonProgressMetadataText();
  console.log("messageMapper tests passed");
}

function testDetectsProgressTitle() {
  const message = createMessage({ kind: "system", title: "Progress" });
  assert.equal(isEphemeralProgressMessage(message), true);
}

function testDetectsProgressMetadataToken() {
  const message = createMessage({ metadata: ["progress"] });
  assert.equal(isEphemeralProgressMessage(message), true);
}

function testDetectsProgressMetadataPrefix() {
  const message = createMessage({ metadata: ["progress: 3/10"] });
  assert.equal(isEphemeralProgressMessage(message), true);
}

function testIgnoresNonProgressMetadataText() {
  const message = createMessage({ metadata: ["tool result", "in progress"] });
  assert.equal(isEphemeralProgressMessage(message), false);
}

runTests();
