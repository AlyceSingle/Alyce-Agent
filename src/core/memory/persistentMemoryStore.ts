import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { MemoryEntry, MemorySource } from "./types.js";

const MEMORY_LINE_PATTERN = /^- \[(?<createdAt>[^\]]+)\] \((?<source>user|assistant|system)\) (?<content>.+)$/;

// 持久记忆采用 markdown 文件存储，便于人工审查和版本管理。
export class PersistentMemoryStore {
  private entries: MemoryEntry[] = [];
  private initialized = false;

  constructor(
    private readonly workspaceRoot: string,
    private readonly directory: string,
    private readonly fileName: string,
    private readonly maxEntries: number
  ) {}

  async initialize() {
    if (this.initialized) {
      return;
    }

    const filePath = this.getFilePath();
    try {
      const raw = await fs.readFile(filePath, "utf8");
      this.entries = parseMemoryFile(raw);
      this.trimToLimit();
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

  async add(content: string, source: MemorySource): Promise<MemoryEntry> {
    await this.initialize();

    const normalized = normalizeNote(content);
    if (!normalized) {
      throw new Error("Memory note cannot be empty");
    }

    const entry: MemoryEntry = {
      id: randomUUID(),
      content: normalized,
      source,
      createdAt: new Date().toISOString()
    };

    this.entries.push(entry);
    this.trimToLimit();
    await this.persist();

    return entry;
  }

  async list(limit = this.maxEntries): Promise<MemoryEntry[]> {
    await this.initialize();
    return this.entries.slice(-Math.max(1, limit));
  }

  async clear() {
    await this.initialize();
    this.entries = [];
    await this.persist();
  }

  getRelativeFilePath() {
    return path.join(this.directory, this.fileName);
  }

  private async persist() {
    const absoluteDirectory = path.resolve(this.workspaceRoot, this.directory);
    const filePath = this.getFilePath();

    await fs.mkdir(absoluteDirectory, { recursive: true });
    await fs.writeFile(filePath, serializeMemoryFile(this.entries), "utf8");
  }

  private trimToLimit() {
    if (this.entries.length <= this.maxEntries) {
      return;
    }

    this.entries.splice(0, this.entries.length - this.maxEntries);
  }

  private getFilePath() {
    return path.resolve(this.workspaceRoot, this.directory, this.fileName);
  }
}

function parseMemoryFile(raw: string): MemoryEntry[] {
  const parsed: Array<MemoryEntry | null> = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- ["))
    .map((line) => {
      const matched = MEMORY_LINE_PATTERN.exec(line);
      if (!matched?.groups) {
        return null;
      }

      const createdAt = matched.groups.createdAt;
      const source = matched.groups.source as MemorySource;
      const content = matched.groups.content.trim();

      if (!content) {
        return null;
      }

      return {
        id: randomUUID(),
        content,
        source,
        createdAt: normalizeDate(createdAt)
      };
    });

  return parsed.filter((entry): entry is MemoryEntry => entry !== null);
}

function serializeMemoryFile(entries: MemoryEntry[]) {
  const header = [
    "# Persistent Memory",
    "",
    "- 由 /remember 写入，格式：- [ISO时间] (来源) 内容",
    ""
  ].join("\n");

  const lines = entries.map((entry) => `- [${entry.createdAt}] (${entry.source}) ${entry.content}`);
  return [header, ...lines, ""].join("\n");
}

function normalizeNote(note: string): string {
  return note.replace(/\s+/g, " ").trim();
}

function normalizeDate(raw: string): string {
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) {
    return new Date().toISOString();
  }

  return new Date(timestamp).toISOString();
}
