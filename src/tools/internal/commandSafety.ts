import os from "node:os";
import {
  JS_PACKAGE_MANAGER_BUILD_TEST_PATTERN,
  JS_PACKAGE_MANAGER_INSTALL_PATTERN
} from "./jsPackageManagers.js";

export type CommandDialect = "shell" | "powershell";

export type CommandRiskCategory =
  | "safe-read-only"
  | "build-test"
  | "package-install"
  | "network"
  | "file-mutation"
  | "destructive"
  | "arbitrary-interpreter"
  | "unknown";

export type CommandRiskLevel = "low" | "medium" | "high" | "critical";

export type CommandSafetyAction = "ask" | "deny";

export interface CommandSafetyAnalysis {
  dialect: CommandDialect;
  normalizedCommand: string;
  category: CommandRiskCategory;
  level: CommandRiskLevel;
  action: CommandSafetyAction;
  forceAsk: boolean;
  reasons: string[];
  possibleWrites: string[];
  possibleWritePaths: string[];
  unknownWriteReason?: string;
  usesWildcard: boolean;
  usesDynamicExpression: boolean;
  ruleRecommendation: string;
  permissionPattern: string;
}

interface CommandRule {
  category: CommandRiskCategory;
  level: CommandRiskLevel;
  action?: CommandSafetyAction;
  forceAsk?: boolean;
  reason: string;
  pattern: RegExp;
  possibleWrites?: string[];
  ruleRecommendation?: string;
}

const BASH_DENY_RULES: CommandRule[] = [
  {
    category: "destructive",
    level: "critical",
    action: "deny",
    forceAsk: true,
    reason: "Attempts to recursively delete the filesystem root.",
    pattern: /\brm\s+(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r|--recursive\s+--force|--force\s+--recursive)\s+(?:\/|\/\*)\b/i,
    possibleWrites: ["filesystem root"],
    ruleRecommendation: "Do not save an allow rule for root deletion."
  },
  {
    category: "network",
    level: "critical",
    action: "deny",
    forceAsk: true,
    reason: "Downloads remote code and pipes it directly into an interpreter.",
    pattern: /\b(curl|wget)\b[\s\S]*\|\s*(?:sudo\s+)?(sh|bash|zsh|fish|python|python3|perl|ruby|node)\b/i,
    possibleWrites: ["unknown paths chosen by downloaded code"],
    ruleRecommendation: "Do not save an allow rule for curl-pipe-shell commands."
  },
  {
    category: "destructive",
    level: "critical",
    action: "deny",
    forceAsk: true,
    reason: "Can overwrite or format block devices.",
    pattern: /\b(dd\s+[\s\S]*\bof=\/dev\/|mkfs(?:\.[a-z0-9]+)?\b|wipefs\b)/i,
    possibleWrites: ["block devices"],
    ruleRecommendation: "Do not save an allow rule for disk overwrite commands."
  }
];

