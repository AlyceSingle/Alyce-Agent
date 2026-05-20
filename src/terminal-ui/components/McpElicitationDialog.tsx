import { useEffect, useMemo, useState } from "react";
import type {
  McpElicitationField,
  McpElicitationRequest,
  McpElicitationResponse
} from "../../mcp/types.js";
import { useRegisterOverlay } from "../context/overlayContext.js";
import { Box, Text, useInput } from "../runtime/ink.js";
import { terminalUiTheme } from "../theme/theme.js";
import { Pane } from "./Pane.js";
import TextInput from "./TextInput.js";

type McpFormElicitationRequest = Extract<McpElicitationRequest, { mode: "form" }>;
type McpTextElicitationField = Extract<McpElicitationField, { kind: "string" | "number" | "integer" }>;
type McpMultiEnumElicitationField = Extract<McpElicitationField, { kind: "multi_enum" }>;

export function McpElicitationDialog(props: {
  request: McpElicitationRequest | null;
  onSubmit: (response: McpElicitationResponse) => void;
  onCancel: () => void;
  onDecline: () => void;
}) {
  const [fieldIndex, setFieldIndex] = useState(0);
  const [highlightedOptionIndex, setHighlightedOptionIndex] = useState(0);
  const [textValue, setTextValue] = useState("");
  const [cursorOffset, setCursorOffset] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string | number | boolean | string[]>>({});
  const [errorText, setErrorText] = useState<string | null>(null);

  useRegisterOverlay("mcp-elicitation", Boolean(props.request));

  useEffect(() => {
    setFieldIndex(0);
    setHighlightedOptionIndex(0);
    setAnswers({});
    setErrorText(null);
  }, [props.request]);

  const formRequest: McpFormElicitationRequest | null =
    props.request?.mode === "form" ? props.request : null;
  const currentField = formRequest?.fields[fieldIndex] ?? null;

  useEffect(() => {
    if (!currentField) {
      setTextValue("");
      setCursorOffset(0);
      return;
    }

    const currentAnswer = answers[currentField.key];
    const nextValue =
      typeof currentAnswer === "string"
        ? currentAnswer
        : typeof currentAnswer === "number"
          ? String(currentAnswer)
          : currentAnswer === undefined
            ? getDefaultTextValue(currentField)
            : "";
    setTextValue(nextValue);
    setCursorOffset(nextValue.length);
    setHighlightedOptionIndex(0);
    setErrorText(null);
  }, [answers, currentField]);

  const previousAnswers = useMemo(() => {
    if (!formRequest) {
      return [];
    }

    return formRequest.fields
      .slice(0, fieldIndex)
      .map((field) => ({
        label: field.label,
        value: formatAnswerValue(answers[field.key])
      }))
      .filter((entry) => entry.value.length > 0);
  }, [answers, fieldIndex, formRequest]);

  useInput((input, key) => {
    if (!props.request) {
      return;
    }

    if (key.escape) {
      props.onCancel();
      return;
    }

    if (input.toLowerCase() === "d") {
      props.onDecline();
      return;
    }

    if (props.request.mode === "url") {
      if (key.return || input.toLowerCase() === "y") {
        props.onSubmit({ action: "accept" });
      } else if (input.toLowerCase() === "n") {
        props.onDecline();
      }
      return;
    }

    if (!formRequest || !currentField) {
      return;
    }

    if (requiresTextInput(currentField)) {
      return;
    }

    const options = getBrowseOptions(currentField);
    if (key.upArrow) {
      setHighlightedOptionIndex((current) => Math.max(0, current - 1));
      return;
    }

    if (key.downArrow) {
      setHighlightedOptionIndex((current) => Math.min(options.length - 1, current + 1));
      return;
    }

    if (input === " " && currentField.kind === "multi_enum") {
      const selected = getSelectedValues(currentField, answers[currentField.key]);
      const nextValue = toggleSelectedValue(selected, options[highlightedOptionIndex]?.value ?? "");
      setAnswers((current) => ({
        ...current,
        [currentField.key]: nextValue
      }));
      setErrorText(null);
      return;
    }

    if (key.return) {
      if (currentField.kind === "multi_enum") {
        const selected = getSelectedValues(currentField, answers[currentField.key]);
        const validationError = validateMultiSelect(currentField, selected);
        if (validationError) {
          setErrorText(validationError);
          return;
        }

        advanceForm(currentField.key, selected);
        return;
      }

      const selected = options[highlightedOptionIndex];
      if (!selected) {
        return;
      }

      const nextValue = currentField.kind === "boolean"
        ? selected.value === "true"
        : selected.value;
      advanceForm(currentField.key, nextValue);
    }
  }, {
    isActive: Boolean(props.request)
  });

  if (!props.request) {
    return null;
  }

  if (props.request.mode === "url") {
    return (
      <Pane
        title={`MCP URL Request | ${props.request.serverName}`}
        subtitle="Open external URL"
        accentColor={terminalUiTheme.colors.warning}
        footer="Enter accept | N decline | D decline | Esc cancel"
      >
        <Text wrap="wrap">{props.request.message}</Text>
        <Box flexDirection="column" marginTop={1}>
          <Text color={terminalUiTheme.colors.warning}>Review the target URL before proceeding.</Text>
          <Text color={terminalUiTheme.colors.info} wrap="wrap">
            {props.request.url}
          </Text>
        </Box>
      </Pane>
    );
  }

  if (!formRequest || !currentField) {
    return null;
  }

  const activeFormRequest = formRequest;
  const options = getBrowseOptions(currentField);
  const selectedValues = getSelectedValues(currentField, answers[currentField.key]);
  const isTextField = requiresTextInput(currentField);
  const textField = isTextField ? currentField : null;

  return (
    <Pane
      title={`MCP Input | ${activeFormRequest.serverName}`}
      subtitle={`Field ${fieldIndex + 1} of ${activeFormRequest.fields.length}`}
      accentColor={terminalUiTheme.colors.info}
      footer={
        isTextField
          ? "Enter continue | D decline | Esc cancel"
          : currentField.kind === "multi_enum"
            ? "Up/Down move | Space toggle | Enter continue | D decline | Esc cancel"
            : "Up/Down move | Enter choose | D decline | Esc cancel"
      }
    >
      <Text wrap="wrap">{activeFormRequest.message}</Text>

      {previousAnswers.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={terminalUiTheme.colors.subtle}>Answered so far</Text>
          {previousAnswers.map((entry) => (
            <Text key={entry.label} color={terminalUiTheme.colors.muted} wrap="truncate-end">
              {entry.label}
              {" -> "}
              {entry.value}
            </Text>
          ))}
        </Box>
      ) : null}

      <Box flexDirection="column" marginTop={1}>
        <Text color={terminalUiTheme.colors.chrome}>
          {currentField.label}
          {currentField.required ? " *" : ""}
        </Text>
        {currentField.description ? (
          <Text color={terminalUiTheme.colors.subtle} wrap="wrap">
            {currentField.description}
          </Text>
        ) : null}
      </Box>

      {isTextField ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={terminalUiTheme.colors.subtle}>
            {textField ? getTextFieldHint(textField) : ""}
          </Text>
          <TextInput
            value={textValue}
            onChange={setTextValue}
            onSubmit={(value) => {
              if (!textField) {
                return;
              }

              const parsed = parseTextFieldValue(textField, value);
              if ("error" in parsed) {
                setErrorText(parsed.error);
                return;
              }

              advanceForm(currentField.key, parsed.value);
            }}
            focus
            multiline
            showCursor
            columns={80}
            maxVisibleLines={4}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            placeholder={textField ? buildTextPlaceholder(textField) : ""}
          />
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {options.map((option, index) => {
            const isHighlighted = index === highlightedOptionIndex;
            const isSelected = selectedValues.includes(option.value);
            const prefix = currentField.kind === "multi_enum"
              ? isSelected ? "[x]" : "[ ]"
              : "[ ]";
            return (
              <Text
                key={option.value}
                color={isHighlighted ? terminalUiTheme.colors.chrome : terminalUiTheme.colors.muted}
                backgroundColor={isHighlighted ? terminalUiTheme.colors.selection : undefined}
                wrap="truncate-end"
              >
                {isHighlighted ? ">" : " "} {prefix} {option.label}
              </Text>
            );
          })}
        </Box>
      )}

      {errorText ? (
        <Text color={terminalUiTheme.colors.warning} wrap="truncate-end">
          {errorText}
        </Text>
      ) : null}
    </Pane>
  );

  function advanceForm(key: string, value: string | number | boolean | string[] | undefined) {
    const nextAnswers = {
      ...answers
    };
    if (value === undefined || (Array.isArray(value) && value.length === 0)) {
      delete nextAnswers[key];
    } else {
      nextAnswers[key] = value;
    }

    if (fieldIndex + 1 >= activeFormRequest.fields.length) {
      props.onSubmit({
        action: "accept",
        ...(Object.keys(nextAnswers).length > 0 ? { content: nextAnswers } : {})
      });
      return;
    }

    setAnswers(nextAnswers);
    setFieldIndex((current) => current + 1);
    setErrorText(null);
  }
}

