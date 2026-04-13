import type OpenAI from "openai";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  BASH_TOOL_DESCRIPTION,
  BASH_TOOL_NAME,
  BashInputSchema,
  executeBashTool
} from "./BashTool/BashTool.js";
import { FILE_EDIT_TOOL_DESCRIPTION, executeFileEdit, FileEditInputSchema } from "./FileEditTool/FileEditTool.js";
import { executeFileRead, FileReadInputSchema } from "./FileReadTool/FileReadTool.js";
import { DESCRIPTION, FILE_READ_TOOL_NAME } from "./FileReadTool/prompt.js";
import {
  executeFileWrite,
  FILE_WRITE_TOOL_DESCRIPTION,
  FileWriteInputSchema
} from "./FileWriteTool/FileWriteTool.js";
import {
  executeWebFetchTool,
  WEB_FETCH_TOOL_DESCRIPTION,
  WEB_FETCH_TOOL_NAME,
  WebFetchInputSchema
} from "./WebFetchTool/WebFetchTool.js";
import {
  executeWebSearchTool,
  WEB_SEARCH_TOOL_DESCRIPTION,
  WEB_SEARCH_TOOL_NAME,
  WebSearchInputSchema
} from "./WebSearchTool/WebSearchTool.js";
import type { ToolExecutionContext } from "./types.js";

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

export const REGISTERED_TOOLS: AgentTool[] = [
  {
    name: FILE_READ_TOOL_NAME,
    description: DESCRIPTION,
    inputSchema: FileReadInputSchema,
    execute: (input, context) => executeFileRead(input, context)
  },
  {
    name: "Edit",
    description: FILE_EDIT_TOOL_DESCRIPTION,
    inputSchema: FileEditInputSchema,
    execute: (input, context) => executeFileEdit(input, context)
  },
  {
    name: "Write",
    description: FILE_WRITE_TOOL_DESCRIPTION,
    inputSchema: FileWriteInputSchema,
    execute: (input, context) => executeFileWrite(input, context)
  },
  {
    name: BASH_TOOL_NAME,
    description: BASH_TOOL_DESCRIPTION,
    inputSchema: BashInputSchema,
    execute: (input, context) => executeBashTool(input, context)
  },
  {
    name: WEB_FETCH_TOOL_NAME,
    description: WEB_FETCH_TOOL_DESCRIPTION,
    inputSchema: WebFetchInputSchema,
    execute: (input, context) => executeWebFetchTool(input, context)
  },
  {
    name: WEB_SEARCH_TOOL_NAME,
    description: WEB_SEARCH_TOOL_DESCRIPTION,
    inputSchema: WebSearchInputSchema,
    execute: (input, context) => executeWebSearchTool(input, context)
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
