import { randomUUID } from "node:crypto";
import type { MemoryEntry, MemorySource } from "./types.js";

// 会话记忆仅驻留在当前进程，用于当前会话上下文强化。
export class SessionMemoryStore {
  private readonly entries: MemoryEntry[] = [];

  constructor(private readonly maxEntries: number) {}

  add(content: string, source: MemorySource): MemoryEntry {
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

    return entry;
  }

  list(limit = this.maxEntries): MemoryEntry[] {
    return this.entries.slice(-Math.max(1, limit));
  }

  clear() {
    this.entries.length = 0;
  }

  private trimToLimit() {
    if (this.entries.length <= this.maxEntries) {
      return;
    }

    this.entries.splice(0, this.entries.length - this.maxEntries);
  }
}

function normalizeNote(note: string): string {
  return note.replace(/\s+/g, " ").trim();
}