function requiresTextInput(field: McpElicitationField): field is McpTextElicitationField {
  return field.kind === "string" || field.kind === "number" || field.kind === "integer";
}

function getBrowseOptions(field: McpElicitationField) {
  if (field.kind === "boolean") {
    return [
      { value: "true", label: "Yes" },
      { value: "false", label: "No" }
    ];
  }

  if (field.kind === "enum" || field.kind === "multi_enum") {
    return field.options;
  }

  return [];
}

function getSelectedValues(
  field: McpElicitationField,
  value: string | number | boolean | string[] | undefined
) {
  if (field.kind === "multi_enum") {
    return Array.isArray(value) ? value : field.defaultValue ?? [];
  }

  if (field.kind === "boolean") {
    if (typeof value === "boolean") {
      return [String(value)];
    }

    return field.defaultValue !== undefined ? [String(field.defaultValue)] : [];
  }

  if (field.kind === "enum") {
    if (typeof value === "string") {
      return [value];
    }

    return field.defaultValue ? [field.defaultValue] : [];
  }

  return [];
}

function toggleSelectedValue(selected: string[], value: string) {
  if (!value) {
    return selected;
  }

  return selected.includes(value)
    ? selected.filter((entry) => entry !== value)
    : [...selected, value];
}

function validateMultiSelect(field: McpMultiEnumElicitationField, value: string[]) {
  if (field.required && value.length === 0) {
    return "Choose at least one option.";
  }
  if (field.minItems !== undefined && value.length < field.minItems) {
    return `Choose at least ${field.minItems} option(s).`;
  }
  if (field.maxItems !== undefined && value.length > field.maxItems) {
    return `Choose at most ${field.maxItems} option(s).`;
  }

  return null;
}