const BASH_RULES: CommandRule[] = [
  {
    category: "destructive",
    level: "high",
    forceAsk: true,
    reason: "Recursive or forced deletion can remove many files.",
    pattern: /\brm\s+[\s\S]*(?:-[^\s]*r|--recursive|-[^\s]*f|--force)\b/i,
    possibleWrites: ["paths named in the rm command"],
    ruleRecommendation: "Use an exact command rule only after checking the target path."
  },
  {
    category: "destructive",
    level: "high",
    forceAsk: true,
    reason: "git reset/clean/checkout can discard local work.",
    pattern: /\bgit\s+(reset\s+--hard|clean\b|checkout\s+(-f|--force)|restore\s+[\s\S]*(--staged|--worktree|-W|-S))/i,
    possibleWrites: ["git working tree", "git index"],
    ruleRecommendation: "Do not save broad git mutation rules."
  },
  {
    category: "destructive",
    level: "high",
    forceAsk: true,
    reason: "find -delete can remove every matched file.",
    pattern: /\bfind\b[\s\S]*\s-delete\b/i,
    possibleWrites: ["files matched by find"],
    ruleRecommendation: "Use an exact command rule only after checking the search root."
  },
  {
    category: "file-mutation",
    level: "high",
    forceAsk: true,
    reason: "find -exec/-ok can run another command for every matched file.",
    pattern: /\bfind\b[\s\S]*\s-(?:exec|ok)(?:dir)?\b/i,
    possibleWrites: ["paths touched by the command launched from find"],
    ruleRecommendation: "Use an exact command rule only after checking the search root and executed command."
  },
  {
    category: "file-mutation",
    level: "high",
    forceAsk: true,
    reason: "Recursive chmod/chown can change permissions or ownership across many files.",
    pattern: /\b(chmod|chown)\s+[\s\S]*(?:-R|--recursive)\b/i,
    possibleWrites: ["permissions or ownership under named paths"],
    ruleRecommendation: "Avoid broad allow rules for recursive permission changes."
  },
  {
    category: "arbitrary-interpreter",
    level: "high",
    forceAsk: true,
    reason: "Runs inline code through a general-purpose interpreter.",
    pattern: /\b(node|python|python3|ruby|perl|php|deno|bun|tsx|ts-node)\s+(-e|--eval|-c)\b/i,
    possibleWrites: ["unknown paths touched by inline code"],
    ruleRecommendation: "If needed, save only this exact command, never a broad interpreter rule."
  },
  {
    category: "arbitrary-interpreter",
    level: "high",
    forceAsk: true,
    reason: "Runs a shell through an inline command string.",
    pattern: /\b(sh|bash|zsh|fish|pwsh|powershell)(?:\.exe)?\s+(-c|-Command|\/c)\b/i,
    possibleWrites: ["unknown paths touched by nested shell code"],
    ruleRecommendation: "If needed, save only this exact command, never a broad shell rule."
  },
  {
    category: "package-install",
    level: "high",
    forceAsk: true,
    reason: "Package installation can run lifecycle scripts from dependencies.",
    pattern: JS_PACKAGE_MANAGER_INSTALL_PATTERN,
    possibleWrites: ["node_modules", "lockfiles", "package manifests", "package manager cache"],
    ruleRecommendation: "Prefer exact project install commands; avoid broad package-manager allow rules."
  },
  {
    category: "package-install",
    level: "high",
    forceAsk: true,
    reason: "Python package installation can execute setup/build hooks.",
    pattern: /\b(pip|pip3|uv)\s+(install|sync|add)\b/i,
    possibleWrites: ["virtual environment", "package cache", "lockfiles"],
    ruleRecommendation: "Prefer exact environment commands; avoid broad package-manager allow rules."
  },
  {
    category: "network",
    level: "medium",
    reason: "Uses network access.",
    pattern: /\b(curl|wget|ssh|scp|sftp|rsync|nc|ncat|netcat|telnet)\b/i,
    possibleWrites: ["download target paths if output flags or redirects are used"],
    ruleRecommendation: "Use exact host or command patterns for saved rules."
  },
  {
    category: "network",
    level: "medium",
    reason: "Git network operation can read or write remote repositories.",
    pattern: /\bgit\s+(clone|fetch|pull|push|ls-remote|submodule\s+update)\b/i,
    possibleWrites: ["git working tree", "git object database"],
    ruleRecommendation: "Use exact repository commands for saved rules."
  },
  {
    category: "file-mutation",
    level: "medium",
    reason: "Command is likely to create, edit, move, or delete files.",
    pattern: /\b(mv|cp|mkdir|touch|tee|sed\s+[\s\S]*-i|git\s+(add|apply|commit|merge|mv|rebase|rm|switch))\b|(^|[^>])>(?!\s*&\d)|>>/i,
    possibleWrites: ["paths named in the command", "redirect targets"],
    ruleRecommendation: "Use exact command or path-scoped rules."
  },
  {
    category: "build-test",
    level: "medium",
    reason: "Build or test commands can write caches, coverage, or build output.",
    pattern: new RegExp(
      String.raw`${JS_PACKAGE_MANAGER_BUILD_TEST_PATTERN.source}|\b(?:pytest|vitest|jest|tsc|cargo\s+(?:test|build)|go\s+(?:test|build)|make\s+(?:test|build))\b`,
      "i"
    ),
    possibleWrites: ["build output", "test snapshots", "coverage", "tool caches"],
    ruleRecommendation: "Exact build/test commands are reasonable to save for trusted projects."
  }
];

const POWERSHELL_DENY_RULES: CommandRule[] = [
  {
    category: "network",
    level: "critical",
    action: "deny",
    forceAsk: true,
    reason: "Downloads remote code and pipes it directly into Invoke-Expression.",
    pattern: /\b(iwr|irm|Invoke-WebRequest|Invoke-RestMethod|curl|wget)\b[\s\S]*\|\s*(iex|Invoke-Expression)\b/i,
    possibleWrites: ["unknown paths chosen by downloaded code"],
    ruleRecommendation: "Do not save an allow rule for download-pipe-iex commands."
  },
  {
    category: "destructive",
    level: "critical",
    action: "deny",
    forceAsk: true,
    reason: "Can format, clear, or repartition disks.",
    pattern: /\b(Format-Volume|Clear-Disk|Remove-Partition|Initialize-Disk)\b/i,
    possibleWrites: ["disk partitions", "volumes"],
    ruleRecommendation: "Do not save an allow rule for disk formatting commands."
  }
];

