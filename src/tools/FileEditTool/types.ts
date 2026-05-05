import { z } from "zod";

export const inputSchema = () =>
  z
    .object({
      file_path: z
        .string()
        .describe(
          "Absolute path preferred; supports ~ and ~/..., plus workspace-relative paths, on the local filesystem"
        ),
      old_string: z.string().min(1).describe("The text to replace"),
      new_string: z.string().describe("The text to replace with"),
      replace_all: z.boolean().optional().default(false)
    })
    .strict();

export const hunkSchema = () =>
  z.object({
    oldStart: z.number().int().nonnegative(),
    oldLines: z.number().int().nonnegative(),
    newStart: z.number().int().nonnegative(),
    newLines: z.number().int().nonnegative(),
    lines: z.array(z.string())
  });

const formatterResultSchema = () =>
  z.object({
    status: z.enum(["skipped", "unchanged", "formatted", "failed"]),
    formatter: z.string().optional(),
    command: z.array(z.string()).optional(),
    durationMs: z.number().int().nonnegative().optional(),
    exitCode: z.number().int().nullable().optional(),
    signal: z.string().nullable().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    message: z.string().optional()
  });

const diagnosticIssueSchema = () =>
  z.object({
    filePath: z.string(),
    line: z.number().int().positive(),
    character: z.number().int().positive(),
    severity: z.string(),
    code: z.string(),
    message: z.string(),
    source: z.string().optional()
  });

const diagnosticsResultSchema = () =>
  z.object({
    status: z.enum(["skipped", "ok", "issues", "failed"]),
    backend: z.string().optional(),
    issues: z.array(diagnosticIssueSchema()),
    totalIssueCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    message: z.string().optional()
  });

export const outputSchema = () =>
  z.object({
    filePath: z.string(),
    oldString: z.string(),
    newString: z.string(),
    actualOldString: z.string().optional(),
    matchStrategy: z.string().optional(),
    structuredPatch: z.array(hunkSchema()),
    userModified: z.boolean(),
    replaceAll: z.boolean(),
    matchCount: z.number().int().nonnegative(),
    formatter: formatterResultSchema().optional(),
    diagnostics: diagnosticsResultSchema().optional()
  });

export type FileEditInput = z.infer<ReturnType<typeof inputSchema>>;
export type FileEditOutput = z.infer<ReturnType<typeof outputSchema>>;

export interface FileEdit {
  old_string: string;
  new_string: string;
  replace_all: boolean;
}
