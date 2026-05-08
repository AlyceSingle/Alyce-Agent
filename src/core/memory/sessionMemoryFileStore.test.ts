import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionMemoryFileStore } from "./sessionMemoryFileStore.js";

async function runTests() {
  await testWriteAndReadSessionMemoryFile();
  await testReadStripsManagedMetadataComments();
  await testRestoreNullDeletesSessionMemoryFile();
  await testClearSessionDeletesSessionMemoryFile();
  console.log("sessionMemoryFileStore tests passed");
}

async function testWriteAndReadSessionMemoryFile() {
  const root = await mkdtemp(path.join(os.tmpdir(), "alyce-session-memory-"));
  try {
    const store = new SessionMemoryFileStore(root, ".alyce/memory", "SESSION_MEMORY.md");
    await store.write("# Session Memory\n\n## Current State\n\nReady.");

    const nextStore = new SessionMemoryFileStore(root, ".alyce/memory", "SESSION_MEMORY.md");
    const state = await nextStore.read();

    assert.equal(state?.markdown.includes("Ready."), true);
    assert.ok(state?.updatedAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testReadStripsManagedMetadataComments() {
  const root = await mkdtemp(path.join(os.tmpdir(), "alyce-session-memory-"));
  try {
    const store = new SessionMemoryFileStore(root, ".alyce/memory", "SESSION_MEMORY.md");
    await store.write("# Session Memory\n\n## Current State\n\nReady.");

    const nextStore = new SessionMemoryFileStore(root, ".alyce/memory", "SESSION_MEMORY.md");
    const state = await nextStore.read();

    assert.ok(state?.updatedAt);
    assert.equal(state?.markdown.startsWith("# Session Memory"), true);
    assert.equal(state?.markdown.includes("Alyce session memory"), false);
    assert.equal(state?.markdown.includes("Updated at:"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testRestoreNullDeletesSessionMemoryFile() {
  const root = await mkdtemp(path.join(os.tmpdir(), "alyce-session-memory-"));
  try {
    const filePath = path.join(root, ".alyce/memory", "SESSION_MEMORY.md");
    const store = new SessionMemoryFileStore(root, ".alyce/memory", "SESSION_MEMORY.md");
    await store.write("# Session Memory\n\nOld rewind state.");
    assert.equal(existsSync(filePath), true);

    await store.restoreSnapshot(null);

    assert.equal(existsSync(filePath), false);
    const nextStore = new SessionMemoryFileStore(root, ".alyce/memory", "SESSION_MEMORY.md");
    assert.equal(await nextStore.read(), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testClearSessionDeletesSessionMemoryFile() {
  const root = await mkdtemp(path.join(os.tmpdir(), "alyce-session-memory-"));
  try {
    const filePath = path.join(root, ".alyce/memory", "SESSION_MEMORY.md");
    const store = new SessionMemoryFileStore(root, ".alyce/memory", "SESSION_MEMORY.md");
    await store.write("# Session Memory\n\nOld clear state.");
    assert.equal(existsSync(filePath), true);

    await store.clearSession();

    assert.equal(existsSync(filePath), false);
    assert.equal(await store.read(), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void runTests();
