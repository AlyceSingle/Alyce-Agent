import { z } from "zod";
import { hunkSchema } from "../FileEditTool/types.js";
import type {
  PostWriteDiagnosticsResult,
  PostWriteFormatterResult
} from "../internal/postWriteChecks.js";

const editInputSchema = () =>
  z
    .object({
      old_string: z.string().min(1).describe("The text to replace"),
      new_string: z.string().describe("The text to replace with"),
      replace_all: z.boolean().optional().default(false)
    })
    .strict();

export const FileMultiEditInputSchema = z
  .object({
    file_path: z
      .string()
      .describe(
        "Absolute path preferred; supports ~ and ~/..., plus workspace-relative paths, on the local filesystem"
      ),
    edits: z.array(editInputSchema()).min(1).describe("Sequential edits to apply to the file")
  })
  .strict();

export type FileMultiEditInput = z.infer<typeof FileMultiEditInputSchema>;

export interface FileMultiEditAppliedEdit {
  oldString: string;
  newString: string;
  actualOldString: string;
  replaceAll: boolean;
  matchCount: number;
  matchStrategy: string;
}

export interface FileMultiEditOutput {
  filePath: string;
  editCount: number;
  edits: FileMultiEditAppliedEdit[];
  structuredPatch: z.infer<ReturnType<typeof hunkSchema>>[];
  userModified: boolean;
  replaceAll: boolean;
  matchCount: number;
  formatter?: PostWriteFormatterResult;
  diagnostics?: PostWriteDiagnosticsResult;
}
