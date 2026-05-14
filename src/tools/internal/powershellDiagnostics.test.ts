import assert from "node:assert/strict";
import {
  sanitizePowerShellErrorOutput,
  wrapPowerShellCommand
} from "./commandOutput.js";
import {
  appendPowerShellExecutionPolicyDiagnostic,
  getPowerShellExecutionPolicyDiagnostic
} from "./powershellDiagnostics.js";

function runTests() {
  testEnglishExecutionPolicyErrorGetsDiagnostic();
  testChineseExecutionPolicyErrorGetsDiagnostic();
  testUnrelatedPs1ErrorIsUnchanged();
  testDiagnosticIsNotDuplicated();
  testSanitizerStripsPreambleBeforeAddingDiagnostic();
  console.log("powershellDiagnostics tests passed");
}

function testEnglishExecutionPolicyErrorGetsDiagnostic() {
  const output = [
    "npm : File C:\\Program Files\\nodejs\\npm.ps1 cannot be loaded because running scripts is disabled on this system.",
    "For more information, see about_Execution_Policies.",
    "FullyQualifiedErrorId : UnauthorizedAccess"
  ].join("\n");

  const diagnostic = getPowerShellExecutionPolicyDiagnostic(output);
  assert.ok(diagnostic?.includes("PowerShell blocked a .ps1 launcher"));
  assert.ok(diagnostic?.includes("npm.cmd/pnpm.cmd/yarn.cmd/npx.cmd/corepack.cmd"));
  assert.equal(diagnostic?.includes("Set-ExecutionPolicy"), false);
  assert.equal(diagnostic?.includes("Bypass"), false);

  const withDiagnostic = appendPowerShellExecutionPolicyDiagnostic(output);
  assert.ok(withDiagnostic.includes(output));
  assert.ok(withDiagnostic.includes(diagnostic ?? ""));
}

function testChineseExecutionPolicyErrorGetsDiagnostic() {
  const output = [
    "npm : 无法加载文件 D:\\nvm4w\\nodejs\\npm.ps1，因为在此系统上禁止运行脚本。",
    "有关详细信息，请参阅 about_Execution_Policies。",
    "FullyQualifiedErrorId : UnauthorizedAccess,Microsoft.PowerShell.Commands.GetCommandCommand",
    "PSSecurityException"
  ].join("\n");

  assert.ok(getPowerShellExecutionPolicyDiagnostic(output)?.includes("PowerShell blocked"));
}

function testUnrelatedPs1ErrorIsUnchanged() {
  const output = ".\\missing.ps1 : The term '.\\missing.ps1' is not recognized.";

  assert.equal(getPowerShellExecutionPolicyDiagnostic(output), null);
  assert.equal(appendPowerShellExecutionPolicyDiagnostic(output), output);
}

function testDiagnosticIsNotDuplicated() {
  const output = [
    "npm.ps1 cannot be loaded because running scripts is disabled on this system.",
    getPowerShellExecutionPolicyDiagnostic(
      "npm.ps1 cannot be loaded because running scripts is disabled on this system."
    )
  ].join("\n\n");

  assert.equal(appendPowerShellExecutionPolicyDiagnostic(output), output);
}

function testSanitizerStripsPreambleBeforeAddingDiagnostic() {
  withPlatform("win32", () => {
    const executionPolicyError = [
      ".\\npm.ps1 cannot be loaded because running scripts is disabled on this system.",
      "For more information, see about_Execution_Policies."
    ].join("\n");
    const sanitized = sanitizePowerShellErrorOutput(
      `${wrapPowerShellCommand(".\\npm.ps1")}\n${executionPolicyError}`
    );

    assert.equal(sanitized.includes("function __AlyceResolveCommandShim"), false);
    assert.ok(sanitized.startsWith(".\\npm.ps1\n.\\npm.ps1 cannot be loaded"));
    assert.ok(sanitized.includes("PowerShell blocked a .ps1 launcher"));
  });
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
