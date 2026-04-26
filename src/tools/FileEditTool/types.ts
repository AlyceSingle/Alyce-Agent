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

export const outputSchema = () =>
  z.object({
    filePath: z.string(),
    oldString: z.string(),
    newString: z.string(),
    structuredPatch: z.array(hunkSchema()),
    userModified: z.boolean(),
    replaceAll: z.boolean(),
    matchCount: z.number().int().nonnegative()
  });

export type FileEditInput = z.infer<ReturnType<typeof inputSchema>>;
export type FileEditOutput = z.infer<ReturnType<typeof outputSchema>>;

export interface FileEdit {
  old_string: string;
  new_string: string;
  replace_all: boolean;
}
