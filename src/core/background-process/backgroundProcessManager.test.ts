import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BackgroundProcessManager, resolveBackgroundCommandInvocation } from "./backgroundProcessManager.js";

async function runTests() {
  await testStartsShortCommandAndRecordsExit();
  await testStartsLongRunningProcessAndStopsIt();
  await testStartsDevServerFromReadyPortLine();
  await testCapturesPortConflictWarningWhenServerFallsBack();
  await testPortConflictExitReturnsFailedWithLastError();
  await testReadsLogTailAndOffsets();
  await testTailLinesPreserveCrLfAndByteOffset();
  await testMissingCwdReturnsFailedRecord();
  testWindowsPackageManagerFastPathUsesNativeArgv();
  console.log("backgroundProcessManager tests passed");
}

async function testStartsShortCommandAndRecordsExit() {
  await withTempWorkspace(async ({ workspaceRoot, storageRoot }) => {
    const manager = new BackgroundProcessManager({
      workspaceRoot,
      storageRoot,
      defaultStartupTimeoutMs: 1_000
    });

    const record = await manager.startProcess({
      command: nodeCommand("console.log('short-ok')")
    });

    assert.equal(record.status, "exited");
    assert.equal(record.exitCode, 0);
    assert.match(record.stdoutPreview, /short-ok/);
    assert.equal(await fs.readFile(record.combinedLogPath, "utf8"), "short-ok\n");
    assert.deepEqual(manager.listProcesses(), []);
    assert.equal(manager.listProcesses({ includeExited: true }).length, 1);
  });
}

async function testStartsLongRunningProcessAndStopsIt() {
  await withTempWorkspace(async ({ workspaceRoot, storageRoot }) => {
    const manager = new BackgroundProcessManager({
      workspaceRoot,
      storageRoot,
      defaultStartupTimeoutMs: 2_000
    });

    const script = [
      "console.log('Local: http://localhost:5173/');",
      "setInterval(() => undefined, 1000);"
    ].join("");
    const record = await manager.startProcess({
      command: nodeCommand(script),
      waitFor: ["Local:"]
    });

    assert.equal(record.status, "running");
    assert.match(record.id, /^bg_/);
    assert.ok(record.pid);
    assert.deepEqual(record.detectedUrls, ["http://localhost:5173/"]);
    assert.deepEqual(record.detectedPorts, [5173]);
    assert.equal(record.startupMatched, "Local:");

    const listed = manager.listProcesses();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, record.id);

    const stopped = await manager.stopProcess(record.id, { gracefulTimeoutMs: 1_000 });
    assert.equal(stopped.status, "stopped");
    assert.equal(manager.getProcess(record.id)?.status, "stopped");
  });
}

async function testStartsDevServerFromReadyPortLine() {
  await withTempWorkspace(async ({ workspaceRoot, storageRoot }) => {
    const manager = new BackgroundProcessManager({
      workspaceRoot,
      storageRoot,
      defaultStartupTimeoutMs: 2_000
    });

    const script = [
      "console.log('ready started server on 0.0.0.0:3000');",
      "setInterval(() => undefined, 1000);"
    ].join("");
    const record = await manager.startProcess({
      command: nodeCommand(script)
    });

    try {
      assert.equal(record.status, "running");
      assert.deepEqual(record.detectedPorts, [3000]);
      assert.equal(record.startupMatched, "ready started server on");
    } finally {
      await manager.stopProcess(record.id, { gracefulTimeoutMs: 2_000 });
    }
  });
}

async function testCapturesPortConflictWarningWhenServerFallsBack() {
  await withTempWorkspace(async ({ workspaceRoot, storageRoot }) => {
    const manager = new BackgroundProcessManager({
      workspaceRoot,
      storageRoot,
      defaultStartupTimeoutMs: 2_000
    });

    const script = [
      "console.error('Port 5173 is in use, trying another one...');",
      "console.log('Local: http://localhost:5174/');",
      "setInterval(() => undefined, 1000);"
    ].join("");
    const record = await manager.startProcess({
      command: nodeCommand(script)
    });

    try {
      assert.equal(record.status, "running");
      assert.deepEqual(record.detectedUrls, ["http://localhost:5174/"]);
      assert.deepEqual(record.detectedPorts, [5173, 5174]);
      assert.deepEqual(record.warnings, ["Port 5173 is already in use."]);
    } finally {
      await manager.stopProcess(record.id, { gracefulTimeoutMs: 2_000 });
    }
  });
}

