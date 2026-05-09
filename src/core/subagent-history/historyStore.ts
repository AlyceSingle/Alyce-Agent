import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  SubagentMetadataV1,
  SubagentTranscriptEntry
} from "./types.js";

export class SubagentHistoryStore {
  private readonly writeQueues = new Map<string, Promise<void>>();

  async writeMetadata(metadataPath: string, metadata: SubagentMetadataV1): Promise<void> {
    await this.enqueueWrite(metadataPath, async () => {
      await fs.mkdir(path.dirname(metadataPath), { recursive: true });
      await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf8");
    });
  }

  async readMetadata(metadataPath: string): Promise<SubagentMetadataV1 | undefined> {
    try {
      const raw = await fs.readFile(metadataPath, "utf8");
      return JSON.parse(raw) as SubagentMetadataV1;
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined;
      }

      throw error;
    }
  }

  async appendTranscriptEntries(
    transcriptPath: string,
    entries: SubagentTranscriptEntry[]
  ): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    const payload = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    await this.enqueueWrite(transcriptPath, async () => {
      await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
      await fs.appendFile(transcriptPath, payload, "utf8");
    });
  }

  async writeOutput(outputPath: string, output: string): Promise<void> {
    await this.enqueueWrite(outputPath, async () => {
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, output, "utf8");
    });
  }

  async readOutput(outputPath: string): Promise<string | undefined> {
    try {
      return await fs.readFile(outputPath, "utf8");
    } catch (error) {
      // 输出文件是可选工件，缺失时按“暂无输出”处理，而不是抛异常中断 TaskGet。
      if (isMissingFileError(error)) {
        return undefined;
      }

      throw error;
    }
  }

  async readTranscriptEntries(transcriptPath: string): Promise<SubagentTranscriptEntry[]> {
    let raw: string;
    try {
      raw = await fs.readFile(transcriptPath, "utf8");
    } catch (error) {
      // transcript 不存在通常代表任务尚未产生可持久化消息，按空数组处理。
      if (isMissingFileError(error)) {
        return [];
      }

      throw error;
    }

    return parseTranscriptLines(raw);
  }

  async readTranscriptEntriesRequired(transcriptPath: string): Promise<SubagentTranscriptEntry[]> {
    try {
      const raw = await fs.readFile(transcriptPath, "utf8");
      return parseTranscriptLines(raw);
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new Error(`Subagent transcript not found: ${transcriptPath}`);
      }

      throw error;
    }
  }

  private enqueueWrite(targetPath: string, action: () => Promise<void>): Promise<void> {
    const queued = this.writeQueues.get(targetPath) ?? Promise.resolve();
    const next = queued
      .catch(() => undefined)
      .then(action);
    const tracked = next.catch(() => undefined);
    this.writeQueues.set(targetPath, tracked);
    void tracked.finally(() => {
      if (this.writeQueues.get(targetPath) === tracked) {
        this.writeQueues.delete(targetPath);
      }
    });
    return next;
  }
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
  );
}

function parseTranscriptLines(raw: string): SubagentTranscriptEntry[] {
  const entries: SubagentTranscriptEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as SubagentTranscriptEntry;
      if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
        entries.push(parsed);
      }
    } catch {
      // 单行损坏时软跳过，避免整份 transcript 因一个坏行完全不可读。
    }
  }

  return entries;
}
