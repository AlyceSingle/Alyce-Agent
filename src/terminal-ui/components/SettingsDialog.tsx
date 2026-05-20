import { useEffect, useState } from "react";
import type {
  SessionSettings,
  SessionSettingsState
} from "../../config/runtime.js";
import { getBuiltinPersonaPresetNames } from "../../core/prompt/fragments/personaPresets.js";
import { useRegisterOverlay } from "../context/overlayContext.js";
import { Box, Text, useInput } from "../runtime/ink.js";
import { terminalUiTheme } from "../theme/theme.js";
import { normalizeInlineValue } from "../utils/text.js";
import { Pane } from "./Pane.js";

type EditableConfig = SessionSettings;

type FieldDefinition = {
  key: keyof SessionSettings;
  label: string;
  type: "text" | "number" | "toggle" | "select";
  options?: string[];
};

const PERSONA_OPTIONS = ["", ...getBuiltinPersonaPresetNames()];

const FIELD_DEFINITIONS: FieldDefinition[] = [
  {
    key: "approvalMode",
    label: "Approval Mode",
    type: "select",
    options: ["read-only", "default", "auto-review", "full-access"]
  },
  {
    key: "personaPreset",
    label: "Persona Preset",
    type: "select",
    options: PERSONA_OPTIONS
  },
  {
    key: "aiPersonalityPrompt",
    label: "Persona Overlay",
    type: "text"
  },
  {
    key: "appendSystemPrompt",
    label: "Append Prompt",
    type: "text"
  },
  { key: "languagePreference", label: "Language", type: "text" },
  { key: "sessionMemoryEnabled", label: "Session Memory", type: "toggle" },
  {
    key: "scrollAccelerationEnabled",
    label: "Scroll Acceleration",
    type: "toggle"
  },
  {
    key: "historyPagingEnabled",
    label: "History Paging",
    type: "toggle"
  },
  {
    key: "messageTimestampsEnabled",
    label: "Current System Time",
    type: "toggle"
  },
  {
    key: "markdownMessageRenderingEnabled",
    label: "Markdown Messages",
    type: "toggle"
  },
  {
    key: "markdownToolMessageRenderingEnabled",
    label: "Tool Markdown",
    type: "toggle"
  },
  {
    key: "thinkingMessagesExpandedByDefault",
    label: "THINK Default Expanded",
    type: "toggle"
  },
  {
    key: "conversationCompactionEnabled",
    label: "Conversation Compaction",
    type: "toggle"
  },
  {
    key: "modelContextWindowOverrides",
    label: "Context Window Overrides",
    type: "text"
  },
  { key: "maxSteps", label: "Max Steps", type: "number" },
  { key: "commandTimeoutMs", label: "Command Timeout", type: "number" },
  { key: "scrollSpeed", label: "Scroll Speed", type: "number" },
  {
    key: "maxMessagesWithoutVirtualization",
    label: "Max Non-Virtual Messages",
    type: "number"
  },
  {
    key: "markdownRenderMaxChars",
    label: "Markdown Max Chars",
    type: "number"
  },
  {
    key: "diagnosticsPendingTimeoutMs",
    label: "Diagnostics Timeout",
    type: "number"
  },
  {
    key: "diagnosticsFailureThreshold",
    label: "Diagnostics Fail Threshold",
    type: "number"
  },
  {
    key: "diagnosticsFailureCooldownMs",
    label: "Diagnostics Cooldown",
    type: "number"
  },
  { key: "autoCompactTimeoutMs", label: "Auto Compact Timeout", type: "number" },
  { key: "autoCompactMaxFailures", label: "Auto Compact Max Failures", type: "number" }
];

function encodeTextValue(value: string | undefined) {
  return value?.replace(/\r?\n/g, "\\n") ?? "";
}

function decodeTextValue(value: string) {
  const normalized = value.trim();
  return normalized ? normalized.replace(/\\n/g, "\n") : undefined;
}

function encodeContextWindowOverrides(value: SessionSettings["modelContextWindowOverrides"]) {
  return Object.entries(value)
    .map(([pattern, tokens]) => `${pattern}=${tokens}`)
    .join(", ");
}

