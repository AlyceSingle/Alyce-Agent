import type {
  TerminalUiMessageBlock,
  TerminalUiMessageBlockTone
} from "../../state/types.js";
import {
  asBoolean,
  asNullableNumber,
  asNullableString,
  asNumber,
  asNumberArray,
  asRecord,
  asRecordArray,
  asString,
  asStringArray,
  BACKGROUND_PROCESS_TOOL_NAMES,
  createBlock,
  truncateInline
} from "./common.js";

// 后台 Process* 工具展示。

export function buildBackgroundProcessToolBlocks(
  toolName: string,
  structuredResult: unknown
): TerminalUiMessageBlock[] | null {
  if (!BACKGROUND_PROCESS_TOOL_NAMES.has(toolName)) {
    return null;
  }

  const record = asRecord(structuredResult);
  if (!record) {
    return null;
  }

  if (toolName === "ProcessStart") {
    return buildProcessStartBlocks(record);
  }

  if (toolName === "ProcessList") {
    return buildProcessListBlocks(record);
  }

  if (toolName === "ProcessRead") {
    return buildProcessReadBlocks(record);
  }

  if (toolName === "ProcessStop") {
    return buildProcessStopBlocks(record);
  }

  return null;
}

export function buildProcessStartBlocks(record: Record<string, unknown>): TerminalUiMessageBlock[] {
  const status = asString(record.status);
  const details = formatProcessDetails(record, {
    includeLogs: true,
    includeTiming: true
  });
  const blocks: TerminalUiMessageBlock[] = [
    createBlock(details, {
      label: "Process",
      tone: processStatusTone(status),
      style: "code"
    })
  ];
  const command = asString(record.command);
  if (command) {
    blocks.push(createBlock(`$ ${command}`, { label: "Command", style: "code" }));
  }
  const stdoutPreview = asString(record.stdout_preview)?.trim();
  const stderrPreview = asString(record.stderr_preview)?.trim();
  if (stdoutPreview) {
    blocks.push(createBlock(stdoutPreview, { label: "Stdout Preview", tone: "success", style: "code" }));
  }
  if (stderrPreview) {
    blocks.push(createBlock(stderrPreview, { label: "Stderr Preview", tone: "warning", style: "code" }));
  }

  return blocks;
}

export function buildProcessListBlocks(record: Record<string, unknown>): TerminalUiMessageBlock[] {
  const processes = asRecordArray(record.processes);
  if (processes.length === 0) {
    return [createBlock("No managed background processes are running.", { label: "Processes", tone: "muted" })];
  }

  return [
    createBlock(processes.map(formatProcessSummaryLine).join("\n"), {
      label: "Processes",
      tone: "success",
      style: "code"
    })
  ];
}

export function buildProcessReadBlocks(record: Record<string, unknown>): TerminalUiMessageBlock[] {
  const details = [
    `Process: ${asString(record.process_id) ?? "(unknown)"}`,
    `Stream: ${asString(record.stream) ?? "combined"}`,
    ...(asString(record.log_path) ? [`Log: ${asString(record.log_path)}`] : []),
    ...(asNumber(record.offset) !== undefined ? [`Offset: ${asNumber(record.offset)}`] : []),
    ...(asNumber(record.bytes) !== undefined ? [`Bytes: ${asNumber(record.bytes)}`] : []),
    ...(asBoolean(record.eof) !== undefined ? [`EOF: ${asBoolean(record.eof) ? "yes" : "no"}`] : [])
  ];

  return [
    createBlock(asString(record.content) ?? "", {
      label: "Log",
      tone: "success",
      style: "code"
    }),
    createBlock(details.join("\n"), {
      label: "Details",
      style: "code"
    })
  ];
}

export function buildProcessStopBlocks(record: Record<string, unknown>): TerminalUiMessageBlock[] {
  const status = asString(record.status);
  const lines = [
    `Process: ${asString(record.process_id) ?? "(unknown)"}`,
    `Status: ${status ?? "unknown"}`,
    ...(asString(record.message) ? [`Message: ${asString(record.message)}`] : []),
    ...formatNullableExitLines(record)
  ];
  const blocks: TerminalUiMessageBlock[] = [
    createBlock(lines.join("\n"), {
      label: "Stop",
      tone: processStatusTone(status),
      style: "code"
    })
  ];
  const processRecord = asRecord(record.process);
  if (processRecord) {
    blocks.push(createBlock(formatProcessSummaryLine(processRecord), {
      label: "Process",
      style: "code"
    }));
  }

  return blocks;
}

