import { promises as fs } from "node:fs";
import path from "node:path";

export interface ProjectInstructionsPromptContext {
  fileName: string;
  content: string;
  truncatedChars: number;
}

// 按优先级探测：项目专用文件优先，其次是通用的 agent 约定文件。
export const PROJECT_INSTRUCTION_FILE_NAMES = ["ALYCE.md", "AGENTS.md", "CLAUDE.md"] as const;

// 上限防止有人把整本手册塞进来撑爆上下文；超出部分截断并在提示词中说明。
export const MAX_PROJECT_INSTRUCTION_CHARS = 12_000;

// 读取工作区根目录的项目约定文件用于注入 system prompt。任何失败（不存在、不可读、
// 是目录）都返回 undefined，绝不阻塞启动。调用方负责先检查项目信任状态。
export async function collectProjectInstructionsContext(
  workspaceRoot: string
): Promise<ProjectInstructionsPromptContext | undefined> {
  for (const fileName of PROJECT_INSTRUCTION_FILE_NAMES) {
    const content = await readInstructionFile(path.join(workspaceRoot, fileName));
    if (content === undefined) {
      continue;
    }

    if (content.length <= MAX_PROJECT_INSTRUCTION_CHARS) {
      return { fileName, content, truncatedChars: 0 };
    }

    return {
      fileName,
      content: content.slice(0, MAX_PROJECT_INSTRUCTION_CHARS),
      truncatedChars: content.length - MAX_PROJECT_INSTRUCTION_CHARS
    };
  }

  return undefined;
}

async function readInstructionFile(filePath: string): Promise<string | undefined> {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      return undefined;
    }

    const raw = await fs.readFile(filePath, "utf8");
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}
