import type {
  TerminalUiMessageBlock,
  TerminalUiToolData
} from "../../state/types.js";
import {
  asBoolean,
  asRecord,
  asString,
  capitalizeWord,
  createBlock,
  createMessage,
  formatStructuredValue,
  formatToolError,
  normalizeInlineValue,
  TOOL_PREVIEW_MAX_CHARS,
  TOOL_TARGET_KEYS,
  TOOL_TITLE_MAX_CHARS,
  toToolResultError,
  tryParseRecord,
  truncateInline,
  truncateText,
  type ParsedToolCallExecutionResult,
  type ToolResultError
} from "./common.js";
import { formatExitState, toShellResult } from "./shellDisplay.js";
import {
  buildPostWriteCheckBlocks,
  extractStructuredPatchDisplayText,
  formatDiagnosticsMetadata,
  formatFormatterMetadata,
  formatPatchFiles,
  toEditResult,
  toPatchResult,
  toWriteResult
} from "./writeDisplay.js";
import { buildReadMetadata, buildReadResultBlocks, toReadResult } from "./readDisplay.js";
import { buildBackgroundProcessToolBlocks } from "./processDisplay.js";
import { buildPtyToolBlocks } from "./ptyDisplay.js";
import { buildMarkdownFriendlyGenericBlocks } from "./genericDisplay.js";

// 工具结果消息组装入口。

export function createToolResultMessage(toolName: string, displayResult: string, rawArguments = "") {
  const result = parseToolCallExecutionResult(toolName, displayResult, rawArguments);
  const summary = buildToolSummary(result.toolName, result.parsedArgs, result.structuredResult);
  const toolData = buildToolResultData(result, summary);

  return createMessage({
    kind: "tool",
    title: summary,
    blocks: buildToolResultBlocks(result, toolData),
    metadata: buildToolResultMetadata(toolData),
    maxPreviewChars: TOOL_PREVIEW_MAX_CHARS,
    toolData
  });
}

export function buildToolResultData(result: ParsedToolCallExecutionResult, summary: string): TerminalUiToolData {
  if (!result.ok) {
    return {
      phase: "result",
      toolName: result.toolName,
      summary,
      ok: false,
      resultKind: "generic"
    };
  }

  const shell = toShellResult(result.structuredResult);
  if (shell) {
    return {
      phase: "result",
      toolName: result.toolName,
      summary,
      ok: true,
      resultKind: "shell",
      shell
    };
  }

  const write = toWriteResult(result.structuredResult);
  if (write) {
    return {
      phase: "result",
      toolName: result.toolName,
      summary,
      ok: true,
      resultKind: "write",
      write
    };
  }

  const edit = toEditResult(result.structuredResult);
  if (edit) {
    return {
      phase: "result",
      toolName: result.toolName,
      summary,
      ok: true,
      resultKind: "edit",
      edit
    };
  }

  const patch = toPatchResult(result.structuredResult);
  if (patch) {
    return {
      phase: "result",
      toolName: result.toolName,
      summary,
      ok: true,
      resultKind: "patch",
      patch
    };
  }

  const read = toReadResult(result.structuredResult);
  if (read) {
    return {
      phase: "result",
      toolName: result.toolName,
      summary,
      ok: true,
      resultKind: "read",
      read
    };
  }

  return {
    phase: "result",
    toolName: result.toolName,
    summary,
    ok: true,
    resultKind: "generic"
  };
}

export function buildToolResultBlocks(
  result: ParsedToolCallExecutionResult,
  toolData: TerminalUiToolData
): TerminalUiMessageBlock[] {
  if (!toolData.ok) {
    return [createBlock(formatToolError(result.error, result.displayResult), { label: "Error", tone: "danger" })];
  }

  switch (toolData.resultKind) {
    case "shell": {
      const shell = toolData.shell;
      if (!shell) {
        break;
      }

      const blocks: TerminalUiMessageBlock[] = [
        createBlock(`$ ${shell.command}`, {
          label: "Command",
          style: "code"
        })
      ];
      if (shell.stdout.trim()) {
        blocks.push(createBlock(shell.stdout, { label: "Stdout", tone: "success", style: "code" }));
      }
      if (shell.stderr.trim()) {
        blocks.push(createBlock(shell.stderr, { label: "Stderr", tone: "warning", style: "code" }));
      }
      if (!shell.stdout.trim() && !shell.stderr.trim()) {
        blocks.push(createBlock("(no output)", { tone: "muted" }));
      }
      return blocks;
    }
    case "write": {
      const patchText = extractStructuredPatchDisplayText(result.structuredResult);
      const blocks = [
        createBlock(patchText || "(empty patch)", { label: "Patch", style: "code" })
      ];
      blocks.push(...buildPostWriteCheckBlocks(toolData.write));
      return blocks;
    }
    case "edit": {
      const edit = toolData.edit;
      if (!edit) {
        break;
      }

      const patchText = extractStructuredPatchDisplayText(result.structuredResult);
      const blocks = [
        createBlock(patchText || "(empty patch)", { label: "Patch", style: "code" })
      ];
      blocks.push(...buildPostWriteCheckBlocks(edit));
      return blocks;
    }
    case "patch": {
      const patch = toolData.patch;
      if (!patch) {
        break;
      }

      const patchText = extractStructuredPatchDisplayText(result.structuredResult);
      const blocks = [
        createBlock(formatPatchFiles(patch), { label: "Files", style: "code" }),
        createBlock(patchText || "(empty patch)", { label: "Patch", style: "code" })
      ];
      blocks.push(...buildPostWriteCheckBlocks(patch));
      return blocks;
    }
    case "read": {
      const read = toolData.read;
      if (!read) {
        break;
      }

      return buildReadResultBlocks(read, result.structuredResult);
    }
    case "generic":
    default:
      break;
  }

  const backgroundProcessBlocks = buildBackgroundProcessToolBlocks(
    result.toolName,
    result.structuredResult
  );
  if (backgroundProcessBlocks) {
    return backgroundProcessBlocks;
  }

  const ptyBlocks = buildPtyToolBlocks(
    result.toolName,
    result.structuredResult
  );
  if (ptyBlocks) {
    return ptyBlocks;
  }

  const markdownFriendlyBlocks = buildMarkdownFriendlyGenericBlocks(
    result.toolName,
    result.structuredResult
  );
  if (markdownFriendlyBlocks) {
    return markdownFriendlyBlocks;
  }

  return [
    createBlock(formatStructuredValue(result.structuredResult), {
      label: "Output",
      tone: "success",
      style: "code"
    })
  ];
}

