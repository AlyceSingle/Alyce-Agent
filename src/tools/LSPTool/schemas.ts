import { z } from "zod";

export const LSP_OPERATION_VALUES = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls"
] as const;

export const LspOperationSchema = z.enum(LSP_OPERATION_VALUES);

export const LSPToolInputSchema = z
  .object({
    operation: LspOperationSchema.describe("The LSP operation to perform."),
    filePath: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Absolute path preferred; supports ~ and ~/..., plus workspace-relative paths on the local filesystem."
      ),
    line: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "The 1-based line number, as shown in editors. Required for position-based operations."
      ),
    character: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "The 1-based character offset, as shown in editors. Required for position-based operations."
      ),
    query: z
      .string()
      .trim()
      .optional()
      .describe("Optional workspace symbol search query. Only used by workspaceSymbol."),
    maxResults: z
      .number()
      .int()
      .positive()
      .max(500)
      .optional()
      .describe("Optional maximum result count for workspaceSymbol. Defaults to 100.")
  })
  .strict();

export const LSPToolOutputSchema = z
  .object({
    operation: LspOperationSchema,
    result: z.string(),
    filePath: z.string(),
    backend: z.literal("typescript-language-service"),
    resultCount: z.number().int().nonnegative().optional(),
    fileCount: z.number().int().nonnegative().optional()
  })
  .strict();

export type LSPOperation = z.infer<typeof LspOperationSchema>;
export type LSPToolInput = z.infer<typeof LSPToolInputSchema>;
export type LSPToolResult = z.infer<typeof LSPToolOutputSchema>;
