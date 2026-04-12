import { promises as fs } from "node:fs";
import path from "node:path";
import type { JsonRecord, ToolExecutionContext } from "../types.js";
import { resolveWorkspacePath, toWorkspaceRelative } from "../internal/pathSandbox.js";
import { asString, parsePositiveInt, truncate } from "../internal/values.js";

const MAX_READ_LINES = 300;

// list_files 工具：列出指定目录下的文件与子目录。
export async function listFiles(args: JsonRecord, context: ToolExecutionContext) {
  const target = resolveWorkspacePath(context.workspaceRoot, asString(args.path) ?? ".");
  const entries = await fs.readdir(target, { withFileTypes: true });

  const items = entries
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort((a, b) => a.localeCompare(b));

  return {
    path: toWorkspaceRelative(context.workspaceRoot, target),
    items
  };
}

// read_file 工具：按行区间读取文本，默认最多返回 300 行。
export async function readFile(args: JsonRecord, context: ToolExecutionContext) {
  const requestedPath = asString(args.path);
  if (!requestedPath) {
    throw new Error("read_file requires 'path'");
  }

  const target = resolveWorkspacePath(context.workspaceRoot, requestedPath);
  const raw = await fs.readFile(target, "utf8");
  const lines = raw.split(/\r?\n/);

  const startLine = parsePositiveInt(args.startLine, 1);
  const endLine = parsePositiveInt(args.endLine, Math.min(lines.length, startLine + MAX_READ_LINES - 1));

  // 显式校验区间关系，避免出现反向切片。
  if (endLine < startLine) {
    throw new Error("endLine must be >= startLine");
  }

  const chunk = lines
    .slice(startLine - 1, endLine)
    .map((line, index) => `${startLine + index}: ${line}`)
    .join("\n");

  return {
    path: toWorkspaceRelative(context.workspaceRoot, target),
    startLine,
    endLine,
    lineCount: lines.length,
    content: truncate(chunk)
  };
}

// write_file 工具：支持覆盖和追加两种写入模式，并走人工审批。
export async function writeFile(args: JsonRecord, context: ToolExecutionContext) {
  const requestedPath = asString(args.path);
  if (!requestedPath) {
    throw new Error("write_file requires 'path'");
  }

  const content = asString(args.content);
  if (content === undefined) {
    throw new Error("write_file requires 'content'");
  }

  const append = Boolean(args.append);
  const target = resolveWorkspacePath(context.workspaceRoot, requestedPath);
  const relative = toWorkspaceRelative(context.workspaceRoot, target);

  const approved = await context.requestApproval(
    `${append ? "append to" : "write"} ${relative} (${Buffer.byteLength(content, "utf8")} bytes)`
  );

  if (!approved) {
    return { denied: true, reason: "User rejected write_file" };
  }

  await fs.mkdir(path.dirname(target), { recursive: true });

  // 先确保目录存在，再按模式执行写入。
  if (append) {
    await fs.appendFile(target, content, "utf8");
  } else {
    await fs.writeFile(target, content, "utf8");
  }

  return {
    ok: true,
    path: relative,
    mode: append ? "append" : "overwrite",
    bytes: Buffer.byteLength(content, "utf8")
  };
}