async function testPortConflictExitReturnsFailedWithLastError() {
  await withTempWorkspace(async ({ workspaceRoot, storageRoot }) => {
    const manager = new BackgroundProcessManager({
      workspaceRoot,
      storageRoot,
      defaultStartupTimeoutMs: 2_000
    });

    const record = await manager.startProcess({
      command: nodeCommand(
        "console.error('Error: listen EADDRINUSE: address already in use 127.0.0.1:5173'); process.exit(1);"
      )
    });

    assert.equal(record.status, "failed");
    assert.deepEqual(record.detectedPorts, [5173]);
    assert.deepEqual(record.warnings, ["Port 5173 is already in use (EADDRINUSE)."]);
    assert.equal(record.lastError, "Port 5173 is already in use (EADDRINUSE).");
  });
}

async function testReadsLogTailAndOffsets() {
  await withTempWorkspace(async ({ workspaceRoot, storageRoot }) => {
    const manager = new BackgroundProcessManager({
      workspaceRoot,
      storageRoot,
      defaultStartupTimeoutMs: 1_000
    });
    const script = "console.log('one'); console.log('two'); console.log('three');";
    const record = await manager.startProcess({
      command: nodeCommand(script)
    });

    const tail = await manager.readProcessLog(record.id, {
      stream: "combined",
      tailLines: 2
    });
    assert.match(tail.content, /two/);
    assert.match(tail.content, /three/);

    const slice = await manager.readProcessLog(record.id, {
      stream: "stdout",
      offset: 8,
      limit: 5
    });
    assert.equal(slice.content, "three");
    assert.equal(slice.eof, false);
  });
}

async function testTailLinesPreserveCrLfAndByteOffset() {
  await withTempWorkspace(async ({ workspaceRoot, storageRoot }) => {
    const manager = new BackgroundProcessManager({
      workspaceRoot,
      storageRoot,
      defaultStartupTimeoutMs: 1_000
    });
    const record = await manager.startProcess({
      command: nodeCommand("process.stdout.write('one\\r\\ntwo\\r\\nthree\\r\\n');")
    });

    const tail = await manager.readProcessLog(record.id, {
      stream: "stdout",
      tailLines: 2
    });
    assert.equal(tail.content, "two\r\nthree\r\n");
    assert.equal(tail.offset, Buffer.byteLength("one\r\n", "utf8"));
    assert.equal(tail.eof, true);
  });
}

async function testMissingCwdReturnsFailedRecord() {
  await withTempWorkspace(async ({ workspaceRoot, storageRoot }) => {
    const manager = new BackgroundProcessManager({
      workspaceRoot,
      storageRoot,
      defaultStartupTimeoutMs: 1_000
    });
    const record = await manager.startProcess({
      command: nodeCommand("console.log('should-not-run')"),
      cwd: "missing"
    });

    assert.equal(record.status, "failed");
    assert.match(record.lastError ?? "", /Working directory does not exist/);
    assert.equal(manager.listProcesses({ includeExited: true }).length, 0);
  });
}

function testWindowsPackageManagerFastPathUsesNativeArgv() {
  const invocation = resolveBackgroundCommandInvocation("npm run dev", {
    platform: "win32",
    existsSync: () => false
  });

  assert.equal(invocation.mode, "native-argv");
  assert.match(invocation.executable, /cmd\.exe$/i);
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(invocation.args[3] ?? "", /npm\.cmd run dev/i);
}

async function withTempWorkspace(callback: (paths: {
  workspaceRoot: string;
  storageRoot: string;
}) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-bg-process-"));
  const workspaceRoot = path.join(root, "workspace");
  const storageRoot = path.join(root, "background-processes");
  await fs.mkdir(workspaceRoot, { recursive: true });

  try {
    await callback({ workspaceRoot, storageRoot });
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function nodeCommand(script: string): string {
  if (process.platform === "win32") {
    return `& ${powerShellQuote(process.execPath)} -e ${powerShellQuote(script)}`;
  }

  return `${posixQuote(process.execPath)} -e ${posixQuote(script)}`;
}

function powerShellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function posixQuote(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replace(/"/g, "\\\"")}"`;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
