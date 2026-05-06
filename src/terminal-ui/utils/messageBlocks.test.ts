import assert from "node:assert/strict";
import {
  getCopyableMessageContent,
  getRenderableMessageBlocks,
  serializeMessageBlocks
} from "./messageBlocks.js";
import type { TerminalUiMessage } from "../state/types.js";

function createMessage(overrides: Partial<TerminalUiMessage>): TerminalUiMessage {
  return {
    id: "message-id",
    kind: "assistant",
    title: "Message",
    blocks: [],
    content: "",
    preview: "",
    metadata: [],
    createdAt: "2026-05-01T00:00:00.000Z",
    ...overrides
  };
}

function runTests() {
  const legacyWriteMessage = createMessage({
    kind: "tool",
    content: "Content\nline 1\nline 2",
    blocks: [
      {
        label: "Content",
        content: "line 1\nline 2",
        style: "code"
      }
    ],
    toolData: {
      phase: "result",
      toolName: "Write",
      summary: "Write file.txt",
      ok: true,
      resultKind: "write",
      write: {
        filePath: "file.txt",
        mode: "update",
        bytes: 12,
        lineCount: 2
      }
    }
  });

  assert.deepEqual(getRenderableMessageBlocks(legacyWriteMessage), [
    {
      label: "Patch",
      content: "+line 1\n+line 2",
      style: "code"
    }
  ]);
  assert.equal(getCopyableMessageContent(legacyWriteMessage), "Patch\n+line 1\n+line 2");

  const patchWriteMessage = createMessage({
    kind: "tool",
    content: "Patch\n+new line",
    blocks: [
      {
        label: "Patch",
        content: "+new line",
        style: "code"
      }
    ],
    toolData: {
      phase: "result",
      toolName: "Write",
      summary: "Write file.txt",
      ok: true,
      resultKind: "write",
      write: {
        filePath: "file.txt",
        mode: "create",
        bytes: 8,
        lineCount: 1
      }
    }
  });

  assert.equal(getCopyableMessageContent(patchWriteMessage), "Patch\n+new line");

  const editMessage = createMessage({
    kind: "tool",
    content: "Patch\n-old\n+new",
    blocks: [
      {
        label: "Edit",
        content: "legacy edit block",
        style: "code"
      },
      {
        label: "Patch",
        content: "-old\n+new",
        style: "code"
      }
    ],
    toolData: {
      phase: "result",
      toolName: "Edit",
      summary: "Edit file.txt",
      ok: true,
      resultKind: "edit",
      edit: {
        filePath: "file.txt",
        replaceAll: false,
        matchCount: 1
      }
    }
  });

  assert.equal(getCopyableMessageContent(editMessage), "Patch\n-old\n+new");

  const applyPatchMessage = createMessage({
    kind: "tool",
    content: "Files\nM file.txt (+1 -1)\n\nPatch\n-old\n+new",
    blocks: [
      {
        label: "Files",
        content: "M file.txt (+1 -1)",
        style: "code"
      },
      {
        label: "Patch",
        content: "-old\n+new",
        style: "code"
      }
    ],
    toolData: {
      phase: "result",
      toolName: "apply_patch",
      summary: "apply_patch file.txt",
      ok: true,
      resultKind: "patch",
      patch: {
        filePath: "file.txt",
        operationCount: 1,
        additions: 1,
        deletions: 1,
        files: [{
          type: "update",
          filePath: "file.txt",
          additions: 1,
          deletions: 1,
          matchStrategies: ["exact"]
        }]
      }
    }
  });

  assert.equal(
    getCopyableMessageContent(applyPatchMessage),
    "Files\nM file.txt (+1 -1)\n\nPatch\n-old\n+new"
  );

  const normalAssistantMessage = createMessage({
    kind: "assistant",
    content: "hello world",
    blocks: [{ content: "hello world" }]
  });

  assert.equal(getCopyableMessageContent(normalAssistantMessage), "hello world");
  assert.equal(serializeMessageBlocks(normalAssistantMessage.blocks), "hello world");

  console.log("messageBlocks copy tests passed");
}

runTests();
