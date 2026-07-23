import type {
  TerminalUiMessageBlock,
  TerminalUiMessageBlockTone
} from "../../state/types.js";
import {
  asBoolean,
  asNumber,
  asRecord,
  asRecordArray,
  asString,
  asStringArray,
  createBlock,
  PTY_TOOL_NAMES,
  truncateInline
} from "./common.js";
import { formatNullableExitLines, formatNullablePidLine } from "./processDisplay.js";

// 交互式 Pty* 工具展示。

export function buildPtyToolBlocks(
  toolName: string,
  structuredResult: unknown
): TerminalUiMessageBlock[] | null {
  if (!PTY_TOOL_NAMES.has(toolName)) {
    return null;
  }

  const record = asRecord(structuredResult);
  if (!record) {
    return null;
  }

  if (toolName === "PtyCreate") {
    return buildPtyCreateBlocks(record);
  }

  if (toolName === "PtyList") {
    return buildPtyListBlocks(record);
  }

  if (toolName === "PtyRead") {
    return buildPtyReadBlocks(record);
  }

  if (toolName === "PtyWrite") {
    return buildPtyWriteBlocks(record);
  }

  if (toolName === "PtyResize") {
    return buildPtyResizeBlocks(record);
  }

  if (toolName === "PtyClose") {
    return buildPtyCloseBlocks(record);
  }

  return null;
}

export function buildPtyCreateBlocks(record: Record<string, unknown>): TerminalUiMessageBlock[] {
  const status = asString(record.status);
  const blocks: TerminalUiMessageBlock[] = [
    createBlock(formatPtyDetails(record, { includeTiming: true }), {
      label: "PTY",
      tone: ptyStatusTone(status),
      style: "code"
    })
  ];
  const command = formatPtyCommand(record);
  if (command) {
    blocks.push(createBlock(`$ ${command}`, { label: "Command", style: "code" }));
  }
  const note = asString(record.note);
  if (note) {
    blocks.push(createBlock(note, { label: "Note", tone: status === "failed" ? "warning" : "info" }));
  }

  return blocks;
}

export function buildPtyListBlocks(record: Record<string, unknown>): TerminalUiMessageBlock[] {
  const sessions = asRecordArray(record.sessions);
  if (sessions.length === 0) {
    return [createBlock("No interactive PTY sessions are active.", { label: "PTY Sessions", tone: "muted" })];
  }

  return [
    createBlock(sessions.map(formatPtySummaryLine).join("\n"), {
      label: "PTY Sessions",
      tone: "success",
      style: "code"
    })
  ];
}

export function buildPtyReadBlocks(record: Record<string, unknown>): TerminalUiMessageBlock[] {
  const details = [
    `PTY: ${asString(record.pty_id) ?? "(unknown)"}`,
    ...(asNumber(record.cursor) !== undefined ? [`Cursor: ${asNumber(record.cursor)}`] : []),
    ...(asNumber(record.next_cursor) !== undefined ? [`Next cursor: ${asNumber(record.next_cursor)}`] : []),
    ...(asNumber(record.buffer_cursor) !== undefined ? [`Buffer cursor: ${asNumber(record.buffer_cursor)}`] : []),
    ...(asNumber(record.bytes) !== undefined ? [`Bytes: ${asNumber(record.bytes)}`] : []),
    ...(asBoolean(record.eof) !== undefined ? [`EOF: ${asBoolean(record.eof) ? "yes" : "no"}`] : [])
  ];
  const session = asRecord(record.session);
  if (session) {
    details.push(
      `Status: ${asString(session.status) ?? "unknown"}`,
      ...(asString(session.title) ? [`Title: ${asString(session.title)}`] : []),
      ...(asString(session.cwd) ? [`CWD: ${asString(session.cwd)}`] : [])
    );
  }

  return [
    createBlock(asString(record.content) ?? "", {
      label: "PTY Output",
      tone: "success",
      style: "code"
    }),
    createBlock(details.join("\n"), {
      label: "Details",
      style: "code"
    })
  ];
}