const POWERSHELL_RULES: CommandRule[] = [
  {
    category: "destructive",
    level: "high",
    forceAsk: true,
    reason: "Remove-Item with Recurse or Force can remove many files.",
    pattern: /\b(Remove-Item|rm|del|erase|rd|rmdir|ri)\b[\s\S]*(?:-Recurse|-Force|\/s|\/q)\b/i,
    possibleWrites: ["paths named in the remove command"],
    ruleRecommendation: "Use an exact command rule only after checking the target path."
  },
  {
    category: "destructive",
    level: "high",
    forceAsk: true,
    reason: "git reset/clean/checkout can discard local work.",
    pattern: /\bgit\s+(reset\s+--hard|clean\b|checkout\s+(-f|--force)|restore\s+[\s\S]*(--staged|--worktree|-W|-S))/i,
    possibleWrites: ["git working tree", "git index"],
    ruleRecommendation: "Do not save broad git mutation rules."
  },
  {
    category: "arbitrary-interpreter",
    level: "high",
    forceAsk: true,
    reason: "Runs dynamic code through PowerShell.",
    pattern: /\b(Invoke-Expression|iex)\b|\[scriptblock\]::Create\b/i,
    possibleWrites: ["unknown paths touched by dynamic code"],
    ruleRecommendation: "If needed, save only this exact command, never a broad iex rule."
  },
  {
    category: "arbitrary-interpreter",
    level: "high",
    forceAsk: true,
    reason: "Runs inline code through a general-purpose interpreter.",
    pattern: /\b(node|python|python3|ruby|perl|php|deno|bun|tsx|ts-node)\s+(-e|--eval|-c)\b/i,
    possibleWrites: ["unknown paths touched by inline code"],
    ruleRecommendation: "If needed, save only this exact command, never a broad interpreter rule."
  },
  {
    category: "arbitrary-interpreter",
    level: "high",
    forceAsk: true,
    reason: "Runs a nested PowerShell command string.",
    pattern: /\b(pwsh|powershell)(?:\.exe)?\s+(-Command|-EncodedCommand)\b/i,
    possibleWrites: ["unknown paths touched by nested PowerShell code"],
    ruleRecommendation: "If needed, save only this exact command, never a broad PowerShell rule."
  },
  {
    category: "package-install",
    level: "high",
    forceAsk: true,
    reason: "Package installation can run lifecycle scripts from dependencies.",
    pattern: JS_PACKAGE_MANAGER_INSTALL_PATTERN,
    possibleWrites: ["node_modules", "lockfiles", "package manifests", "package manager cache"],
    ruleRecommendation: "Prefer exact project install commands; avoid broad package-manager allow rules."
  },
  {
    category: "network",
    level: "medium",
    reason: "Uses network access.",
    pattern: /\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm|curl|wget|ssh|scp|sftp)\b/i,
    possibleWrites: ["download target paths if output flags or redirects are used"],
    ruleRecommendation: "Use exact host or command patterns for saved rules."
  },
  {
    category: "network",
    level: "medium",
    reason: "Git network operation can read or write remote repositories.",
    pattern: /\bgit\s+(clone|fetch|pull|push|ls-remote|submodule\s+update)\b/i,
    possibleWrites: ["git working tree", "git object database"],
    ruleRecommendation: "Use exact repository commands for saved rules."
  },
  {
    category: "file-mutation",
    level: "medium",
    reason: "PowerShell file cmdlet can create, edit, move, copy, or delete files.",
    pattern: /\b(Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Rename-Item|Remove-Item|sc|ni|mkdir|md|cp|copy|mv|move|ren|rm|del|erase|rd|rmdir|ri)\b|(^|[^>])>(?!\s*&\d)|>>/i,
    possibleWrites: ["paths named in the command", "redirect targets"],
    ruleRecommendation: "Use exact command or path-scoped rules."
  },
  {
    category: "build-test",
    level: "medium",
    reason: "Build or test commands can write caches, coverage, or build output.",
    pattern: new RegExp(
      String.raw`${JS_PACKAGE_MANAGER_BUILD_TEST_PATTERN.source}|\b(?:pytest|vitest|jest|tsc|cargo\s+(?:test|build)|go\s+(?:test|build))\b`,
      "i"
    ),
    possibleWrites: ["build output", "test snapshots", "coverage", "tool caches"],
    ruleRecommendation: "Exact build/test commands are reasonable to save for trusted projects."
  }
];

const BASH_READ_ONLY_PREFIXES = [
  "cat",
  "cd",
  "echo",
  "find",
  "git branch",
  "git diff",
  "git grep",
  "git log",
  "git ls-files",
  "git rev-parse",
  "git show",
  "git status",
  "grep",
  "head",
  "ls",
  "pwd",
  "rg",
  "sed",
  "tail",
  "test",
  "type",
  "wc",
  "where",
  "which"
];

const POWERSHELL_READ_ONLY_PREFIXES = [
  "cat",
  "cd",
  "dir",
  "echo",
  "gc",
  "gci",
  "Get-ChildItem",
  "Get-Command",
  "Get-Content",
  "Get-Item",
  "Get-Location",
  "Get-Process",
  "Get-PSDrive",
  "Get-Service",
  "gl",
  "ls",
  "Measure-Object",
  "pwd",
  "Resolve-Path",
  "Select-Object",
  "Select-String",
  "sls",
  "Test-Path",
  "type",
  "Where-Object",
  "git branch",
  "git diff",
  "git log",
  "git ls-files",
  "git rev-parse",
  "git show",
  "git status"
];

const CHAIN_PATTERN = /(?:;|&&|\|\||\r|\n)/;

/**
 * 复合命令检测。**必须跑在原始字符串上**：normalizeCommand 会把 `\s+` 压成单空格，
 * 所以换行到那一步已经消失，CHAIN_PATTERN 里的 `\r|\n` 分支实际是死代码。
 *
 * 覆盖换行、`;`、`&&`、`||`、后台/分隔用的单个 `&`（排除 `2>&1` 与 `&&`）、
 * 以及命令替换 `$(...)` 和反引号。单个 `|` 不算：只读命令之间的管道是允许的。
 */