function decodeContextWindowOverrides(value: string): SessionSettings["modelContextWindowOverrides"] {
  const overrides: SessionSettings["modelContextWindowOverrides"] = {};
  const normalized = value.trim();
  if (!normalized) {
    return overrides;
  }

  for (const entry of normalized.split(",")) {
    // 允许 pattern 自身包含 "="，因此从最后一个 "=" 开始切分。
    const separatorIndex = entry.lastIndexOf("=");
    if (separatorIndex <= 0) {
      throw new Error("Context Window Overrides must use pattern=tokens entries separated by commas.");
    }

    const pattern = entry.slice(0, separatorIndex).trim();
    const tokens = Number(entry.slice(separatorIndex + 1).trim());
    if (!pattern || !Number.isFinite(tokens) || tokens <= 0) {
      throw new Error("Context Window Overrides entries must have a non-empty pattern and positive token count.");
    }

    overrides[pattern] = Math.trunc(tokens);
  }

  return overrides;
}

function getFieldValue(config: EditableConfig, field: FieldDefinition): string {
  const value = config[field.key];
  if (field.type === "toggle") {
    return value ? "on" : "off";
  }

  if (field.type === "number") {
    return String(value ?? "");
  }

  if (field.type === "select") {
    return String(value ?? "");
  }

  if (field.key === "modelContextWindowOverrides") {
    return encodeContextWindowOverrides(
      value && typeof value === "object" && !Array.isArray(value)
        ? value as SessionSettings["modelContextWindowOverrides"]
        : {}
    );
  }

  return encodeTextValue(typeof value === "string" ? value : undefined);
}

function getSourceLabel(source: string) {
  switch (source) {
    case "project":
      return "project file";
    case "user":
      return "user file";
    case "env":
      return "environment";
    case "cli":
      return "CLI flag";
    default:
      return "built-in default";
  }
}

function buildPatch<T extends object>(
  fields: FieldDefinition[],
  initialConfig: EditableConfig,
  currentConfig: EditableConfig
): Partial<T> {
  const patch = {} as Partial<T>;

  for (const field of fields) {
    const key = field.key as keyof T;
    const nextValue = currentConfig[field.key];
    const initialValue = initialConfig[field.key];

    // 只持久化真正改动过的字段，避免把未修改配置重新写回。
    if (!areFieldValuesEqual(field, initialValue, nextValue)) {
      patch[key] = nextValue as T[keyof T];
    }
  }

  return patch;
}

function areFieldValuesEqual(field: FieldDefinition, left: unknown, right: unknown): boolean {
  if (field.key === "modelContextWindowOverrides") {
    return encodeContextWindowOverrides(
      left && typeof left === "object" && !Array.isArray(left)
        ? left as SessionSettings["modelContextWindowOverrides"]
        : {}
    ) === encodeContextWindowOverrides(
      right && typeof right === "object" && !Array.isArray(right)
        ? right as SessionSettings["modelContextWindowOverrides"]
        : {}
    );
  }

  return Object.is(left, right);
}

