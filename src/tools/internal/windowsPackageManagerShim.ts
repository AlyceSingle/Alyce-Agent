import { containsJsPackageManagerInvocation } from "./jsPackageManagers.js";

const PACKAGE_MANAGER_COMMANDS = ["npm", "npx", "pnpm", "yarn", "corepack"] as const;

const WINDOWS_PACKAGE_MANAGER_SHIM_NOTICE =
  "Windows compatibility: package-manager commands resolve through .cmd shims when available to avoid blocked .ps1 launchers.";

export function getWindowsPackageManagerShimPreamble(): string[] {
  if (process.platform !== "win32") {
    return [];
  }

  return [
    "function __AlyceResolveCommandShim([string]$Name) {",
    "  $cmd = Get-Command \"$Name.cmd\" -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1",
    "  if ($cmd) { return $cmd.Source }",
    "  return $null",
    "}",
    ...PACKAGE_MANAGER_COMMANDS.flatMap((command) => [
      `$__alyce_${command} = __AlyceResolveCommandShim "${command}"`,
      `if ($__alyce_${command}) {`,
      `  Set-Alias -Name ${command} -Value $__alyce_${command} -Scope Local -Force -ErrorAction SilentlyContinue`,
      "}"
    ])
  ];
}

export function getWindowsPackageManagerShimNotice(command?: string): string | null {
  if (process.platform !== "win32") {
    return null;
  }

  if (command !== undefined && !containsJsPackageManagerInvocation(command)) {
    return null;
  }

  return WINDOWS_PACKAGE_MANAGER_SHIM_NOTICE;
}
