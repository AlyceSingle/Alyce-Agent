import assert from "node:assert/strict";
import path from "node:path";
import {
  buildCmdExeCommandLine,
  isWindowsBatchCommand,
  resolveNpmArgvForWindows,
  resolveTrustedWindowsCmdExe,
  resolveWindowsCommandShim,
  resolveWindowsNativeCommandInvocation
} from "./windowsNativeCommand.js";

function runTests() {
  testResolvesCmdShimOnlyOnWindows();
  testResolvesNpmToNodeCliWhenAvailable();
  testResolvesNpmToCmdFallbackWhenCliIsMissing();
  testExplicitNpmPathIsNotRewrittenToNodeCli();
  testWrapsBatchCommandWithTrustedCmdExe();
  testDirectCommandsStayDirect();
  testTrustedCmdExeIgnoresComSpecAndRejectsUnsafeRoots();
  testCmdExeCommandLineQuotesAndRejectsUnsafeArgs();
  console.log("windowsNativeCommand tests passed");
}

function testResolvesCmdShimOnlyOnWindows() {
  assert.equal(resolveWindowsCommandShim("pnpm", ["pnpm"], "win32"), "pnpm.cmd");
  assert.equal(resolveWindowsCommandShim("pnpm", ["pnpm"], "linux"), "pnpm");
  assert.equal(resolveWindowsCommandShim("pnpm.exe", ["pnpm"], "win32"), "pnpm.exe");
  assert.equal(resolveWindowsCommandShim("npm", ["pnpm"], "win32"), "npm");
}

function testResolvesNpmToNodeCliWhenAvailable() {
  const execPath = "C:\\Program Files\\nodejs\\node.exe";
  const cliPath = path.win32.join(
    path.win32.dirname(execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js"
  );

  assert.deepEqual(
    resolveNpmArgvForWindows(["npm", "--version"], {
      platform: "win32",
      execPath,
      existsSync: (filePath) => filePath === cliPath
    }),
    [execPath, cliPath, "--version"]
  );
}

function testResolvesNpmToCmdFallbackWhenCliIsMissing() {
  assert.deepEqual(
    resolveNpmArgvForWindows(["npm", "--version"], {
      platform: "win32",
      execPath: "C:\\node\\node.exe",
      existsSync: () => false
    }),
    ["npm.cmd", "--version"]
  );
  assert.deepEqual(
    resolveNpmArgvForWindows(["npx", "tsx", "--version"], {
      platform: "win32",
      execPath: "C:\\node\\node.exe",
      existsSync: () => false
    }),
    ["npx.cmd", "tsx", "--version"]
  );
  assert.equal(resolveNpmArgvForWindows(["npm", "--version"], { platform: "linux" }), null);
  assert.equal(resolveNpmArgvForWindows(["pnpm", "--version"], { platform: "win32" }), null);
}

function testExplicitNpmPathIsNotRewrittenToNodeCli() {
  assert.equal(
    resolveNpmArgvForWindows(["C:\\Tools\\npm.cmd", "--version"], {
      platform: "win32",
      execPath: "C:\\node\\node.exe",
      existsSync: () => true
    }),
    null
  );

  const invocation = resolveWindowsNativeCommandInvocation(["C:\\Tools\\npm.cmd", "--version"], {
    platform: "win32",
    env: {
      SystemRoot: "C:\\Windows"
    },
    execPath: "C:\\node\\node.exe",
    existsSync: () => true
  });

  assert.equal(invocation.command, path.win32.join("C:\\Windows", "System32", "cmd.exe"));
  assert.deepEqual(invocation.args, ["/d", "/s", "/c", "\"C:\\Tools\\npm.cmd --version\""]);
}

function testWrapsBatchCommandWithTrustedCmdExe() {
  const invocation = resolveWindowsNativeCommandInvocation(["pnpm", "--version"], {
    platform: "win32",
    env: {
      ComSpec: "D:\\evil\\cmd.exe",
      SystemRoot: "C:\\Windows"
    }
  });

  assert.equal(invocation.command, path.win32.join("C:\\Windows", "System32", "cmd.exe"));
  assert.deepEqual(invocation.args, ["/d", "/s", "/c", "\"pnpm.cmd --version\""]);
  assert.equal(invocation.windowsHide, true);
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.equal(invocation.usesWindowsExitCodeShim, true);
}

function testDirectCommandsStayDirect() {
  assert.deepEqual(resolveWindowsNativeCommandInvocation(["node", "--version"], { platform: "win32" }), {
    command: "node",
    args: ["--version"],
    windowsHide: true,
    usesWindowsExitCodeShim: false
  });
  assert.equal(isWindowsBatchCommand("tool.cmd", "win32"), true);
  assert.equal(isWindowsBatchCommand("tool.cmd", "linux"), false);
}

function testTrustedCmdExeIgnoresComSpecAndRejectsUnsafeRoots() {
  assert.equal(
    resolveTrustedWindowsCmdExe({
      ComSpec: "D:\\evil\\cmd.exe",
      SystemRoot: "C:\\Windows"
    }),
    path.win32.join("C:\\Windows", "System32", "cmd.exe")
  );
  assert.equal(
    resolveTrustedWindowsCmdExe({
      ComSpec: "D:\\evil\\cmd.exe",
      SystemRoot: "\\\\evil\\share",
      WINDIR: "relative\\Windows"
    }),
    path.win32.join("C:\\Windows", "System32", "cmd.exe")
  );
  assert.equal(
    resolveTrustedWindowsCmdExe({
      SYSTEMROOT: "D:\\Windows\\"
    }),
    path.win32.join("D:\\Windows", "System32", "cmd.exe")
  );
  assert.equal(
    resolveTrustedWindowsCmdExe({
      SystemRoot: "C:\\Windows\0bad",
      WINDIR: "C:\\Windows;C:\\evil"
    }),
    path.win32.join("C:\\Windows", "System32", "cmd.exe")
  );
}

function testCmdExeCommandLineQuotesAndRejectsUnsafeArgs() {
  assert.equal(
    buildCmdExeCommandLine("C:\\Program Files\\nodejs\\pnpm.cmd", ["run", "my script"]),
    "\"\"C:\\Program Files\\nodejs\\pnpm.cmd\" run \"my script\"\""
  );
  assert.throws(
    () => buildCmdExeCommandLine("pnpm.cmd", ["install", "left&right"]),
    /Unsafe Windows cmd\.exe argument/
  );
  assert.throws(
    () => buildCmdExeCommandLine("pnpm.cmd", ["install", "left\0right"]),
    /Unsafe Windows cmd\.exe argument/
  );
}

runTests();