export function buildPtyWriteBlocks(record: Record<string, unknown>): TerminalUiMessageBlock[] {
  const session = asRecord(record.session);
  const lines = [
    `PTY: ${asString(record.pty_id) ?? "(unknown)"}`,
    ...(asNumber(record.bytes) !== undefined ? [`Bytes written: ${asNumber(record.bytes)}`] : []),
    ...(asNumber(record.cursor) !== undefined ? [`Cursor: ${asNumber(record.cursor)}`] : []),
    ...(session ? [`Status: ${asString(session.status) ?? "unknown"}`] : [])
  ];

  return [
    createBlock(lines.join("\n"), {
      label: "Write",
      tone: ptyStatusTone(asString(session?.status)),
      style: "code"
    })
  ];
}

export function buildPtyResizeBlocks(record: Record<string, unknown>): TerminalUiMessageBlock[] {
  const session = asRecord(record.session);
  const lines = [
    `PTY: ${asString(record.pty_id) ?? "(unknown)"}`,
    `Size: ${asNumber(record.cols) ?? "?"}x${asNumber(record.rows) ?? "?"}`,
    ...(session ? [`Status: ${asString(session.status) ?? "unknown"}`] : [])
  ];

  return [
    createBlock(lines.join("\n"), {
      label: "Resize",
      tone: ptyStatusTone(asString(session?.status)),
      style: "code"
    })
  ];
}

export function buildPtyCloseBlocks(record: Record<string, unknown>): TerminalUiMessageBlock[] {
  const status = asString(record.status);
  const lines = [
    `PTY: ${asString(record.pty_id) ?? "(unknown)"}`,
    `Status: ${status ?? "unknown"}`,
    ...(asString(record.message) ? [`Message: ${asString(record.message)}`] : [])
  ];
  const blocks: TerminalUiMessageBlock[] = [
    createBlock(lines.join("\n"), {
      label: "Close",
      tone: ptyStatusTone(status),
      style: "code"
    })
  ];
  const session = asRecord(record.session);
  if (session) {
    blocks.push(createBlock(formatPtySummaryLine(session), {
      label: "PTY",
      style: "code"
    }));
  }

  return blocks;
}

export function formatPtyDetails(
  record: Record<string, unknown>,
  options: { includeTiming?: boolean } = {}
): string {
  const lines = [
    `Status: ${asString(record.status) ?? "unknown"}`,
    `PTY: ${asString(record.pty_id) ?? "(unknown)"}`,
    ...formatNullablePidLine(record),
    ...(asString(record.title) ? [`Title: ${asString(record.title)}`] : []),
    ...(asString(record.cwd) ? [`CWD: ${asString(record.cwd)}`] : []),
    `Size: ${asNumber(record.cols) ?? "?"}x${asNumber(record.rows) ?? "?"}`,
    ...formatNullableExitLines(record),
    ...(asString(record.last_error) ? [`Error: ${asString(record.last_error)}`] : [])
  ];

  if (options.includeTiming) {
    lines.push(
      ...(asString(record.created_at) ? [`Created: ${asString(record.created_at)}`] : []),
      ...(asString(record.updated_at) ? [`Updated: ${asString(record.updated_at)}`] : []),
      ...(asString(record.exited_at) ? [`Exited: ${asString(record.exited_at)}`] : [])
    );
  }

  return lines.join("\n");
}

export function formatPtySummaryLine(record: Record<string, unknown>): string {
  const command = formatPtyCommand(record);
  const parts = [
    asString(record.pty_id) ?? "(unknown)",
    asString(record.status) ?? "unknown",
    ...formatNullablePidLine(record),
    asString(record.title) ?? "(untitled)",
    command ? truncateInline(command, 96) : "(no command)"
  ];
  const error = asString(record.last_error);
  if (error) {
    parts.push(`error: ${truncateInline(error, 80)}`);
  }

  return `- ${parts.join(" | ")}`;
}

export function formatPtyCommand(record: Record<string, unknown>): string | undefined {
  const command = asString(record.command);
  if (!command) {
    return undefined;
  }

  const args = asStringArray(record.args);
  return [command, ...args].join(" ");
}

export function ptyStatusTone(status: string | undefined): TerminalUiMessageBlockTone {
  if (status === "running") {
    return "success";
  }

  if (status === "failed") {
    return "danger";
  }

  if (status === "exited" || status === "closed" || status === "not_found") {
    return "warning";
  }

  return "default";
}
