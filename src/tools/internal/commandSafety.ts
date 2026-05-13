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
    pattern: /\b(npm|pnpm|yarn|bun)\s+(install|add|update|upgrade|ci|dlx|exec|create)\b/i,
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
    pattern: /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(build|test|lint|typecheck)\b|\b(npm|pnpm|yarn|bun)\s+test\b|\b(pytest|vitest|jest|tsc|cargo\s+(test|build)|go\s+(test|build)|make\s+(test|build))\b/i,
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
    pattern: /\b(npm|pnpm|yarn|bun)\s+(install|add|update|upgrade|ci|dlx|exec|create)\b/i,
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
    pattern: /\b(Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Rename-Item|Remove-Item|sc|ni|cp|copy|mv|move|ren)\b|(^|[^>])>(?!\s*&\d)|>>/i,
    possibleWrites: ["paths named in the command", "redirect targets"],
    ruleRecommendation: "Use exact command or path-scoped rules."
  },
  {
    category: "build-test",
    level: "medium",
    reason: "Build or test commands can write caches, coverage, or build output.",
    pattern: /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(build|test|lint|typecheck)\b|\b(npm|pnpm|yarn|bun)\s+test\b|\b(pytest|vitest|jest|tsc|cargo\s+(test|build)|go\s+(test|build))\b/i,
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
  "Get-ChildItem",
  "Get-Command",
  "Get-Content",
  "Get-Item",
  "Get-Location",
  "Get-Process",
  "Get-PSDrive",
  "Get-Service",
  "Measure-Object",
  "Resolve-Path",
  "Select-Object",
  "Select-String",
  "Test-Path",
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
const PIPE_PATTERN = /\|/;
const REDIRECT_PATTERN = /(^|[^>])>(?!\s*&\d)|>>/;

export function analyzeCommandSafety(
  dialect: CommandDialect,
  command: string
): CommandSafetyAnalysis {
  const normalizedCommand = normalizeCommand(command);
  const denyRule = findMatchingRule(
    normalizedCommand,
    dialect === "powershell" ? POWERSHELL_DENY_RULES : BASH_DENY_RULES
  );
  if (denyRule) {
    return buildAnalysis(dialect, normalizedCommand, denyRule);
  }

  const rule = findMatchingRule(
    normalizedCommand,
    dialect === "powershell" ? POWERSHELL_RULES : BASH_RULES
  );
  if (rule) {
    return buildAnalysis(dialect, normalizedCommand, rule);
  }

  if (isSafeReadOnlyCommand(dialect, normalizedCommand)) {
    return {
      dialect,
      normalizedCommand,
      category: "safe-read-only",
      level: "low",
      action: "ask",
      forceAsk: false,
      reasons: ["Command matches a read-only command prefix and no mutation pattern was detected."],
      possibleWrites: ["none expected"],
      ruleRecommendation: "A saved exact rule is reasonable for trusted read-only commands.",
      permissionPattern: normalizedCommand
    };
  }

  return {
    dialect,
    normalizedCommand,
    category: "unknown",
    level: "medium",
    action: "ask",
    forceAsk: false,
    reasons: ["Command does not match a known safe or high-risk pattern."],
    possibleWrites: ["unknown"],
    ruleRecommendation: "Use an exact command rule only after reviewing the command.",
    permissionPattern: normalizedCommand
  };
}

export function formatCommandSafetyDetails(analysis: CommandSafetyAnalysis): string[] {
  return [
    `Risk: ${analysis.category} (${analysis.level})`,
    ...analysis.reasons.map((reason) => `Reason: ${reason}`),
    `Possible writes: ${analysis.possibleWrites.join(", ")}`,
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
  rule: CommandRule
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
