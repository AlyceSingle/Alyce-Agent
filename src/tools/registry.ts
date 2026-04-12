import OpenAI from "openai";

export const TOOL_SCHEMAS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and directories under a workspace path.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative path, defaults to '.'"
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file from the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative file path"
          },
          startLine: {
            type: "number",
            description: "1-based start line, defaults to 1"
          },
          endLine: {
            type: "number",
            description: "1-based end line, defaults to startLine + 299"
          }
        },
        required: ["path"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write text content to a workspace file.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative file path"
          },
          content: {
            type: "string",
            description: "Text content to write"
          },
          append: {
            type: "boolean",
            description: "If true, append instead of overwrite"
          }
        },
        required: ["path", "content"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command in the workspace.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command to execute"
          },
          cwd: {
            type: "string",
            description: "Optional workspace-relative cwd"
          }
        },
        required: ["command"],
        additionalProperties: false
      }
    }
  }
];

export function getRegisteredToolNames() {
  return TOOL_SCHEMAS.map((schema) => schema.function.name).sort((a, b) => a.localeCompare(b));
}
