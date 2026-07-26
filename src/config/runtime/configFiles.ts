import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type {
  ApprovalModeInput,
  SessionSettings,
  SnapshotRuntimeConfig
} from "./types.js";
import { isMissingFileError } from "./shared.js";

export const ConnectionConfigFileSchema = z
  .object({
    apiKey: z.string().optional(),
    baseURL: z.string().optional(),
    model: z.string().optional(),
    providers: z.record(z.object({
      id: z.string().optional(),
      label: z.string().optional(),
      kind: z.union([
        z.literal("openai-compatible"),
        z.literal("openai"),
        z.literal("anthropic"),
        z.literal("google"),
        z.literal("openrouter"),
        z.literal("local")
      ]).optional(),
      apiKeyEnv: z.string().optional(),
      apiKey: z.string().optional(),
      baseURL: z.string().optional(),
      defaultModel: z.string().optional(),
      models: z.record(z.object({
        label: z.string().optional(),
        contextWindow: z.number().int().positive().optional(),
        maxOutputTokens: z.number().int().positive().optional(),
        inputCostPerMillionTokens: z.number().nonnegative().optional(),
        outputCostPerMillionTokens: z.number().nonnegative().optional(),
        cachedInputCostPerMillionTokens: z.number().nonnegative().optional(),
        temperature: z.number().min(0).max(2).nullable().optional(),
        reasoningEffort: z.union([
          z.literal("minimal"),
          z.literal("low"),
          z.literal("medium"),
          z.literal("high")
        ]).optional(),
        thinkingBudgetTokens: z.number().int().positive().optional()
      }).strict()).optional()
    }).strict()).optional()
  })
  .strict();

export type SessionSettingsFile = Omit<Partial<SessionSettings>, "snapshot" | "approvalMode"> & {
  approvalMode?: ApprovalModeInput;
  snapshot?: Partial<SnapshotRuntimeConfig>;
  autoSummaryEnabled?: boolean;
  statusUsageDisplayEnabled?: boolean;
  startupInstructionFiles?: string[];
};

export const SessionSettingsFileSchema: z.ZodType<SessionSettingsFile> = z
  .object({
    uiLanguage: z.union([z.literal("en"), z.literal("zh")]).optional(),
    approvalMode: z.union([
      z.literal("read-only"),
      z.literal("default"),
      z.literal("auto-review"),
      z.literal("full-access"),
      // Legacy aliases kept so existing settings files continue to load.
      z.literal("manual"),
      z.literal("auto")
    ]).optional(),
    maxSteps: z.number().int().positive().optional(),
    commandTimeoutMs: z.number().int().positive().optional(),
    scrollSpeed: z.number().int().positive().optional(),
    scrollAccelerationEnabled: z.boolean().optional(),
    historyPagingEnabled: z.boolean().optional(),
    maxMessagesWithoutVirtualization: z.number().int().positive().optional(),
    sessionMemoryEnabled: z.boolean().optional(),
    // Accept the retired setting as a compatibility alias.
    autoSummaryEnabled: z.boolean().optional(),
    messageTimestampsEnabled: z.boolean().optional(),
    showMessageTimestamps: z.boolean().optional(),
    markdownMessageRenderingEnabled: z.boolean().optional(),
    markdownToolMessageRenderingEnabled: z.boolean().optional(),
    markdownRenderMaxChars: z.number().int().positive().optional(),
    thinkingMessagesExpandedByDefault: z.boolean().optional(),
    // Accept and discard the removed status-bar usage setting.
    statusUsageDisplayEnabled: z.boolean().optional(),
    diagnosticsPendingTimeoutMs: z.number().int().positive().optional(),
    diagnosticsFailureThreshold: z.number().int().positive().optional(),
    diagnosticsFailureCooldownMs: z.number().int().positive().optional(),
    snapshot: z
      .object({
        enabled: z.boolean().optional(),
        engine: z.union([
          z.literal("hybrid"),
          z.literal("git-tree"),
          z.literal("file-backup")
        ]).optional(),
        maxTextDiffBytes: z.number().int().positive().optional(),
        maxFileBytes: z.number().int().positive().optional(),
        retentionDays: z.number().int().positive().optional(),
        includeIgnoredExplicitPaths: z.boolean().optional(),
        manifestScan: z.boolean().optional()
      })
      .strict()
      .optional(),
    conversationCompactionEnabled: z.boolean().optional(),
    autoCompactTimeoutMs: z.number().int().positive().optional(),
    autoCompactMaxFailures: z.number().int().positive().optional(),
    modelContextWindowOverrides: z.record(z.number().int().positive()).optional(),
    languagePreference: z.string().optional(),
    personaPreset: z.string().optional(),
    aiPersonalityPrompt: z.string().optional(),
    appendSystemPrompt: z.string().optional(),
    additionalDirectories: z.array(z.string()).optional(),
    permissionRules: z
      .array(
        z
          .object({
            permission: z.union([
              z.literal("*"),
              z.literal("shell"),
              z.literal("powershell"),
              z.literal("file.read"),
              z.literal("file.write"),
              z.literal("file.edit"),
              z.literal("file.patch"),
              z.literal("directory.external"),
              z.literal("web.fetch"),
              z.literal("web.search"),
              z.literal("mcp.tool"),
              z.literal("mcp.resource"),
              z.literal("skill.load"),
              z.literal("task.spawn")
            ]),
            pattern: z.string().optional(),
            action: z.union([z.literal("allow"), z.literal("ask"), z.literal("deny")]),
            scope: z.union([z.literal("session"), z.literal("persistent")]).optional(),
            expiresAt: z.string().optional(),
            reason: z.string().optional(),
            id: z.string().optional()
          })
          .strict()
      )
      .optional(),
    // Accept and discard the removed key so older settings files keep loading cleanly.
    startupInstructionFiles: z.array(z.string()).optional()
  })
  .strict();

