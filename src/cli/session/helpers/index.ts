export {
  isPathInsideDirectory,
  isGitRepository,
  pathExists,
  runGitCommand
} from "./gitPaths.js";

export { mergeFileRestoreResults } from "./fileRestore.js";

export {
  mergePersistedSource,
  mergeUserProviderProfile,
  applyAuthToConnectionState,
  applyRuntimeProviderModelOverrides,
  cloneConnectionConfigState,
  cloneSessionSettingsState
} from "./connectionState.js";

export {
  createContextBudgetService,
  createConversationCompactionConfig,
  createSessionMemoryConfig,
  normalizeConnectionPatch,
  normalizeSettingsPatch,
  isFileBackupSnapshotEnabled,
  resolveAllowedRoots
} from "./settingsPatch.js";

export {
  getCurrentDateLabel,
  messagesContainPrefix
} from "./misc.js";
