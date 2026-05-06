import type OpenAI from "openai";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  AGENT_TOOL_DESCRIPTION,
  AgentToolInputSchema,
  executeAgentTool
} from "./AgentTool/AgentTool.js";
import { AGENT_TOOL_NAME } from "./AgentTool/prompt.js";
import {
  ASK_USER_QUESTION_TOOL_DESCRIPTION,
  ASK_USER_QUESTION_TOOL_NAME,
  AskUserQuestionInputSchema,
  executeAskUserQuestionTool
} from "./AskUserQuestionTool/AskUserQuestionTool.js";
import {
  BASH_TOOL_DESCRIPTION,
  BASH_TOOL_NAME,
  BashInputSchema,
  executeBashTool
} from "./BashTool/BashTool.js";
import {
  executeFileApplyPatch,
  FILE_APPLY_PATCH_TOOL_DESCRIPTION,
  FileApplyPatchInputSchema
} from "./FileApplyPatchTool/FileApplyPatchTool.js";
import { FILE_APPLY_PATCH_TOOL_NAME } from "./FileApplyPatchTool/prompt.js";
import { FILE_EDIT_TOOL_DESCRIPTION, executeFileEdit, FileEditInputSchema } from "./FileEditTool/FileEditTool.js";
import {
  executeFileMultiEdit,
  FILE_MULTI_EDIT_TOOL_DESCRIPTION
} from "./FileMultiEditTool/FileMultiEditTool.js";
import { FILE_MULTI_EDIT_TOOL_NAME } from "./FileMultiEditTool/prompt.js";
import { FileMultiEditInputSchema } from "./FileMultiEditTool/types.js";
import { executeFileRead, FileReadInputSchema } from "./FileReadTool/FileReadTool.js";
import { DESCRIPTION, FILE_READ_TOOL_NAME } from "./FileReadTool/prompt.js";
import {
  executeFileWrite,
  FILE_WRITE_TOOL_DESCRIPTION,
  FileWriteInputSchema
} from "./FileWriteTool/FileWriteTool.js";
import {
  executeGlobTool,
  GLOB_TOOL_DESCRIPTION,
  GLOB_TOOL_NAME,
  GlobInputSchema
} from "./GlobTool/GlobTool.js";
import {
  executeGrepTool,
  GREP_TOOL_DESCRIPTION,
  GREP_TOOL_NAME,
  GrepInputSchema
} from "./GrepTool/GrepTool.js";
import {
  executeLSPTool,
  LSPInputSchema,
  LSP_TOOL_DESCRIPTION,
  LSP_TOOL_NAME
} from "./LSPTool/LSPTool.js";
import {
  executePowerShellTool,
  POWERSHELL_TOOL_DESCRIPTION,
  POWERSHELL_TOOL_NAME,
  PowerShellInputSchema
} from "./PowerShellTool/PowerShellTool.js";
import {
  executeTaskGetTool,
  TASK_GET_TOOL_DESCRIPTION,
  TASK_GET_TOOL_NAME,
  TaskGetInputSchema
} from "./TaskGetTool/TaskGetTool.js";
import {
  executeTaskListTool,
  TASK_LIST_TOOL_DESCRIPTION,
  TASK_LIST_TOOL_NAME,
  TaskListInputSchema
} from "./TaskListTool/TaskListTool.js";
import {
  executeTaskStopTool,
  TASK_STOP_TOOL_DESCRIPTION,
  TASK_STOP_TOOL_NAME,
  TaskStopInputSchema
} from "./TaskStopTool/TaskStopTool.js";
import {
  executeTodoWriteTool,
  TODO_WRITE_TOOL_DESCRIPTION,
  TODO_WRITE_TOOL_NAME,
  TodoWriteInputSchema
} from "./TodoWriteTool/TodoWriteTool.js";
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
import { KNOWN_TOOL_NAMES } from "./toolNames.js";
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
    name: AGENT_TOOL_NAME,
    description: AGENT_TOOL_DESCRIPTION,
    inputSchema: AgentToolInputSchema,
    execute: (input, context) => executeAgentTool(input, context)
  },
  {
    name: TASK_LIST_TOOL_NAME,
    description: TASK_LIST_TOOL_DESCRIPTION,
    inputSchema: TaskListInputSchema,
    execute: (input, context) => executeTaskListTool(input, context)
  },
  {
    name: TASK_GET_TOOL_NAME,
    description: TASK_GET_TOOL_DESCRIPTION,
    inputSchema: TaskGetInputSchema,
    execute: (input, context) => executeTaskGetTool(input, context)
  },
  {
    name: TASK_STOP_TOOL_NAME,
    description: TASK_STOP_TOOL_DESCRIPTION,
    inputSchema: TaskStopInputSchema,
    execute: (input, context) => executeTaskStopTool(input, context)
  },
  {
    name: ASK_USER_QUESTION_TOOL_NAME,
    description: ASK_USER_QUESTION_TOOL_DESCRIPTION,
    inputSchema: AskUserQuestionInputSchema,
    execute: (input, context) => executeAskUserQuestionTool(input, context)
  },
  {
    name: FILE_READ_TOOL_NAME,
    description: DESCRIPTION,
    inputSchema: FileReadInputSchema,
    execute: (input, context) => executeFileRead(input, context)
  },
  {
    name: GLOB_TOOL_NAME,
    description: GLOB_TOOL_DESCRIPTION,
    inputSchema: GlobInputSchema,
    execute: (input, context) => executeGlobTool(input, context)
  },
  {
    name: GREP_TOOL_NAME,
    description: GREP_TOOL_DESCRIPTION,
    inputSchema: GrepInputSchema,
    execute: (input, context) => executeGrepTool(input, context)
  },
  {
    name: LSP_TOOL_NAME,
    description: LSP_TOOL_DESCRIPTION,
    inputSchema: LSPInputSchema,
    execute: (input, context) => executeLSPTool(input, context)
  },
  {
    name: TODO_WRITE_TOOL_NAME,
    description: TODO_WRITE_TOOL_DESCRIPTION,
    inputSchema: TodoWriteInputSchema,
    execute: (input, context) => executeTodoWriteTool(input, context)
  },
  {
    name: "Edit",
    description: FILE_EDIT_TOOL_DESCRIPTION,
    inputSchema: FileEditInputSchema,
    execute: (input, context) => executeFileEdit(input, context)
  },
  {
    name: FILE_MULTI_EDIT_TOOL_NAME,
    description: FILE_MULTI_EDIT_TOOL_DESCRIPTION,
    inputSchema: FileMultiEditInputSchema,
    execute: (input, context) => executeFileMultiEdit(input, context)
  },
  {
    name: FILE_APPLY_PATCH_TOOL_NAME,
    description: FILE_APPLY_PATCH_TOOL_DESCRIPTION,
    inputSchema: FileApplyPatchInputSchema,
    execute: (input, context) => executeFileApplyPatch(input, context)
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
    name: POWERSHELL_TOOL_NAME,
    description: POWERSHELL_TOOL_DESCRIPTION,
    inputSchema: PowerShellInputSchema,
    execute: (input, context) => executePowerShellTool(input, context)
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
const REGISTERED_TOOL_NAMES = new Set(REGISTERED_TOOLS.map((tool) => tool.name));

if (KNOWN_TOOL_NAMES.size !== REGISTERED_TOOL_NAMES.size) {
  throw new Error("KNOWN_TOOL_NAMES must match REGISTERED_TOOLS.");
}

for (const toolName of KNOWN_TOOL_NAMES) {
  if (!REGISTERED_TOOL_NAMES.has(toolName)) {
    throw new Error(`KNOWN_TOOL_NAMES contains unregistered tool: ${toolName}`);
  }
}

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

const TOOL_SCHEMA_BY_NAME = new Map(TOOL_SCHEMAS.map((schema) => [schema.function.name, schema]));

export function getToolDefinition(name: string): AgentTool | undefined {
  return TOOL_BY_NAME.get(name);
}

export function getToolSchemasByName(toolNames: readonly string[]) {
  return toolNames
    .map((name) => TOOL_SCHEMA_BY_NAME.get(name))
    .filter((schema): schema is OpenAI.Chat.Completions.ChatCompletionTool => schema !== undefined);
}