/**
 * Walk the path segments from a Zod "unrecognized_keys" issue and delete the
 * reported keys from the raw parsed config so a second parse succeeds.
 */
function stripUnrecognizedKeys(
  raw: unknown,
  issues: z.ZodIssue[]
): unknown {
  for (const issue of issues) {
    if (issue.code !== "unrecognized_keys") continue;
    const parentPath = issue.path; // e.g. [] for root, ["snapshot"] for nested
    // Navigate to the parent object
    let parent: unknown = raw;
    for (const segment of parentPath) {
      if (parent == null || typeof parent !== "object") break;
      parent = (parent as Record<string | number, unknown>)[segment];
    }
    if (parent != null && typeof parent === "object") {
      for (const key of issue.keys) {
        delete (parent as Record<string, unknown>)[String(key)];
      }
    }
  }
  return raw;
}

function formatUnrecognizedKeyWarnings(
  filePath: string,
  issues: z.ZodIssue[]
): string {
  return issues
    .filter((i) => i.code === "unrecognized_keys")
    .map((i) => {
      const loc = i.path.length > 0 ? i.path.join(".") : "(root)";
      return `  ${loc}: ${i.keys.map((k) => `'${String(k)}'`).join(", ")}`;
    })
    .join("\n");
}

export async function readJsonConfig<T>(
  filePath: string,
  schema: z.ZodSchema<T>
): Promise<Partial<T>> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const result = schema.safeParse(parsed);

    if (result.success) {
      return result.data;
    }

    // Separate unrecognized-key issues from real validation errors.
    const unrecognizedIssues = result.error.issues.filter(
      (i) => i.code === "unrecognized_keys"
    );
    const otherIssues = result.error.issues.filter(
      (i) => i.code !== "unrecognized_keys"
    );

    // If there are genuine validation errors (wrong type, invalid value, etc.),
    // surface them exactly as before.
    if (otherIssues.length > 0) {
      const details = result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new Error(`Invalid config file ${filePath}: ${details}`);
    }

    // Only unrecognized keys — warn and strip them so the app keeps working.
    const warnings = formatUnrecognizedKeyWarnings(filePath, unrecognizedIssues);
    process.stderr.write(
      `Warning: unrecognized key(s) in ${filePath} (ignored):\n${warnings}\n`
    );

    stripUnrecognizedKeys(parsed, unrecognizedIssues);
    // Re-parse the cleaned object — should succeed now.
    return schema.parse(parsed);
  } catch (error) {
    if (isMissingFileError(error)) {
      return {};
    }

    if (error instanceof z.ZodError) {
      const details = error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new Error(`Invalid config file ${filePath}: ${details}`);
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read config file ${filePath}: ${message}`);
  }
}

export async function writeJsonConfig(filePath: string, value: object): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}