const COMPOUND_COMMAND_PATTERN = /[\r\n;]|&&|\|\||(?<![>&])&(?!&)|\$\(|`/;

function isCompoundCommand(command: string): boolean {
  return COMPOUND_COMMAND_PATTERN.test(command);
}

/**
 * 复合命令无法按单条命令可靠分类：`ls -la; rm x` 的真实风险是 `rm x` 的风险，
 * 而规则匹配只会看到开头的 `ls`。这里不猜，一律要求显式审批。
 */
function escalateCompoundCommand(
  analysis: CommandSafetyAnalysis,
  compound: boolean
): CommandSafetyAnalysis {
  if (!compound || analysis.action === "deny" || analysis.forceAsk) {
    return analysis;
  }

  return {
    ...analysis,
    forceAsk: true,
    reasons: [
      ...analysis.reasons,
      "Command chains or substitutes multiple commands, so its full effect cannot be classified from the leading command alone."
    ],
    possibleWrites: analysis.possibleWrites.includes("unknown")
      ? analysis.possibleWrites
      : [...analysis.possibleWrites, "unknown"]
  };
}
const PIPE_PATTERN = /\|/;
const REDIRECT_PATTERN = /(^|[^>])>(?!\s*&\d)|>>/;

export function analyzeCommandSafety(
  dialect: CommandDialect,
  command: string
): CommandSafetyAnalysis {
  const normalizedCommand = normalizeCommand(command);
  // 必须用原始 command：normalizeCommand 会把换行压成空格。
  const compound = isCompoundCommand(command);
  const writePaths = analyzeCommandWritePaths(dialect, command);
  const denyRule = findMatchingRule(
    normalizedCommand,
    dialect === "powershell" ? POWERSHELL_DENY_RULES : BASH_DENY_RULES
  );
  if (denyRule) {
    return buildAnalysis(dialect, normalizedCommand, denyRule, writePaths);
  }

  const rule = findMatchingRule(
    normalizedCommand,
    dialect === "powershell" ? POWERSHELL_RULES : BASH_RULES
  );
  if (rule) {
    return buildAnalysis(dialect, normalizedCommand, rule, writePaths);
  }

  if (!compound && isSafeReadOnlyCommand(dialect, normalizedCommand)) {
    return {
      dialect,
      normalizedCommand,
      category: "safe-read-only",
      level: "low",
      action: "ask",
      forceAsk: false,
      reasons: ["Command matches a read-only command prefix and no mutation pattern was detected."],
      possibleWrites: ["none expected"],
      possibleWritePaths: writePaths.paths,
      ...(writePaths.unknownWriteReason ? { unknownWriteReason: writePaths.unknownWriteReason } : {}),
      usesWildcard: writePaths.usesWildcard,
      usesDynamicExpression: writePaths.usesDynamicExpression,
      ruleRecommendation: "A saved exact rule is reasonable for trusted read-only commands.",
      permissionPattern: normalizedCommand
    };
  }

  return escalateCompoundCommand({
    dialect,
    normalizedCommand,
    category: "unknown",
    level: "medium",
    action: "ask",
    forceAsk: false,
    reasons: ["Command does not match a known safe or high-risk pattern."],
    possibleWrites: ["unknown"],
    possibleWritePaths: writePaths.paths,
    ...(writePaths.unknownWriteReason ? { unknownWriteReason: writePaths.unknownWriteReason } : {}),
    usesWildcard: writePaths.usesWildcard,
    usesDynamicExpression: writePaths.usesDynamicExpression,
    ruleRecommendation: "Use an exact command rule only after reviewing the command.",
    permissionPattern: normalizedCommand
  }, compound);
}

export function formatCommandSafetyDetails(analysis: CommandSafetyAnalysis): string[] {
  return [
    `Risk: ${analysis.category} (${analysis.level})`,
    ...analysis.reasons.map((reason) => `Reason: ${reason}`),
    `Possible writes: ${analysis.possibleWrites.join(", ")}`,
    analysis.possibleWritePaths.length > 0
      ? `Static write paths: ${analysis.possibleWritePaths.join(", ")}`
      : null,
    analysis.unknownWriteReason ? `Write path analysis: ${analysis.unknownWriteReason}` : null,
    `Rule suggestion: ${analysis.ruleRecommendation}`,
    `Permission pattern: ${analysis.permissionPattern}`,
    analysis.forceAsk ? "Explicit approval required: broad session allow rules will not skip this prompt." : null
  ].filter((line): line is string => line !== null);
}

function findMatchingRule(command: string, rules: readonly CommandRule[]): CommandRule | undefined {
  return rules.find((rule) => rule.pattern.test(command));
}

function buildAnalysis(
  dialect: CommandDialect,
  normalizedCommand: string,
  rule: CommandRule,
  writePaths: CommandWritePathAnalysis
): CommandSafetyAnalysis {
  return {
    dialect,
    normalizedCommand,
    category: rule.category,
    level: rule.level,
    action: rule.action ?? "ask",
    forceAsk: rule.forceAsk ?? (rule.level === "high" || rule.level === "critical"),
    reasons: [rule.reason],
    possibleWrites: rule.possibleWrites ?? ["unknown"],
    possibleWritePaths: writePaths.paths,
    ...(writePaths.unknownWriteReason ? { unknownWriteReason: writePaths.unknownWriteReason } : {}),
    usesWildcard: writePaths.usesWildcard,
    usesDynamicExpression: writePaths.usesDynamicExpression,
    ruleRecommendation: rule.ruleRecommendation ?? "Use an exact command rule only after review.",
    permissionPattern: normalizedCommand
  };
}

function isSafeReadOnlyCommand(dialect: CommandDialect, command: string): boolean {
  if (!command || REDIRECT_PATTERN.test(command)) {
    return false;
  }

  if (CHAIN_PATTERN.test(command)) {
    return false;
  }

  const segments = command.split(PIPE_PATTERN).map((segment) => segment.trim());
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    return false;
  }

  const prefixes = dialect === "powershell" ? POWERSHELL_READ_ONLY_PREFIXES : BASH_READ_ONLY_PREFIXES;
  return segments.every((segment) => matchesAnyPrefix(segment, prefixes));
}

function matchesAnyPrefix(command: string, prefixes: readonly string[]): boolean {
  const normalized = command.toLowerCase();
  return prefixes.some((prefix) => {
    const candidate = prefix.toLowerCase();
    return normalized === candidate || normalized.startsWith(`${candidate} `);
  });
}

function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

interface CommandWritePathAnalysis {
  paths: string[];
  unknownWriteReason?: string;
  usesWildcard: boolean;
  usesDynamicExpression: boolean;
}

interface CommandToken {
  value: string;
  quoted: boolean;
}

const SHELL_SEGMENT_SEPARATORS = new Set([";", "&&", "||", "|"]);
const SHELL_REDIRECT_OPERATORS = new Set([">", ">>"]);
const POWERSHELL_PATH_PARAMETERS = new Set([
  "-path",
  "-literalpath",
  "-filepath",
  "-destination",
  "-newname"
]);
const POWERSHELL_VALUE_PARAMETERS = new Set([
  ...POWERSHELL_PATH_PARAMETERS,
  "-encoding",
  "-exclude",
  "-filter",
  "-include",
  "-itemtype",
  "-name",
  "-stream",
  "-type",
  "-value"
]);
const POWERSHELL_COMMAND_ALIASES = new Map([
  ["set-content", "set-content"],
  ["sc", "set-content"],
  ["add-content", "add-content"],
  ["out-file", "out-file"],
  ["new-item", "new-item"],
  ["ni", "new-item"],
  ["mkdir", "new-item"],
  ["md", "new-item"],
  ["remove-item", "remove-item"],
  ["rm", "remove-item"],
  ["del", "remove-item"],
  ["erase", "remove-item"],
  ["rd", "remove-item"],
  ["rmdir", "remove-item"],
  ["ri", "remove-item"],
  ["copy-item", "copy-item"],
  ["cp", "copy-item"],
  ["copy", "copy-item"],
  ["move-item", "move-item"],
  ["mv", "move-item"],
  ["move", "move-item"],
  ["rename-item", "rename-item"],
  ["ren", "rename-item"]
]);

export function analyzeCommandWritePaths(
  dialect: CommandDialect,
  command: string
): CommandWritePathAnalysis {
  const tokens = tokenizeCommand(command);
  const rawPaths = dialect === "powershell"
    ? collectPowerShellWritePaths(tokens)
    : collectShellWritePaths(tokens);
  const filtered = filterStaticPaths(rawPaths);
  return {
    paths: [...new Set(filtered.paths)],
    ...(filtered.unknownWriteReason ? { unknownWriteReason: filtered.unknownWriteReason } : {}),
    usesWildcard: filtered.usesWildcard,
    usesDynamicExpression: filtered.usesDynamicExpression
  };
}

function collectShellWritePaths(tokens: readonly CommandToken[]): string[] {
  const paths: string[] = [];
  collectRedirectPaths(tokens, paths);

  for (const segment of splitTokenSegments(tokens, SHELL_SEGMENT_SEPARATORS)) {
    const command = segment[0]?.value.toLowerCase();
    if (!command) {
      continue;
    }

    const args = stripRedirects(segment.slice(1));
    switch (command) {
      case "touch":
      case "mkdir":
      case "rm":
        paths.push(...collectShellPathArgs(args));
        break;
      case "mv":
      case "cp":
        paths.push(...collectShellPathArgs(args).slice(-2));
        break;
      case "tee":
        paths.push(...collectShellPathArgs(args));
        break;
      case "sed":
        if (args.some((arg) => arg.value === "-i" || arg.value.startsWith("-i"))) {
          const nonOptions = collectShellPathArgs(args);
          paths.push(...nonOptions.slice(1));
        }
        break;
    }
  }

  return paths;
}

function collectPowerShellWritePaths(tokens: readonly CommandToken[]): string[] {
  const paths: string[] = [];
  collectRedirectPaths(tokens, paths);
  const variables = collectPowerShellStaticVariables(tokens);

  for (const segment of splitTokenSegments(tokens, SHELL_SEGMENT_SEPARATORS)) {
    const commandIndex = segment.findIndex((token) =>
      POWERSHELL_COMMAND_ALIASES.has(token.value.toLowerCase())
    );
    if (commandIndex === -1) {
      continue;
    }

    const command = POWERSHELL_COMMAND_ALIASES.get(segment[commandIndex]?.value.toLowerCase() ?? "");
    const args = stripRedirects(segment.slice(commandIndex + 1));
    const named = collectPowerShellNamedPaths(args, variables);
    const positionals = collectPowerShellPositionals(args, variables);

    switch (command) {
      case "set-content":
      case "add-content":
      case "out-file":
      case "new-item":
      case "remove-item":
        paths.push(...named, ...positionals.slice(0, 1));
        break;
      case "copy-item":
      case "move-item":
        paths.push(...named, ...positionals.slice(0, 2));
        break;
      case "rename-item":
        paths.push(...named, ...positionals.slice(0, 2));
        break;
    }
  }

  return paths;
}

function tokenizeCommand(command: string): CommandToken[] {
  const tokens: CommandToken[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let currentQuoted = false;

  const flush = () => {
    if (!current) {
      return;
    }

    tokens.push({ value: current, quoted: currentQuoted });
    current = "";
    currentQuoted = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (quote) {
      if (char === quote) {
        quote = null;
        currentQuoted = true;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "#") {
      flush();
      while (index + 1 < command.length && !isLineBreak(command[index + 1] ?? "")) {
        index += 1;
      }
      continue;
    }

    if (isLineBreak(char)) {
      flush();
      tokens.push({ value: ";", quoted: false });
      if (char === "\r" && command[index + 1] === "\n") {
        index += 1;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      currentQuoted = true;
      continue;
    }

    if (/\s/.test(char)) {
      flush();
      continue;
    }

    const twoChars = command.slice(index, index + 2);
    if (twoChars === "&&" || twoChars === "||" || twoChars === ">>") {
      flush();
      tokens.push({ value: twoChars, quoted: false });
      index += 1;
      continue;
    }

    if (char === ";" || char === "|" || char === ">") {
      flush();
      tokens.push({ value: char, quoted: false });
      continue;
    }

    if (char === "=") {
      flush();
      tokens.push({ value: char, quoted: false });
      continue;
    }

    current += char;
  }

  flush();
  return tokens;
}

function splitTokenSegments(
  tokens: readonly CommandToken[],
  separators: ReadonlySet<string>
): CommandToken[][] {
  const segments: CommandToken[][] = [];
  let current: CommandToken[] = [];
  for (const token of tokens) {
    if (!token.quoted && separators.has(token.value)) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      continue;
    }

    current.push(token);
  }

  if (current.length > 0) {
    segments.push(current);
  }

  return segments;
}

function collectRedirectPaths(tokens: readonly CommandToken[], paths: string[]) {
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];
    if (!token || !next || token.quoted || !SHELL_REDIRECT_OPERATORS.has(token.value)) {
      continue;
    }

    if (next.value.startsWith("&")) {
      continue;
    }

    paths.push(next.value);
  }
}

function stripRedirects(tokens: readonly CommandToken[]): CommandToken[] {
  const result: CommandToken[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token && !token.quoted && SHELL_REDIRECT_OPERATORS.has(token.value)) {
      index += 1;
      continue;
    }

    if (token) {
      result.push(token);
    }
  }

  return result;
}

function collectShellPathArgs(tokens: readonly CommandToken[]): string[] {
  return tokens
    .filter((token) => !isShellOption(token.value) && !isAssignment(token.value))
    .map((token) => token.value);
}

function collectPowerShellNamedPaths(
  tokens: readonly CommandToken[],
  variables: ReadonlyMap<string, readonly string[]>
): string[] {
  const paths: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }

    const lower = token.value.toLowerCase();
    const inline = lower.match(/^(-[a-z]+):(.*)$/);
    if (inline && POWERSHELL_PATH_PARAMETERS.has(inline[1] ?? "") && inline[2]) {
      paths.push(...resolvePowerShellPathCandidates(
        token.value.slice((inline[1] ?? "").length + 1),
        variables
      ));
      continue;
    }

    if (POWERSHELL_PATH_PARAMETERS.has(lower)) {
      const next = tokens[index + 1];
      if (next) {
        paths.push(...resolvePowerShellPathCandidates(next.value, variables));
        index += 1;
      }
    }
  }

  return paths;
}

function collectPowerShellPositionals(
  tokens: readonly CommandToken[],
  variables: ReadonlyMap<string, readonly string[]>
): string[] {
  const positionals: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }

    if (isPowerShellParameter(token.value)) {
      const lower = token.value.toLowerCase();
      const parameterName = lower.includes(":") ? lower.slice(0, lower.indexOf(":")) : lower;
      if (
        POWERSHELL_VALUE_PARAMETERS.has(parameterName) &&
        !lower.includes(":") &&
        index + 1 < tokens.length &&
        !isPowerShellParameter(tokens[index + 1]?.value ?? "")
      ) {
        index += 1;
      }
      continue;
    }

    positionals.push(...resolvePowerShellPathCandidates(token.value, variables));
  }

  return positionals;
}

function collectPowerShellStaticVariables(
  tokens: readonly CommandToken[]
): Map<string, string[]> {
  const variables = new Map<string, string[]>();

  for (const segment of splitTokenSegments(tokens, SHELL_SEGMENT_SEPARATORS)) {
    const assignmentIndex = segment.findIndex((token, index) =>
      isPowerShellVariableToken(token.value) && segment[index + 1]?.value === "="
    );
    if (assignmentIndex === -1) {
      continue;
    }

    const variable = getPowerShellVariableName(segment[assignmentIndex]?.value ?? "");
    if (!variable) {
      continue;
    }

    const expression = segment.slice(assignmentIndex + 2);
    const values = evaluatePowerShellPathExpression(expression, variables);
    if (values.length === 0) {
      continue;
    }

    mergePowerShellVariableValues(variables, variable, values);
  }

  return variables;
}

function evaluatePowerShellPathExpression(
  tokens: readonly CommandToken[],
  variables: ReadonlyMap<string, readonly string[]>
): string[] {
  const expression = stringifyPowerShellExpression(tokens).trim();
  if (!expression) {
    return [];
  }

  const literal = parseQuotedPowerShellLiteral(expression);
  if (literal !== undefined) {
    return [literal];
  }

  const knownPrefix = expandKnownStaticPathPrefix(expression);
  if (knownPrefix !== undefined) {
    return [knownPrefix];
  }

  if (isBarePowerShellPathLiteral(expression)) {
    return [expression];
  }

  const variableCandidates = resolvePowerShellPathCandidates(expression, variables);
  if (!variableCandidates.some((value) => value === expression)) {
    return variableCandidates;
  }

  const combineArgs = parseSystemIoPathCombineArgs(expression);
  if (combineArgs.length > 0) {
    return expandPowerShellCombineArgs(combineArgs, variables);
  }

  const specialFolder = parseEnvironmentSpecialFolderPath(expression);
  if (specialFolder !== undefined) {
    return [specialFolder];
  }

  const joinPathArgs = parsePowerShellJoinPathArgs(tokens);
  if (joinPathArgs.length > 0) {
    return expandPowerShellCombineArgs(joinPathArgs, variables);
  }

  return [];
}

function stringifyPowerShellExpression(tokens: readonly CommandToken[]) {
  return tokens.map((token) => token.value).join(" ");
}

function resolvePowerShellPathCandidates(
  value: string,
  variables: ReadonlyMap<string, readonly string[]>
): string[] {
  const variablePath = value.match(/^(\$[A-Za-z_][A-Za-z0-9_]*)([\\/].*)?$/);
  if (!variablePath) {
    return [value];
  }

  const variable = getPowerShellVariableName(variablePath[1] ?? "");
  const values = variable ? variables.get(variable) : undefined;
  if (!values || values.length === 0) {
    return [value];
  }

  const suffix = variablePath[2] ?? "";
  return values.map((candidate) => appendPowerShellPathSuffix(candidate, suffix));
}

function parseSystemIoPathCombineArgs(expression: string): string[] {
  const match = expression.match(/^\[System\.IO\.Path\]::Combine\(([\s\S]*)\)$/i);
  if (!match) {
    return [];
  }

  return splitPowerShellArguments(match[1] ?? "");
}

function parseEnvironmentSpecialFolderPath(expression: string): string | undefined {
  const match = expression.match(/^\[(?:System\.)?Environment\]::GetFolderPath\(([\s\S]*)\)$/i);
  if (!match) {
    return undefined;
  }

  const folderName = parseQuotedPowerShellLiteral((match[1] ?? "").trim()) ?? (match[1] ?? "").trim();
  if (!/^desktop$/i.test(folderName)) {
    return undefined;
  }

  return joinPowerShellPath(getEnvironmentValue("USERPROFILE") ?? os.homedir(), "Desktop");
}

function parsePowerShellJoinPathArgs(tokens: readonly CommandToken[]): string[] {
  const command = tokens[0]?.value.toLowerCase();
  if (command !== "join-path") {
    return [];
  }

  const args = tokens.slice(1);
  const named = new Map<string, string>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) {
      continue;
    }

    const lower = token.value.toLowerCase();
    if (lower === "-path" || lower === "-literalpath" || lower === "-childpath") {
      const next = args[index + 1];
      if (next) {
        named.set(lower, next.value);
        index += 1;
      }
      continue;
    }

    if (isPowerShellParameter(token.value)) {
      continue;
    }

    positionals.push(token.value);
  }

  const base = named.get("-path") ?? named.get("-literalpath") ?? positionals[0];
  const child = named.get("-childpath") ?? positionals[1];
  return base && child ? [base, child] : [];
}

function splitPowerShellArguments(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let depth = 0;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "";
    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      current += char;
      continue;
    }

    if (char === "(") {
      depth += 1;
      current += char;
      continue;
    }

    if (char === ")") {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }

    if (char === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    args.push(current.trim());
  }

  return args;
}

function expandPowerShellCombineArgs(
  args: readonly string[],
  variables: ReadonlyMap<string, readonly string[]>
): string[] {
  let paths = [""];
  for (const arg of args) {
    const values = evaluatePowerShellPathExpression(
      [{ value: arg, quoted: false }],
      variables
    );
    if (values.length === 0) {
      return [];
    }

    paths = paths.flatMap((base) =>
      values.map((part) => joinPowerShellPath(base, part))
    );
  }

  return paths.filter((value) => value.length > 0);
}

function parseQuotedPowerShellLiteral(value: string): string | undefined {
  if (value.length < 2) {
    return undefined;
  }

  const quote = value[0];
  if ((quote !== "'" && quote !== "\"") || value[value.length - 1] !== quote) {
    return undefined;
  }

  const inner = value.slice(1, -1);
  return quote === "\""
    ? inner.replace(/`(["`$])/g, "$1")
    : inner.replace(/''/g, "'");
}

function joinPowerShellPath(base: string, part: string) {
  if (!base) {
    return part;
  }

  if (!part) {
    return base;
  }

  const normalizedPart = part.replace(/^[\\/]+/, "");
  if (!normalizedPart) {
    return base;
  }

  const separator = base.includes("\\") || /^[A-Za-z]:$/.test(base) ? "\\" : "/";
  return /[\\/]$/.test(base)
    ? `${base}${normalizedPart}`
    : `${base}${separator}${normalizedPart}`;
}

function appendPowerShellPathSuffix(base: string, suffix: string) {
  if (!suffix) {
    return base;
  }

  return joinPowerShellPath(base, suffix);
}

function mergePowerShellVariableValues(
  variables: Map<string, string[]>,
  variable: string,
  values: readonly string[]
) {
  const existing = variables.get(variable) ?? [];
  variables.set(variable, [...new Set([...existing, ...values])]);
}

function filterStaticPaths(paths: readonly string[]): CommandWritePathAnalysis {
  const accepted: string[] = [];
  let usesWildcard = false;
  let usesDynamicExpression = false;
  for (const candidate of paths) {
    const normalized = candidate.trim();
    if (!normalized || normalized === "-") {
      continue;
    }

    const staticPath = expandKnownStaticPathPrefix(normalized) ?? normalized;

    if (isDynamicPath(staticPath)) {
      usesDynamicExpression = true;
      continue;
    }

    if (hasWildcard(staticPath)) {
      usesWildcard = true;
      continue;
    }

    if (isProviderPath(staticPath) || isUrlLikePath(staticPath)) {
      usesDynamicExpression = true;
      continue;
    }

    accepted.push(staticPath);
  }

  const unknownWriteReason =
    usesWildcard
      ? "One or more write paths used wildcards and were not captured."
      : usesDynamicExpression
        ? "One or more write paths used dynamic expressions or non-filesystem providers and were not captured."
        : undefined;

  return {
    paths: accepted,
    ...(unknownWriteReason ? { unknownWriteReason } : {}),
    usesWildcard,
    usesDynamicExpression
  };
}

function isShellOption(value: string) {
  return value.startsWith("-") && value !== "-";
}

function isAssignment(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function isPowerShellParameter(value: string) {
  return value.startsWith("-") && value.length > 1;
}

function isPowerShellVariableToken(value: string) {
  return /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function getPowerShellVariableName(value: string): string | undefined {
  const match = value.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  return match?.[1]?.toLowerCase();
}

function isLineBreak(value: string) {
  return value === "\n" || value === "\r";
}

function isBarePowerShellPathLiteral(value: string) {
  return !/[\s$`()[\],{}]/.test(value);
}

function hasWildcard(value: string) {
  return /[*?\[\]]/.test(value);
}

function isDynamicPath(value: string) {
  return /(?:\$|\$\(|`|%[A-Za-z_][A-Za-z0-9_]*%|^\{|\}$)/.test(value);
}

function expandKnownStaticPathPrefix(value: string): string | undefined {
  const homeDirectory = os.homedir();
  const userProfile = getEnvironmentValue("USERPROFILE") ?? homeDirectory;
  const homeDrive = getEnvironmentValue("HOMEDRIVE");
  const homePath = getEnvironmentValue("HOMEPATH");
  const homeDrivePath = homeDrive && homePath ? `${homeDrive}${homePath}` : undefined;
  const candidates: Array<[string, string | undefined]> = [
    ["$HOME", homeDirectory],
    ["${HOME}", homeDirectory],
    ["$env:HOME", homeDirectory],
    ["${env:HOME}", homeDirectory],
    ["$env:USERPROFILE", userProfile],
    ["${env:USERPROFILE}", userProfile],
    ["%HOME%", homeDirectory],
    ["%USERPROFILE%", userProfile],
    ["$env:HOMEDRIVE$env:HOMEPATH", homeDrivePath],
    ["${env:HOMEDRIVE}${env:HOMEPATH}", homeDrivePath],
    ["%HOMEDRIVE%%HOMEPATH%", homeDrivePath]
  ];

  for (const [prefix, replacement] of candidates) {
    if (!replacement || !startsWithIgnoreCase(value, prefix)) {
      continue;
    }

    const suffix = value.slice(prefix.length);
    if (suffix && !suffix.startsWith("/") && !suffix.startsWith("\\")) {
      continue;
    }

    if (isDynamicPath(suffix)) {
      continue;
    }

    return `${replacement}${suffix}`;
  }

  return undefined;
}

function startsWithIgnoreCase(value: string, prefix: string) {
  return value.toLowerCase().startsWith(prefix.toLowerCase());
}

function getEnvironmentValue(name: string): string | undefined {
  const direct = process.env[name];
  if (direct) {
    return direct;
  }

  const match = Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match?.[1];
}

function isProviderPath(value: string) {
  return /^[A-Za-z][A-Za-z0-9_-]*:/.test(value) && !/^[A-Za-z]:[\\/]/.test(value);
}

function isUrlLikePath(value: string) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}