export function formatProcessDetails(
  record: Record<string, unknown>,
  options: { includeLogs?: boolean; includeTiming?: boolean } = {}
): string {
  const lines = [
    `Status: ${asString(record.status) ?? "unknown"}`,
    `Process: ${asString(record.process_id) ?? "(unknown)"}`,
    ...formatNullablePidLine(record),
    ...(asString(record.cwd) ? [`CWD: ${asString(record.cwd)}`] : []),
    ...formatProcessEndpointLines(record),
    ...formatNullableExitLines(record),
    ...formatProcessWarningLines(record),
    ...(asString(record.last_error) ? [`Error: ${asString(record.last_error)}`] : [])
  ];

  if (options.includeLogs) {
    lines.push(...formatProcessLogLines(record));
  }

  if (options.includeTiming) {
    lines.push(
      ...(asString(record.started_at) ? [`Started: ${asString(record.started_at)}`] : []),
      ...(asString(record.updated_at) ? [`Updated: ${asString(record.updated_at)}`] : []),
      ...(asString(record.exited_at) ? [`Exited: ${asString(record.exited_at)}`] : [])
    );
  }

  return lines.join("\n");
}

export function formatProcessSummaryLine(record: Record<string, unknown>): string {
  const parts = [
    asString(record.process_id) ?? "(unknown)",
    asString(record.status) ?? "unknown",
    ...formatNullablePidLine(record),
    asString(record.command) ? truncateInline(asString(record.command)!, 96) : "(no command)"
  ];
  const urls = asStringArray(record.detected_urls);
  if (urls.length > 0) {
    parts.push(urls[0]!);
  }
  const error = asString(record.last_error);
  if (error) {
    parts.push(`error: ${truncateInline(error, 80)}`);
  }
  const warnings = asStringArray(record.warnings);
  if (warnings.length > 0) {
    parts.push(`warning: ${truncateInline(warnings[0]!, 80)}`);
  }

  return `- ${parts.join(" | ")}`;
}

export function formatProcessEndpointLines(record: Record<string, unknown>): string[] {
  const urls = asStringArray(record.detected_urls);
  const ports = asNumberArray(record.detected_ports);
  return [
    ...(urls.length > 0 ? [`URL: ${urls.join(", ")}`] : []),
    ...(ports.length > 0 ? [`Port: ${ports.join(", ")}`] : []),
    ...(asString(record.startup_matched) ? [`Startup matched: ${asString(record.startup_matched)}`] : []),
    ...(asBoolean(record.startup_timed_out) === true ? ["Startup observation timed out"] : [])
  ];
}

export function formatProcessLogLines(record: Record<string, unknown>): string[] {
  return [
    ...(asString(record.combined_log_path) ? [`Log: ${asString(record.combined_log_path)}`] : []),
    ...(asString(record.stdout_log_path) ? [`Stdout log: ${asString(record.stdout_log_path)}`] : []),
    ...(asString(record.stderr_log_path) ? [`Stderr log: ${asString(record.stderr_log_path)}`] : [])
  ];
}

export function formatProcessWarningLines(record: Record<string, unknown>): string[] {
  const warnings = asStringArray(record.warnings);
  return warnings.map((warning) => `Warning: ${warning}`);
}

export function formatNullablePidLine(record: Record<string, unknown>): string[] {
  if (record.pid === null) {
    return ["PID: (unknown)"];
  }

  const pid = asNumber(record.pid);
  return pid === undefined ? [] : [`PID: ${pid}`];
}

export function formatNullableExitLines(record: Record<string, unknown>): string[] {
  const lines: string[] = [];
  if ("exit_code" in record) {
    lines.push(`Exit: ${record.exit_code === null ? "null" : asNumber(record.exit_code) ?? "unknown"}`);
  }
  if ("signal" in record) {
    lines.push(`Signal: ${record.signal === null ? "null" : asString(record.signal) ?? "unknown"}`);
  }
  return lines;
}

export function processStatusTone(status: string | undefined): TerminalUiMessageBlockTone {
  if (status === "running") {
    return "success";
  }

  if (status === "failed") {
    return "danger";
  }

  if (status === "starting") {
    return "info";
  }

  if (status === "exited" || status === "stopped" || status === "not_found") {
    return "warning";
  }

  return "default";
}
