import type { LoadedSessionHistory, SessionResumePayload } from "./types.js";

export function prepareSessionResume(history: LoadedSessionHistory): SessionResumePayload {
  return {
    sessionId: history.sessionId,
    title: history.title,
    apiMessages: history.apiMessages,
    uiMessages: history.uiMessages,
    messageCount: history.messageCount
  };
}
