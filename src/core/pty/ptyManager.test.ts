import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PtyManager } from "./ptyManager.js";

async function runTests() {
  await testCreatesReadsWritesAndClosesPtySession();
  await testReadCursorTailAndLimit();
  testTailLinesPreservesCursorAndCrLf();
  await testResizeUpdatesSessionInfo();
  await testMissingCwdReturnsFailedSession();
  console.log("ptyManager tests passed");
}

async function testCreatesReadsWritesAndClosesPtySession() {
  await withTempWorkspace(async ({ workspaceRoot }) => {
    const manager = new PtyManager({ workspaceRoot });
    const session = manager.createSession({
      command: process.execPath,
      args: [
        "-e",
        [
          "process.stdout.write('ready\\n');",
          "process.stdin.setEncoding('utf8');",
          "if (process.stdin.isTTY) process.stdin.setRawMode(true);",
          "process.stdin.resume();",
          "process.stdin.on('data', (chunk) => process.stdout.write('echo:' + chunk));"
        ].join("")
      ],
      title: "node fixture"
    });

    try {
      assert.equal(session.status, "running");
      assert.equal(session.title, "node fixture");
      assert.ok(session.pid === null || session.pid > 0);
      assert.match(await waitForContent(manager, session.id, /ready/), /ready/);

      const written = manager.writeSession(session.id, "hello\n");
      assert.equal(written.bytes, 6);
      assert.match(await waitForContent(manager, session.id, /echo:hello/), /echo:hello/);

      const closed = manager.closeSession(session.id);
      assert.equal(closed.status, "closed");
      assert.equal(manager.getSession(session.id), undefined);
    } finally {
      manager.closeAll();
    }
  });
}

async function testReadCursorTailAndLimit() {
  await withTempWorkspace(async ({ workspaceRoot }) => {
    const manager = new PtyManager({ workspaceRoot, bufferLimit: 256 });
    const session = manager.createSession({
      command: process.execPath,
      args: ["-e", "console.log('one'); console.log('two'); setInterval(() => undefined, 1000);"]
    });

    try {
      await waitForContent(manager, session.id, /two/);
      const first = manager.readSession(session.id, { cursor: 0, limit: 3 });
      assert.equal(first.content.length, 3);
      assert.equal(first.nextCursor, first.cursor + 3);

      const tail = manager.readSession(session.id, { tailLines: 1 });
      assert.match(tail.content, /two/);

      const end = manager.readSession(session.id, { cursor: -1 });
      assert.equal(end.content, "");
      assert.equal(end.eof, true);
    } finally {
      manager.closeAll();
    }
  });
}

async function testResizeUpdatesSessionInfo() {
  await withTempWorkspace(async ({ workspaceRoot }) => {
    const manager = new PtyManager({ workspaceRoot });
    const session = manager.createSession({
      command: process.execPath,
      args: ["-e", "setInterval(() => undefined, 1000);"],
      cols: 80,
      rows: 24
    });

    try {
      const resized = manager.resizeSession(session.id, 100, 30);
      assert.equal(resized.cols, 100);
      assert.equal(resized.rows, 30);
      assert.equal(manager.getSession(session.id)?.cols, 100);
      assert.equal(manager.getSession(session.id)?.rows, 30);
    } finally {
      manager.closeAll();
    }
  });
}

function testTailLinesPreservesCursorAndCrLf() {
  const workspaceRoot = process.cwd();
  const manager = new PtyManager({ workspaceRoot });
  const buffer = "one\r\ntwo\r\nthree\r\n";
  const bufferCursor = 100;
  const sessions = (manager as unknown as {
    sessions: Map<string, {
      info: ReturnType<PtyManager["createSession"]>;
      process: unknown;
      buffer: string;
      bufferCursor: number;
      cursor: number;
    }>;
  }).sessions;
  sessions.set("pty_test", {
    info: {
      id: "pty_test",
      title: "fixture",
      command: process.execPath,
      args: [],
      cwd: workspaceRoot,
      status: "running",
      pid: null,
      cols: 80,
      rows: 24,
      createdAt: "2026-05-10T00:00:00.000Z",
      updatedAt: "2026-05-10T00:00:00.000Z"
    },
    process: {},
    buffer,
    bufferCursor,
    cursor: bufferCursor + buffer.length
  });

  const result = manager.readSession("pty_test", { tailLines: 2 });
  assert.equal(result.content, "two\r\nthree\r\n");
  assert.equal(result.cursor, bufferCursor + "one\r\n".length);
  assert.equal(result.nextCursor, bufferCursor + buffer.length);
}

async function testMissingCwdReturnsFailedSession() {
  await withTempWorkspace(async ({ workspaceRoot }) => {
    const manager = new PtyManager({ workspaceRoot });
    const session = manager.createSession({
      command: process.execPath,
      args: ["-e", "console.log('should-not-run')"],
      cwd: "missing"
    });

    assert.equal(session.status, "failed");
    assert.match(session.lastError ?? "", /Working directory does not exist/);
    assert.equal(manager.getSession(session.id), undefined);
  });
}

async function waitForContent(
  manager: PtyManager,
  sessionId: string,
  pattern: RegExp,
  timeoutMs = 5_000
): Promise<string> {
  const started = Date.now();
  let lastContent = "";
  while (Date.now() - started < timeoutMs) {
    lastContent = manager.readSession(sessionId, { cursor: 0 }).content;
    if (pattern.test(lastContent)) {
      return lastContent;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for ${pattern}; last content:\n${lastContent}`);
}

async function withTempWorkspace(callback: (paths: {
  workspaceRoot: string;
}) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-pty-"));
  const workspaceRoot = path.join(root, "workspace");
  await fs.mkdir(workspaceRoot, { recursive: true });

  try {
    await callback({ workspaceRoot });
  } finally {
    await delay(250);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
