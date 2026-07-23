// 兼容入口：展示实现位于 toolDisplay/*，按 tool 族拆分维护。
export {
  STREAMING_MESSAGE_METADATA,
  createSystemMessage,
  createUserMessage,
  createAssistantMessage,
  isStreamingUiMessage,
  createThinkingMessage,
  createErrorMessage,
  createDiagnosticsFollowUpMessage,
  formatDiagnosticsFollowUpForModel,
  shouldSkipThinkingContent,
  shouldKeepUiMessage,
  isEphemeralProgressMessage,
  createToolResultMessage
} from "./toolDisplay/index.js";
