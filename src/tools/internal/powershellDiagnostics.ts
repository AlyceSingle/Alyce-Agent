const POWERSHELL_EXECUTION_POLICY_DIAGNOSTIC =
  "PowerShell blocked a .ps1 launcher by execution policy. Alyce normally routes common package-manager commands through .cmd shims on Windows. If this command used an explicit .ps1 path, use npm.cmd/pnpm.cmd/yarn.cmd/npx.cmd/corepack.cmd or remove the explicit .ps1 target.";

export function appendPowerShellExecutionPolicyDiagnostic(output: string): string {
  const diagnostic = getPowerShellExecutionPolicyDiagnostic(output);
  if (!diagnostic || output.includes(diagnostic)) {
    return output;
  }

  const newline = output.includes("\r\n") ? "\r\n" : "\n";
  const separator = output.endsWith("\n") ? newline : `${newline}${newline}`;
  return `${output}${separator}${diagnostic}`;
}

export function getPowerShellExecutionPolicyDiagnostic(output: string): string | null {
  return isPowerShellExecutionPolicyError(output)
    ? POWERSHELL_EXECUTION_POLICY_DIAGNOSTIC
    : null;
}

function isPowerShellExecutionPolicyError(output: string): boolean {
  const lower = output.toLowerCase();
  if (!lower.includes(".ps1")) {
    return false;
  }

  const compactLower = lower.replace(/\s+/g, "");
  return (
    compactLower.includes("pssecurityexception") ||
    compactLower.includes("execution_policies") ||
    (lower.includes("cannot be loaded") && lower.includes("running scripts is disabled")) ||
    (lower.includes("无法加载文件") && lower.includes("禁止运行脚本"))
  );
}