export function SettingsDialog(props: {
  visible: boolean;
  reason?: string;
  settings: SessionSettings;
  settingsState: SessionSettingsState;
  onClose: () => void;
  onSave: (settingsPatch: Partial<SessionSettings>) => Promise<void>;
  onCtrlCCaptureChange: (capture: boolean) => void;
}) {
  const initialEditableConfig: EditableConfig = props.settings;
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isEditing, setIsEditing] = useState(false);
  const [draftValue, setDraftValue] = useState("");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [initialConfig, setInitialConfig] = useState<EditableConfig>(initialEditableConfig);
  const [config, setConfig] = useState<EditableConfig>(initialEditableConfig);

  useRegisterOverlay("settings", props.visible);

  // Connection provider setup lives in /connect; this dialog only edits session/runtime behavior.
  const fields = FIELD_DEFINITIONS;
  const currentField = fields[selectedIndex] ?? fields[0];
  const sourceInfo =
    currentField
      ? {
          source: props.settingsState.sources[currentField.key] ?? "default",
          saveTargetPath: props.settingsState.saveTargetPath,
          fallbackPath: props.settingsState.projectPath
        }
      : null;

  useEffect(() => {
    if (!props.visible) {
      return;
    }

    const nextConfig = props.settings;
    setSelectedIndex(0);
    setIsEditing(false);
    setDraftValue("");
    setErrorText(null);
    setIsSaving(false);
    setInitialConfig(nextConfig);
    setConfig(nextConfig);
  }, [props.settings, props.visible]);

  useEffect(() => {
    props.onCtrlCCaptureChange(props.visible && !isSaving && isEditing && draftValue.length > 0);
  }, [draftValue, isEditing, isSaving, props.onCtrlCCaptureChange, props.visible]);

  useEffect(() => {
    return () => {
      props.onCtrlCCaptureChange(false);
    };
  }, [props.onCtrlCCaptureChange]);

  useInput((input, key) => {
    if (!props.visible || isSaving) {
      return;
    }

    if (isEditing && currentField) {
      if (key.return) {
        commitFieldValue(currentField);
        return;
      }

      if (key.escape) {
        setIsEditing(false);
        setDraftValue("");
        return;
      }

      if (key.backspace) {
        setDraftValue((current) => current.slice(0, -1));
        return;
      }

      if (key.delete) {
        setDraftValue("");
        return;
      }

      if (key.ctrl && input.toLowerCase() === "c") {
        if (!draftValue.length) {
          return;
        }

        setDraftValue("");
        return;
      }

      if (key.ctrl || key.meta || !input) {
        return;
      }

      setDraftValue((current) => current + input);
      return;
    }

    if (key.escape) {
      props.onClose();
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((current) => Math.max(0, current - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((current) => Math.min(fields.length - 1, current + 1));
      return;
    }

    if (!currentField) {
      return;
    }

    if (input.toLowerCase() === "s") {
      void saveAll();
      return;
    }

    if (currentField.type === "toggle" && (key.return || input === " ")) {
      setConfig((current) => ({
        ...current,
        [currentField.key]: !current[currentField.key]
      }));
      return;
    }

    if (currentField.type === "select" && (key.return || input === " ")) {
      cycleSelectField(currentField, 1);
      return;
    }

    if (key.return) {
      setDraftValue(getFieldValue(config, currentField));
      setIsEditing(true);
    }
  }, { isActive: props.visible });

  if (!props.visible) {
    return null;
  }

  const visibleCount = 8;
  const startIndex = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(visibleCount / 2), fields.length - visibleCount)
  );
  const visibleFields = fields.slice(startIndex, startIndex + visibleCount);
  const hasRuntimeOverride = sourceInfo?.source === "env" || sourceInfo?.source === "cli";

  return (
    <Pane
      title="Settings"
      subtitle={props.reason ?? "Session settings"}
      accentColor={terminalUiTheme.colors.chrome}
      footer="↑/↓ move | Enter edit | S save | Esc close"
    >
      <Box flexDirection="column" marginTop={1} width="100%">
        {visibleFields.map((field, index) => {
          const actualIndex = startIndex + index;
          const isSelected = actualIndex === selectedIndex;
          const rawValue = getFieldValue(config, field);
          const valueLabel = normalizeInlineValue(rawValue);

          return (
            <Box key={field.key} width="100%">
              <Text
                color={isSelected ? terminalUiTheme.colors.chrome : terminalUiTheme.colors.muted}
                backgroundColor={isSelected ? terminalUiTheme.colors.selection : undefined}
                wrap="truncate-end"
              >
                {isSelected ? ">" : " "}
                {" "}
                {field.label}: {valueLabel}
              </Text>
            </Box>
          );
        })}
      </Box>
      {currentField && sourceInfo ? (
        <Box flexDirection="column" marginTop={1} width="100%">
          <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
            Current field: {currentField.label}
          </Text>
          <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
            Source: {getSourceLabel(sourceInfo.source)}
            {" | "}
            Save target: {normalizeInlineValue(sourceInfo.saveTargetPath, "(none)")}
          </Text>
          {sourceInfo.fallbackPath ? (
            <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
              Project fallback: {normalizeInlineValue(sourceInfo.fallbackPath, "(none)")}
            </Text>
          ) : null}
          {hasRuntimeOverride ? (
            <Text color={terminalUiTheme.colors.warning} wrap="truncate-end">
              {`This field is currently overridden by ${sourceInfo.source}. Saved changes will apply after the override is removed.`}
            </Text>
          ) : null}
          {isEditing ? (
            <Text color={terminalUiTheme.colors.chrome} wrap="truncate-end">
              Draft: {normalizeInlineValue(draftValue, "")}
            </Text>
          ) : (
            <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
              {currentField.key === "modelContextWindowOverrides"
                  ? "Use comma-separated pattern=tokens entries, for example custom fast=512000."
                  : currentField.key === "markdownToolMessageRenderingEnabled"
                    ? "When off, tool results always use plain/code sections even if markdown-capable."
                  : currentField.key === "thinkingMessagesExpandedByDefault"
                    ? "When off, THINK messages start collapsed and can still be expanded by clicking them."
                  : currentField.key === "diagnosticsPendingTimeoutMs"
                    ? "Background diagnostics are marked failed after this timeout."
                    : currentField.key === "diagnosticsFailureThreshold"
                      ? "Open diagnostics circuit breaker after this many consecutive failures."
                      : currentField.key === "diagnosticsFailureCooldownMs"
                        ? "Circuit breaker cooldown before diagnostics retry automatically."
                    : currentField.key === "scrollSpeed"
                      ? "Scroll speed applies to line-by-line scrolling. Valid range: 1-8."
                      : currentField.key === "scrollAccelerationEnabled"
                        ? "When on, consecutive line scroll input ramps speed up within a short window."
                        : currentField.key === "historyPagingEnabled"
                          ? "Experimental: resume long sessions with recent messages first, then load older chunks near the top."
                  : currentField.type === "text"
                  ? "Text fields accept \\n for line breaks."
                  : currentField.type === "number"
                    ? "Number fields are persisted as positive integers."
                    : "Toggle or cycle this field with Enter. Not set is saved as an explicit clear value."}
            </Text>
          )}
        </Box>
      ) : null}
      <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
        External path access is available directly on the local filesystem.
      </Text>
      {errorText ? (
        <Text color={terminalUiTheme.colors.danger} wrap="truncate-end">
          {errorText}
        </Text>
      ) : null}
      {isSaving ? (
        <Text color={terminalUiTheme.colors.info} wrap="truncate-end">
          Saving...
        </Text>
      ) : null}
    </Pane>
  );

  function cycleSelectField(field: FieldDefinition, delta: number) {
    const options = field.options ?? [];
    if (options.length === 0) {
      return;
    }

    const currentValue = String(config[field.key] ?? "");
    const currentIndex = Math.max(0, options.indexOf(currentValue));
    const nextIndex = (currentIndex + delta + options.length) % options.length;
    const nextValue = options[nextIndex] ?? "";
    setConfig((current) => ({
      ...current,
      [field.key]: nextValue || undefined
    }));
  }

  function commitFieldValue(field: FieldDefinition) {
    try {
      setConfig((current) => {
        if (field.type === "number") {
          const parsed = Number(draftValue);
          if (!Number.isFinite(parsed) || parsed <= 0) {
            throw new Error(`${field.label} must be a positive number.`);
          }

          if (field.key === "scrollSpeed" && parsed > 8) {
            throw new Error("Scroll Speed must be between 1 and 8.");
          }

          return {
            ...current,
            [field.key]: Math.trunc(parsed)
          };
        }

        if (field.type === "toggle") {
          return {
            ...current,
            [field.key]: draftValue.trim().toLowerCase() === "on"
          };
        }

        if (field.key === "modelContextWindowOverrides") {
          return {
            ...current,
            [field.key]: decodeContextWindowOverrides(draftValue)
          };
        }

        const textValue = decodeTextValue(draftValue);
        return {
          ...current,
          [field.key]: textValue
        };
      });

      setErrorText(null);
      setIsEditing(false);
      setDraftValue("");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveAll() {
    setIsSaving(true);
    setErrorText(null);
    try {
      const settingsPatch = buildPatch<SessionSettings>(FIELD_DEFINITIONS, initialConfig, config);
      await props.onSave(settingsPatch);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  }
}
