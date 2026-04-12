import type OpenAI from "openai";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { runCommand } from "./builtin/commandTool.js";
import { listFiles, readFile, writeFile } from "./builtin/fsTools.js";
import type { JsonRecord, ToolExecutionContext } from "./types.js";

type AnyZodSchema = z.ZodTypeAny;

type FunctionParameters = NonNullable<
  OpenAI.Chat.Completions.ChatCompletionTool["function"]["parameters"]
>;

export interface AgentTool<TInputSchema extends AnyZodSchema = AnyZodSchema> {
  name: string;
  description: string;
  inputSchema: TInputSchema;
  execute: (input: z.infer<TInputSchema>, context: ToolExecutionContext) => Promise<unknown>;
}

const ListFilesInputSchema = z
  .object({
    path: z.string().optional().describe("Workspace-relative path, defaults to '.'")
  })
  .strict();

const ReadFileInputSchema = z
  .object({
    path: z.string().describe("Workspace-relative file path"),
    startLine: z.number().int().positive().optional().describe("1-based start line"),
    endLine: z.number().int().positive().optional().describe("1-based end line")
  })
  .strict();

const WriteFileInputSchema = z
  .object({
    path: z.string().describe("Workspace-relative file path"),
    content: z.string().describe("Text content to write"),
    append: z.boolean().optional().describe("If true, append instead of overwrite")
  })
  .strict();

const RunCommandInputSchema = z
  .object({
    command: z.string().describe("Shell command to execute"),
    cwd: z.string().optional().describe("Optional workspace-relative cwd")
  })
  .strict();

export const REGISTERED_TOOLS: AgentTool[] = [
  {
    name: "list_files",
    description: "List files and directories under a workspace path.",
    inputSchema: ListFilesInputSchema,
    execute: (input, context) => listFiles(input as JsonRecord, context)
  },
  {
    name: "read_file",
    description: "Read a text file from the workspace.",
    inputSchema: ReadFileInputSchema,
    execute: (input, context) => readFile(input as JsonRecord, context)
  },
  {
    name: "write_file",
    description: "Write text content to a workspace file.",
    inputSchema: WriteFileInputSchema,
    execute: (input, context) => writeFile(input as JsonRecord, context)
  },
  {
    name: "run_command",
    description: "Run a shell command in the workspace.",
    inputSchema: RunCommandInputSchema,
    execute: (input, context) => runCommand(input as JsonRecord, context)
  }
];

const TOOL_BY_NAME = new Map(REGISTERED_TOOLS.map((tool) => [tool.name, tool]));

function toFunctionParameters(schema: AnyZodSchema): FunctionParameters {
  const jsonSchema = zodToJsonSchema(schema, {
    $refStrategy: "none"
  }) as Record<string, unknown>;

  const { $schema: _schema, definitions: _definitions, ...normalized } = jsonSchema;

  if (normalized.type !== "object") {
    throw new Error("Tool input schema must compile to a JSON object schema.");
  }

  return normalized as FunctionParameters;
}

export const TOOL_SCHEMAS: OpenAI.Chat.Completions.ChatCompletionTool[] = REGISTERED_TOOLS.map((tool) => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: toFunctionParameters(tool.inputSchema)
  }
}));

export function getToolDefinition(name: string): AgentTool | undefined {
  return TOOL_BY_NAME.get(name);
}
