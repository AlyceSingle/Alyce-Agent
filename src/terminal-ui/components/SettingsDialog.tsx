import { useEffect, useState } from "react";
import { t } from "../../i18n/index.js";
import type {
  SessionSettings,
  SessionSettingsState
} from "../../config/runtime.js";
import { getBuiltinPersonaPresetNames } from "../../core/prompt/fragments/personaPresets.js";
import { useRegisterOverlay } from "../context/overlayContext.js";
import Box from "../runtime/ink-runtime/components/Box.js";
import Text from "../runtime/ink-runtime/components/Text.js";
import useInput from "../runtime/ink-runtime/hooks/use-input.js";
import { terminalUiTheme } from "../theme/theme.js";
import { normalizeInlineValue } from "../utils/text.js";
import { Pane } from "./Pane.js";

type EditableConfig = SessionSettings;

type FieldDefinition = {
  key: keyof SessionSettings;
  label: string;
  labelKey?: string;
  type: "text" | "number" | "toggle" | "select";
  options?: string[];
};

const PERSONA_OPTIONS = ["", ...getBuiltinPersonaPresetNames()];

const FIELD_DEFINITIONS: FieldDefinition[] = [
  {
    key: "uiLanguage",
    label: "UI Language",
    labelKey: "settingsDialog.field.uiLanguage",
    type: "select",
    options: ["en", "zh"]
  },
  {
    key: "approvalMode",
    label: "Approval Mode",
    labelKey: "settingsDialog.field.approvalMode",
    type: "select",
    options: ["read-only", "default", "auto-review", "full-access"]
  },
  {
    key: "personaPreset",
    label: "Persona Preset",
    labelKey: "settingsDialog.field.personaPreset",
    type: "select",
    options: PERSONA_OPTIONS
  },
  {
    key: "aiPersonalityPrompt",
    label: "Persona Overlay",
    labelKey: "settingsDialog.field.personaOverlay",
    type: "text"
  },
  {
    key: "appendSystemPrompt",
    label: "Append Prompt",
    labelKey: "settingsDialog.field.appendPrompt",
    type: "text"
  },
  { key: "languagePreference", label: "Language", labelKey: "settingsDialog.field.language", type: "text" },
  { key: "sessionMemoryEnabled", label: "Session Memory", labelKey: "settingsDialog.field.sessionMemory", type: "toggle" },
  {
    key: "scrollAccelerationEnabled",
    label: "Scroll Acceleration",
    labelKey: "settingsDialog.field.scrollAcceleration",
    type: "toggle"
  },
  {
    key: "historyPagingEnabled",
    label: "History Paging",
    labelKey: "settingsDialog.field.historyPaging",
    type: "toggle"
  },
  // 模型可见的系统时间注入（与下方 UI 消息时钟开关无关）
  {
    key: "messageTimestampsEnabled",
    label: "Current System Time",
    labelKey: "settingsDialog.field.currentSystemTime",
    type: "toggle"
  },
  // 界面 transcript 消息旁是否显示本地时间，默认关闭
  {
    key: "showMessageTimestamps",
    label: "Message Timestamps",
    labelKey: "settingsDialog.field.messageTimestamps",
    type: "toggle"
  },
  {
    key: "markdownMessageRenderingEnabled",
    label: "Markdown Messages",
    labelKey: "settingsDialog.field.markdownMessages",
    type: "toggle"
  },
  {
    key: "markdownToolMessageRenderingEnabled",
    label: "Tool Markdown",
    labelKey: "settingsDialog.field.toolMarkdown",
    type: "toggle"
  },
  {
    key: "thinkingMessagesExpandedByDefault",
    label: "THINK Default Expanded",
    labelKey: "settingsDialog.field.thinkDefaultExpanded",
    type: "toggle"
  },
  {
    key: "conversationCompactionEnabled",
    label: "Conversation Compaction",
    labelKey: "settingsDialog.field.conversationCompaction",
    type: "toggle"
  },
  {
    key: "modelContextWindowOverrides",
    label: "Context Window Overrides",
    labelKey: "settingsDialog.field.contextWindowOverrides",
    type: "text"
  },
  { key: "maxSteps", label: "Max Steps", labelKey: "settingsDialog.field.maxSteps", type: "number" },
  { key: "commandTimeoutMs", label: "Command Timeout", labelKey: "settingsDialog.field.commandTimeout", type: "number" },
  { key: "scrollSpeed", label: "Scroll Speed", labelKey: "settingsDialog.field.scrollSpeed", type: "number" },
  {
    key: "maxMessagesWithoutVirtualization",
    label: "Max Non-Virtual Messages",
    labelKey: "settingsDialog.field.maxNonVirtualMessages",
    type: "number"
  },
  {
    key: "markdownRenderMaxChars",
    label: "Markdown Max Chars",
    labelKey: "settingsDialog.field.markdownMaxChars",
    type: "number"
  },
  {
    key: "diagnosticsPendingTimeoutMs",
    label: "Diagnostics Timeout",
    labelKey: "settingsDialog.field.diagnosticsTimeout",
    type: "number"
  },
  {
    key: "diagnosticsFailureThreshold",
    label: "Diagnostics Fail Threshold",
    labelKey: "settingsDialog.field.diagnosticsFailThreshold",
    type: "number"
  },
  {
    key: "diagnosticsFailureCooldownMs",
    label: "Diagnostics Cooldown",
    labelKey: "settingsDialog.field.diagnosticsCooldown",
    type: "number"
  },
  { key: "autoCompactTimeoutMs", label: "Auto Compact Timeout", labelKey: "settingsDialog.field.autoCompactTimeout", type: "number" },
  { key: "autoCompactMaxFailures", label: "Auto Compact Max Failures", labelKey: "settingsDialog.field.autoCompactMaxFailures", type: "number" }
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
      throw new Error(t("settingsDialog.error.contextWindowFormat"));
    }

    const pattern = entry.slice(0, separatorIndex).trim();
    const tokens = Number(entry.slice(separatorIndex + 1).trim());
    if (!pattern || !Number.isFinite(tokens) || tokens <= 0) {
      throw new Error(t("settingsDialog.error.contextWindowEntry"));
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
    if (field.key === "uiLanguage") {
      return value === "zh" ? "中文" : "English";
    }
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
      return t("settingsDialog.source.projectFile");
    case "user":
      return t("settingsDialog.source.userFile");
    case "env":
      return t("settingsDialog.source.environment");
    case "cli":
      return t("settingsDialog.source.cliFlag");
    default:
      return t("settingsDialog.source.builtInDefault");
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
      title={t("settingsDialog.title")}
      subtitle={props.reason ?? t("settingsDialog.subtitle")}
      accentColor={terminalUiTheme.colors.chrome}
      footer={t("settingsDialog.footer")}
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
                {t(field.labelKey ?? field.label)}: {valueLabel}
              </Text>
            </Box>
          );
        })}
      </Box>
      {currentField && sourceInfo ? (
        <Box flexDirection="column" marginTop={1} width="100%">
          <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
            {t("settingsDialog.currentField")} {t(currentField.labelKey ?? currentField.label)}
          </Text>
          <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
            {t("settingsDialog.source")} {getSourceLabel(sourceInfo.source)}
            {" | "}
            {t("settingsDialog.saveTarget")} {normalizeInlineValue(sourceInfo.saveTargetPath, "(none)")}
          </Text>
          {sourceInfo.fallbackPath ? (
            <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
              {t("settingsDialog.projectFallback")} {normalizeInlineValue(sourceInfo.fallbackPath, "(none)")}
            </Text>
          ) : null}
          {hasRuntimeOverride ? (
            <Text color={terminalUiTheme.colors.warning} wrap="truncate-end">
              {t("settingsDialog.overrideWarning", { source: sourceInfo.source })}
            </Text>
          ) : null}
          {isEditing ? (
            <Text color={terminalUiTheme.colors.chrome} wrap="truncate-end">
              {t("settingsDialog.draft")} {normalizeInlineValue(draftValue, "")}
            </Text>
          ) : (
            <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
              {currentField.key === "modelContextWindowOverrides"
                  ? t("settingsDialog.help.contextWindowOverrides")
                  : currentField.key === "markdownToolMessageRenderingEnabled"
                    ? t("settingsDialog.help.toolMarkdown")
                  : currentField.key === "thinkingMessagesExpandedByDefault"
                    ? t("settingsDialog.help.thinkDefaultExpanded")
                  : currentField.key === "diagnosticsPendingTimeoutMs"
                    ? t("settingsDialog.help.diagnosticsTimeout")
                    : currentField.key === "diagnosticsFailureThreshold"
                      ? t("settingsDialog.help.diagnosticsFailThreshold")
                      : currentField.key === "diagnosticsFailureCooldownMs"
                        ? t("settingsDialog.help.diagnosticsCooldown")
                    : currentField.key === "scrollSpeed"
                      ? t("settingsDialog.help.scrollSpeed")
                      : currentField.key === "scrollAccelerationEnabled"
                        ? t("settingsDialog.help.scrollAcceleration")
                        : currentField.key === "historyPagingEnabled"
                          ? t("settingsDialog.help.historyPaging")
                          : currentField.key === "showMessageTimestamps"
                            ? t("settingsDialog.help.messageTimestamps")
                  : currentField.type === "text"
                  ? t("settingsDialog.help.text")
                  : currentField.type === "number"
                    ? t("settingsDialog.help.number")
                    : t("settingsDialog.help.toggle")}
            </Text>
          )}
        </Box>
      ) : null}
      <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
        {t("settingsDialog.externalPath")}
      </Text>
      {errorText ? (
        <Text color={terminalUiTheme.colors.danger} wrap="truncate-end">
          {errorText}
        </Text>
      ) : null}
      {isSaving ? (
        <Text color={terminalUiTheme.colors.info} wrap="truncate-end">
          {t("settingsDialog.saving")}
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
      if (field.type === "number") {
        const parsed = Number(draftValue);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(t("settingsDialog.error.positiveNumber", { field: t(field.labelKey ?? field.label) }));
        }

        if (field.key === "scrollSpeed" && parsed > 8) {
          throw new Error(t("settingsDialog.error.scrollSpeedRange"));
        }

        setConfig((current) => ({
          ...current,
          [field.key]: Math.trunc(parsed)
        }));
      } else if (field.type === "toggle") {
        setConfig((current) => ({
          ...current,
          [field.key]: draftValue.trim().toLowerCase() === "on"
        }));
      } else if (field.key === "modelContextWindowOverrides") {
        setConfig((current) => ({
          ...current,
          [field.key]: decodeContextWindowOverrides(draftValue)
        }));
      } else {
        const textValue = decodeTextValue(draftValue);
        setConfig((current) => ({
          ...current,
          [field.key]: textValue
        }));
      }

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
