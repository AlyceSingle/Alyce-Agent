import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  sanitizePowerShellErrorOutput,
  wrapPowerShellCommand
} from "./commandOutput.js";
import {
  getWindowsPackageManagerShimNotice,
  getWindowsPackageManagerShimPreamble
} from "./windowsPackageManagerShim.js";

const PACKAGE_MANAGER_COMMANDS = ["npm", "npx", "pnpm", "yarn", "corepack"] as const;

function runTests() {
  testWindowsPreambleDefinesPackageManagerAliases();
  testNonWindowsReturnsNoShim();
  testPowerShellWrapperIncludesShimAfterUtf8Preamble();
  testPowerShellErrorSanitizerStripsFullPreamble();
  testWindowsShimPreservesFailedNativeExit();
  console.log("windowsPackageManagerShim tests passed");
}

function testWindowsPreambleDefinesPackageManagerAliases() {
  withPlatform("win32", () => {
    const script = getWindowsPackageManagerShimPreamble().join("\n");

    assert.ok(script.includes("function __AlyceResolveCommandShim"));
    assert.ok(script.includes("Get-Command \"$Name.cmd\""));
    assert.equal(script.includes("ExecutionPolicy"), false);
    for (const command of PACKAGE_MANAGER_COMMANDS) {
      assert.ok(script.includes(`__AlyceResolveCommandShim "${command}"`));
      assert.ok(script.includes(`Set-Alias -Name ${command} -Value $__alyce_${command}`));
    }

    assert.ok(getWindowsPackageManagerShimNotice()?.includes("Windows compatibility"));
    assert.ok(getWindowsPackageManagerShimNotice("corepack pnpm install")?.includes("Windows compatibility"));
    assert.ok(getWindowsPackageManagerShimNotice("Get-ChildItem | npm exec eslint")?.includes("Windows compatibility"));
    assert.equal(getWindowsPackageManagerShimNotice("git status"), null);
    assert.equal(getWindowsPackageManagerShimNotice("Get-Content yarn.lock"), null);
  });
}

function testNonWindowsReturnsNoShim() {
  withPlatform("linux", () => {
    assert.deepEqual(getWindowsPackageManagerShimPreamble(), []);
    assert.equal(getWindowsPackageManagerShimNotice(), null);
    assert.equal(wrapPowerShellCommand("npm run build"), "npm run build");
  });
}

function testPowerShellWrapperIncludesShimAfterUtf8Preamble() {
  withPlatform("win32", () => {
    const wrapped = wrapPowerShellCommand("npm run build");

    assert.ok(wrapped.startsWith("[Console]::InputEncoding"));
    assert.ok(wrapped.includes("chcp 65001 > $null\nfunction __AlyceResolveCommandShim"));
    assert.ok(wrapped.includes("Set-Alias -Name npm -Value $__alyce_npm"));
    assert.ok(wrapped.endsWith("\nnpm run build"));
    assert.equal(wrapped.includes("ExecutionPolicy"), false);
  });
}

function testPowerShellErrorSanitizerStripsFullPreamble() {
  withPlatform("win32", () => {
    const output = `${wrapPowerShellCommand("npm run build")}\nreal error`;
    assert.equal(sanitizePowerShellErrorOutput(output), "npm run build\nreal error");

    const crlfOutput = output.replace(/\n/g, "\r\n");
    assert.equal(sanitizePowerShellErrorOutput(crlfOutput), "npm run build\r\nreal error");
  });
}

function testWindowsShimPreservesFailedNativeExit() {
  if (process.platform !== "win32") {
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alyce ps npm shim "));
  const commandPath = path.join(tempDir, "npm.cmd");
  try {
    fs.writeFileSync(commandPath, "@echo off\r\nexit /b 7\r\n", "utf8");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", wrapPowerShellCommand("npm")], {
      env: { ...process.env, PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ""}` },
      windowsHide: true
    });

    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function withPlatform<T>(platform: NodeJS.Platform, callback: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform
  });

  try {
    return callback();
  } finally {
    if (descriptor) {
      Object.defineProperty(process, "platform", descriptor);
    }
  }
}

runTests();