function parseTextFieldValue(
  field: McpTextElicitationField,
  rawValue: string
): { value: string | number | undefined } | { error: string } {
  const trimmed = rawValue.trim();

  if (!trimmed) {
    if (field.kind === "string" && field.defaultValue !== undefined) {
      return { value: field.defaultValue };
    }
    if ((field.kind === "number" || field.kind === "integer") && field.defaultValue !== undefined) {
      return { value: field.defaultValue };
    }
    if (field.required) {
      return { error: "This field is required." };
    }

    return { value: undefined };
  }

  if (field.kind === "string") {
    if (field.minLength !== undefined && trimmed.length < field.minLength) {
      return { error: `Enter at least ${field.minLength} characters.` };
    }
    if (field.maxLength !== undefined && trimmed.length > field.maxLength) {
      return { error: `Enter at most ${field.maxLength} characters.` };
    }
    return { value: trimmed };
  }

  const numericValue = Number(trimmed);
  if (!Number.isFinite(numericValue)) {
    return { error: "Enter a valid number." };
  }
  if (field.kind === "integer" && !Number.isInteger(numericValue)) {
    return { error: "Enter a whole number." };
  }
  if (field.minimum !== undefined && numericValue < field.minimum) {
    return { error: `Enter a value >= ${field.minimum}.` };
  }
  if (field.maximum !== undefined && numericValue > field.maximum) {
    return { error: `Enter a value <= ${field.maximum}.` };
  }

  return { value: numericValue };
}

function getDefaultTextValue(field: McpElicitationField) {
  if (field.kind === "string") {
    return field.defaultValue ?? "";
  }
  if (field.kind === "number" || field.kind === "integer") {
    return field.defaultValue !== undefined ? String(field.defaultValue) : "";
  }

  return "";
}

function getTextFieldHint(field: McpTextElicitationField) {
  if (field.kind === "string") {
    const parts = [
      field.format ? `format=${field.format}` : "",
      field.minLength !== undefined ? `min=${field.minLength}` : "",
      field.maxLength !== undefined ? `max=${field.maxLength}` : ""
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(" | ") : "Enter a value.";
  }

  const parts = [
    field.minimum !== undefined ? `min=${field.minimum}` : "",
    field.maximum !== undefined ? `max=${field.maximum}` : ""
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" | ") : "Enter a numeric value.";
}

function buildTextPlaceholder(field: McpTextElicitationField) {
  if (field.kind === "string" && field.defaultValue) {
    return field.defaultValue;
  }
  if ((field.kind === "number" || field.kind === "integer") && field.defaultValue !== undefined) {
    return String(field.defaultValue);
  }

  return field.required ? "Type a value..." : "Leave blank to skip...";
}

function formatAnswerValue(value: string | number | boolean | string[] | undefined) {
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  if (value === undefined) {
    return "";
  }

  return String(value);
}
