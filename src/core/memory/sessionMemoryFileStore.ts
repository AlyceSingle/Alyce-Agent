import { promises as fs } from "node:fs";
import path from "node:path";
import type { SessionMemoryFileState } from "./types.js";

export class SessionMemoryFileStore {
  private initialized = false;
  private state: SessionMemoryFileState | null = null;

  constructor(
    private readonly workspaceRoot: string,
    private readonly directory: string,
    private readonly fileName: string
  ) {}

  async initialize() {
    if (this.initialized) {
      return;
    }

    const filePath = this.getFilePath();
    try {
      const raw = await fs.readFile(filePath, "utf8");
      this.state = parseSessionMemoryFile(raw);
    } catch (error) {
      const isMissing =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: string }).code === "ENOENT";

      if (!isMissing) {
        throw error;
      }
    }

    this.initialized = true;
  }

  async read(): Promise<SessionMemoryFileState | null> {
    await this.initialize();
    return this.state ? { ...this.state } : null;
  }

  async write(markdown: string) {
    await this.initialize();
    const normalized = normalizeSessionMemoryMarkdown(markdown);
    this.state = {
      markdown: normalized,
      updatedAt: new Date().toISOString()
    };
    await this.persist();
  }

  createSnapshot(): SessionMemoryFileState | null {
    return this.state ? { ...this.state } : null;
  }

  async restoreSnapshot(snapshot: SessionMemoryFileState | null) {
    this.state = snapshot ? { ...snapshot } : null;
    this.initialized = true;
    if (this.state) {
      await this.persist();
      return;
    }

    // Rewind/clear with no session memory must remove the managed file too,
    // otherwise a later startup would resurrect stale memory from disk.
    await this.deleteFile();
  }

  async clearSession() {
    this.state = null;
    this.initialized = true;
    await this.deleteFile();
  }

  getRelativeFilePath() {
    return path.join(this.directory, this.fileName);
  }

  private async persist() {
    if (!this.state) {
      return;
    }

    const absoluteDirectory = path.resolve(this.workspaceRoot, this.directory);
    await fs.mkdir(absoluteDirectory, { recursive: true });
    await fs.writeFile(this.getFilePath(), serializeSessionMemoryFile(this.state), "utf8");
  }

  private getFilePath() {
    return path.resolve(this.workspaceRoot, this.directory, this.fileName);
  }

  private async deleteFile() {
    try {
      await fs.unlink(this.getFilePath());
    } catch (error) {
      const isMissing =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: string }).code === "ENOENT";

      if (!isMissing) {
        throw error;
      }
    }
  }
}

function parseSessionMemoryFile(raw: string): SessionMemoryFileState | null {
  const updatedAt = parseUpdatedAt(raw);
  const normalized = normalizeSessionMemoryMarkdown(stripManagedComments(raw));
  if (!normalized) {
    return null;
  }

  return {
    markdown: normalized,
    updatedAt
  };
}

function serializeSessionMemoryFile(state: SessionMemoryFileState) {
  const lines = [
    "<!-- Alyce session memory. Do not edit unless you want to override the session memory state. -->",
    `<!-- Updated at: ${state.updatedAt ?? new Date().toISOString()} -->`,
    "",
    state.markdown
  ];

  return lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trimEnd() + "\n";
}

function parseUpdatedAt(markdown: string): string | undefined {
  const matched = /<!--\s*Updated at:\s*([^>]+?)\s*-->/.exec(markdown);
  const raw = matched?.[1]?.trim();
  if (!raw) {
    return undefined;
  }

  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function normalizeSessionMemoryMarkdown(markdown: string) {
  return markdown.replace(/\r\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
}

function stripManagedComments(markdown: string) {
  return markdown
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !/^<!--\s*(?:Alyce session memory\.|Updated at:)/i.test(line.trim()))
    .join("\n");
}
