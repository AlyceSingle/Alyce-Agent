import type { McpConfigScope, McpServerConfig } from "../../mcp/types.js";

// Normalized result for built-in REPL commands.
export type ParsedCommand =
  | { type: "none" }
  | { type: "help" }
  | { type: "doctor" }
  | { type: "plan-enter" }
  | { type: "plan-exit" }
  | { type: "clear" }
  | { type: "exit" }
  | { type: "open-settings"; section: "connection" | "session" }
  | { type: "open-permissions" }
  | { type: "trust-status" }
  | { type: "project-trust-set"; trusted: boolean }
  | { type: "connect-provider"; provider?: string; args: string[] }
  | { type: "logout-provider"; provider: string }
  | { type: "open-session-picker" }
  | { type: "resume-session"; query: string }
  | { type: "sessions-list" }
  | { type: "command-error"; input: string; message: string }
  | { type: "remember"; note: string; persist: boolean }
  | { type: "memory-view" }
  | { type: "memory-clear"; clearPersistent: boolean }
  | { type: "add-directory"; directory: string; persist: boolean }
  | { type: "skills-list" }
  | { type: "skills-view"; name: string }
  | {
      type: "skills-set-enabled";
      enabled: boolean;
      target: "project" | "user";
      reference:
        | { kind: "name"; value: string }
        | { kind: "id"; value: string }
        | { kind: "path"; value: string }
        | { kind: "bundled" };
    }
  | { type: "skills-refresh" }
  | { type: "mcp-list" }
  | { type: "mcp-status" }
  | { type: "mcp-tools"; serverName?: string }
  | { type: "mcp-resources"; serverName?: string }
  | { type: "mcp-prompts"; serverName?: string }
  | { type: "mcp-prompt"; serverName: string; promptName: string; args: Record<string, string> }
  | { type: "mcp-templates"; serverName?: string }
  | { type: "mcp-login"; serverName: string }
  | { type: "mcp-add"; scope: McpConfigScope; name: string; config: McpServerConfig }
  | { type: "mcp-remove"; scope: McpConfigScope; name: string }
  | { type: "mcp-set-enabled"; enabled: boolean; scope: McpConfigScope; name: string }
  | { type: "open-model-picker" }
  | { type: "switch-model"; model: string }
  | { type: "tasks-list" }
  | { type: "tasks-get"; taskId: string }
  | { type: "tasks-stop"; taskId: string }
  | { type: "tasks-cleanup"; apply: boolean }
  | { type: "processes-list" }
  | { type: "process-stop"; processId: string }
  | { type: "usage-view" }
  | { type: "diff-view"; target: "overview" | "last" | "current" | { turnId: string } }
  | { type: "revert" }
  | { type: "context-preview"; nextUserInput?: string };

export function createMigrationCommandError(input: string, message: string): Extract<ParsedCommand, { type: "command-error" }> {
  return {
    type: "command-error",
    input,
    message
  };
}