export function buildToolResultMetadata(toolData: TerminalUiToolData) {
  const metadata = ["Tool result"];

  if (!toolData.ok) {
    metadata.push("Failed");
    return metadata;
  }

  if (toolData.shell) {
    metadata.push(`Exit: ${formatExitState(toolData.shell)}`);
    metadata.push(`${toolData.shell.durationMs} ms`);
    if (toolData.shell.timedOut) {
      metadata.push("Timed out");
    }
  }

  if (toolData.write) {
    metadata.push(toolData.write.mode === "create" ? "Created" : "Updated");
    metadata.push(`${toolData.write.bytes} bytes`);
    metadata.push(`${toolData.write.lineCount} lines`);
    if (toolData.write.formatter && toolData.write.formatter.status !== "skipped") {
      metadata.push(formatFormatterMetadata(toolData.write.formatter));
    }
    if (toolData.write.diagnostics && toolData.write.diagnostics.status !== "skipped") {
      metadata.push(formatDiagnosticsMetadata(toolData.write.diagnostics));
    }
  }

  if (toolData.edit) {
    if (toolData.edit.formatter && toolData.edit.formatter.status !== "skipped") {
      metadata.push(formatFormatterMetadata(toolData.edit.formatter));
    }
    if (toolData.edit.diagnostics && toolData.edit.diagnostics.status !== "skipped") {
      metadata.push(formatDiagnosticsMetadata(toolData.edit.diagnostics));
    }
  }

  if (toolData.patch) {
    metadata.push(`${toolData.patch.operationCount} file(s)`);
    metadata.push(`+${toolData.patch.additions} -${toolData.patch.deletions}`);
    if (toolData.patch.formatter && toolData.patch.formatter.status !== "skipped") {
      metadata.push(formatFormatterMetadata(toolData.patch.formatter));
    }
    if (toolData.patch.diagnostics && toolData.patch.diagnostics.status !== "skipped") {
      metadata.push(formatDiagnosticsMetadata(toolData.patch.diagnostics));
    }
  }

  if (toolData.read) {
    metadata.push(...buildReadMetadata(toolData.read));
  }

  return metadata;
}

export function buildToolSummary(
  toolName: string,
  parsedArguments?: Record<string, unknown>,
  structuredResult?: unknown
) {
  const toolTarget = resolveToolTarget(parsedArguments, structuredResult);
  if (!toolTarget) {
    return toolName;
  }

  return `${toolName} ${truncateInline(toolTarget, TOOL_TITLE_MAX_CHARS - toolName.length - 1)}`;
}

export function resolveToolTarget(
  parsedArguments?: Record<string, unknown>,
  structuredResult?: unknown
): string | null {
  if (parsedArguments) {
    for (const key of TOOL_TARGET_KEYS) {
      const value = asString(parsedArguments[key]);
      if (value) {
        return normalizeInlineValue(value);
      }
    }
  }

  const resultRecord = asRecord(structuredResult);
  if (!resultRecord) {
    return null;
  }

  const filePath = asString(resultRecord.filePath);
  if (filePath) {
    return normalizeInlineValue(filePath);
  }

  return null;
}

export function parseToolCallExecutionResult(
  toolName: string,
  displayResult: string,
  rawArguments: string
): ParsedToolCallExecutionResult {
  const parsedArgs = tryParseRecord(rawArguments);
  const envelope = tryParseRecord(displayResult);

  if (!envelope) {
    return {
      toolName,
      parsedArgs,
      displayResult,
      structuredResult: displayResult,
      ok: true
    };
  }

  const ok = asBoolean(envelope.ok);
  if (ok === false) {
    return {
      toolName,
      parsedArgs,
      displayResult,
      structuredResult: envelope.result ?? envelope.error,
      ok: false,
      status: asString(envelope.status),
      error: toToolResultError(envelope.error)
    };
  }

  return {
    toolName,
    parsedArgs,
    displayResult,
    structuredResult: envelope.result ?? envelope,
    ok: true,
    status: asString(envelope.status)
  };
}
