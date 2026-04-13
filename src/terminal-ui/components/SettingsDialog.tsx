import React, { useEffect, useState } from "react";
import type { ConnectionConfig, SessionSettings } from "../../config/runtime.js";
import { getBuiltinPersonaPresetNames } from "../../core/prompt/fragments/personaPresets.js";
import { Box, Text, useInput } from "../runtime/ink.js";
import type { SettingsSection } from "../state/types.js";
import { terminalUiTheme } from "../theme/theme.js";
import { normalizeInlineValue } from "../utils/text.js";

type EditableConfig = ConnectionConfig & SessionSettings;

type FieldDefinition = {
  key: keyof EditableConfig;
  label: string;
  type: "text" | "number" | "toggle" | "select";
  section: SettingsSection;
  options?: string[];
  secret?: boolean;
};

const PERSONA_OPTIONS = ["", ...getBuiltinPersonaPresetNames()];

const FIELD_DEFINITIONS: FieldDefinition[] = [
  { key: "apiKey", label: "API Key", type: "text", section: "connection", secret: true },
  { key: "baseURL", label: "Base URL", type: "text", section: "connection" },
  { key: "model", label: "Model", type: "text", section: "connection" },
  {
    key: "approvalMode",
    label: "Approval Mode",
    type: "select",
    section: "session",
    options: ["manual", "auto"]
  },
  { key: "maxSteps", label: "Max Steps", type: "number", section: "session" },
  { key: "commandTimeoutMs", label: "Command Timeout", type: "number", section: "session" },
  { key: "autoSummaryEnabled", label: "Auto Summary", type: "toggle", section: "session" },
  { key: "languagePreference", label: "Language", type: "text", section: "session" },
  {
    key: "personaPreset",
    label: "Persona Preset",
    type: "select",
    section: "session",
    options: PERSONA_OPTIONS
  },
  {
    key: "aiPersonalityPrompt",
    label: "Persona Overlay",
    type: "text",
    section: "session"
  },
  {
    key: "customSystemPrompt",
    label: "System Prompt Override",
    type: "text",
    section: "session"
  },
  {
    key: "appendSystemPrompt",
    label: "Append Prompt",
    type: "text",
    section: "session"
  }
];

function encodeTextValue(value: string | undefined) {
  return value?.replace(/\r?\n/g, "\\n") ?? "";
}

function decodeTextValue(value: string) {
  const normalized = value.trim();
  return normalized ? normalized.replace(/\\n/g, "\n") : undefined;
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

  return encodeTextValue(typeof value === "string" ? value : undefined);
}

function maskValue(value: string) {
  if (value.length <= 8) {
    return value ? "configured" : "Not set";
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function SettingsDialog(props: {
  visible: boolean;
  initialSection: SettingsSection;
  reason?: string;
  connection: ConnectionConfig;
  settings: SessionSettings;
  onClose: () => void;
  onSave: (connection: ConnectionConfig, settings: SessionSettings) => Promise<void>;
  onCtrlCCaptureChange: (capture: boolean) => void;
}) {
  const [section, setSection] = useState<SettingsSection>(props.initialSection);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isEditing, setIsEditing] = useState(false);
  const [draftValue, setDraftValue] = useState("");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [config, setConfig] = useState<EditableConfig>(() => ({
    ...props.connection,
    ...props.settings
  }));

  const sectionFields = FIELD_DEFINITIONS.filter((field) => field.section === section);
  const currentField = sectionFields[selectedIndex] ?? sectionFields[0];

  useEffect(() => {
    if (!props.visible) {
      return;
    }

    setSection(props.initialSection);
    setSelectedIndex(0);
    setIsEditing(false);
    setDraftValue("");
    setErrorText(null);
    setIsSaving(false);
    setConfig({
      ...props.connection,
      ...props.settings
    });
  }, [props.connection, props.initialSection, props.settings, props.visible]);

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

    if (key.leftArrow || key.rightArrow) {
      setSection((current) => (current === "connection" ? "session" : "connection"));
      setSelectedIndex(0);
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((current) => Math.max(0, current - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((current) => Math.min(sectionFields.length - 1, current + 1));
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

    if (currentField.type === "select" && key.rightArrow) {
      cycleSelectField(currentField, 1);
      return;
    }

    if (currentField.type === "select" && key.leftArrow) {
      cycleSelectField(currentField, -1);
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
    Math.min(selectedIndex - Math.floor(visibleCount / 2), sectionFields.length - visibleCount)
  );
  const visibleFields = sectionFields.slice(startIndex, startIndex + visibleCount);

  return (
    <Box
      borderStyle="round"
      borderColor={terminalUiTheme.colors.borderActive}
      paddingX={1}
      flexDirection="column"
      width="100%"
    >
      <Text color={terminalUiTheme.colors.chrome}>Settings</Text>
      {props.reason ? (
        <Text color={terminalUiTheme.colors.warning} wrap="truncate-end">
          {props.reason}
        </Text>
      ) : null}
      <Text color={terminalUiTheme.colors.muted} wrap="truncate-end">
        {section === "connection" ? "Connection" : "Session"}
        {" · "}
        Left/Right switch tab
        {" · "}
        Enter edit
        {" · "}
        S save
        {" · "}
        Esc close
      </Text>
      <Box flexDirection="column" marginTop={1} width="100%">
        {/* 列表项保持单行，避免上下切换时触发终端宽高抖动。 */}
        {visibleFields.map((field, index) => {
          const actualIndex = startIndex + index;
          const isSelected = actualIndex === selectedIndex;
          const rawValue = getFieldValue(config, field);
          const valueLabel = field.secret ? maskValue(rawValue) : normalizeInlineValue(rawValue);

          return (
            <Box key={field.key} width="100%">
              <Text
                color={isSelected ? terminalUiTheme.colors.chrome : terminalUiTheme.colors.muted}
                backgroundColor={isSelected ? terminalUiTheme.colors.selection : undefined}
                wrap="truncate-end"
              >
                {isSelected ? "›" : " "}
                {" "}
                {field.label}: {valueLabel}
              </Text>
            </Box>
          );
        })}
      </Box>
      {currentField ? (
        <Box flexDirection="column" marginTop={1} width="100%">
          <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
            Current field: {currentField.label}
          </Text>
          {isEditing ? (
            <Text color={terminalUiTheme.colors.chrome} wrap="truncate-end">
              Draft: {currentField.secret ? maskValue(draftValue) : normalizeInlineValue(draftValue, "")}
            </Text>
          ) : (
            <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
              {currentField.type === "text"
                ? "Text fields accept \\n for line breaks."
                : currentField.type === "number"
                  ? "Number fields are persisted as positive integers."
                  : "Toggle or cycle this field with Enter."}
            </Text>
          )}
        </Box>
      ) : null}
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
    </Box>
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
      await props.onSave(
        {
          apiKey: config.apiKey,
          baseURL: config.baseURL,
          model: config.model
        },
        {
          approvalMode: config.approvalMode,
          maxSteps: config.maxSteps,
          commandTimeoutMs: config.commandTimeoutMs,
          autoSummaryEnabled: config.autoSummaryEnabled,
          languagePreference: config.languagePreference,
          personaPreset: config.personaPreset,
          aiPersonalityPrompt: config.aiPersonalityPrompt,
          customSystemPrompt: config.customSystemPrompt,
          appendSystemPrompt: config.appendSystemPrompt
        }
      );
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  }
}
