import { useEffect, useMemo, useState } from "react";
import { t } from "../../i18n/index.js";
import type {
  AskUserQuestion,
  AskUserQuestionAnnotation,
  AskUserQuestionRequest,
  AskUserQuestionResponse
} from "../../tools/types.js";
import { useRegisterOverlay } from "../context/overlayContext.js";
import Box from "../runtime/ink-runtime/components/Box.js";
import Text from "../runtime/ink-runtime/components/Text.js";
import useInput from "../runtime/ink-runtime/hooks/use-input.js";
import { terminalUiTheme } from "../theme/theme.js";
import { Pane } from "./Pane.js";
import TextInput from "./TextInput.js";

type InputMode = "browse" | "custom-answer" | "notes";

export function AskUserQuestionDialog(props: {
  request: AskUserQuestionRequest | null;
  onSubmit: (response: AskUserQuestionResponse) => void;
  onCancel: () => void;
}) {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [highlightedOptionIndex, setHighlightedOptionIndex] = useState(0);
  const [selectedLabelsByQuestion, setSelectedLabelsByQuestion] = useState<Record<string, string[]>>({});
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({});
  const [notesByQuestion, setNotesByQuestion] = useState<Record<string, string>>({});
  const [previewByQuestion, setPreviewByQuestion] = useState<Record<string, string>>({});
  const [inputMode, setInputMode] = useState<InputMode>("browse");
  const [textValue, setTextValue] = useState("");
  const [cursorOffset, setCursorOffset] = useState(0);
  const [errorText, setErrorText] = useState<string | null>(null);

  useRegisterOverlay("question", Boolean(props.request));

  useEffect(() => {
    setQuestionIndex(0);
    setHighlightedOptionIndex(0);
    setSelectedLabelsByQuestion({});
    setCustomAnswers({});
    setNotesByQuestion({});
    setPreviewByQuestion({});
    setInputMode("browse");
    setTextValue("");
    setCursorOffset(0);
    setErrorText(null);
  }, [props.request]);

  const currentQuestion = props.request?.questions[questionIndex] ?? null;
  const currentQuestionKey = currentQuestion?.question ?? "";
  const highlightedOption = currentQuestion?.options[highlightedOptionIndex] ?? null;
  const currentSelections = selectedLabelsByQuestion[currentQuestionKey] ?? [];
  const currentCustomAnswer = customAnswers[currentQuestionKey] ?? "";
  const currentNote = notesByQuestion[currentQuestionKey] ?? "";

  const previousAnswers = useMemo(() => {
    if (!props.request) {
      return [];
    }

    return props.request.questions
      .slice(0, questionIndex)
      .map((question) => ({
        question: question.question,
        answer: buildAnswerValue(
          question,
          selectedLabelsByQuestion[question.question] ?? [],
          customAnswers[question.question] ?? ""
        )
      }))
      .filter((entry) => entry.answer.length > 0);
  }, [customAnswers, props.request, questionIndex, selectedLabelsByQuestion]);

  useInput(
    (input, key) => {
      if (!props.request || !currentQuestion) {
        return;
      }

      if (key.upArrow) {
        setHighlightedOptionIndex((current) => Math.max(0, current - 1));
        return;
      }

      if (key.downArrow) {
        setHighlightedOptionIndex((current) =>
          Math.min(currentQuestion.options.length - 1, current + 1)
        );
        return;
      }

      if (input === " " && currentQuestion.multiSelect) {
        setSelectedLabelsByQuestion((current) =>
          toggleLabel(current, currentQuestionKey, highlightedOption?.label ?? "")
        );
        setErrorText(null);
        return;
      }

      if (key.return) {
        if (currentQuestion.multiSelect) {
          const nextAnswer = buildAnswerValue(
            currentQuestion,
            currentSelections,
            currentCustomAnswer
          );

          if (!nextAnswer) {
            setErrorText(t("askUserQuestion.error.chooseAtLeast"));
            return;
          }

          finalizeCurrentQuestion();
          return;
        }

        if (!highlightedOption) {
          return;
        }

        const nextSelectedLabelsByQuestion = {
          ...selectedLabelsByQuestion,
          [currentQuestionKey]: [highlightedOption.label]
        };
        const nextPreviewByQuestion = {
          ...previewByQuestion
        };
        if (highlightedOption.preview) {
          nextPreviewByQuestion[currentQuestionKey] = highlightedOption.preview;
        } else {
          delete nextPreviewByQuestion[currentQuestionKey];
        }

        setSelectedLabelsByQuestion(nextSelectedLabelsByQuestion);
        setPreviewByQuestion(nextPreviewByQuestion);
        setErrorText(null);
        finalizeCurrentQuestion({
          nextSelectedLabelsByQuestion,
          nextPreviewByQuestion
        });
        return;
      }

      if (key.escape) {
        props.onCancel();
        return;
      }

      const normalizedInput = input.toLowerCase();
      if (normalizedInput === "o") {
        setInputMode("custom-answer");
        setTextValue(currentCustomAnswer);
        setCursorOffset(currentCustomAnswer.length);
        setErrorText(null);
        return;
      }

      if (normalizedInput === "n") {
        setInputMode("notes");
        setTextValue(currentNote);
        setCursorOffset(currentNote.length);
        setErrorText(null);
      }
    },
    {
      isActive: Boolean(props.request) && inputMode === "browse"
    }
  );

  useInput(
    (_input, key) => {
      if (!props.request || !currentQuestion || inputMode === "browse") {
        return;
      }

      if (key.escape) {
        setInputMode("browse");
        setTextValue("");
        setCursorOffset(0);
        setErrorText(null);
      }
    },
    {
      isActive: Boolean(props.request) && inputMode !== "browse"
    }
  );

  if (!props.request || !currentQuestion) {
    return null;
  }

  const hasPreview = !currentQuestion.multiSelect && Boolean(highlightedOption?.preview);
  const footer =
    inputMode === "custom-answer"
      ? t("askUserQuestion.footer.save")
      : inputMode === "notes"
        ? t("askUserQuestion.footer.saveNote")
        : currentQuestion.multiSelect
          ? t("askUserQuestion.footer.multiSelect")
          : t("askUserQuestion.footer.singleSelect");

  return (
    <Pane
      title={t("askUserQuestion.title", { toolName: props.request.toolName })}
      subtitle={t("askUserQuestion.subtitle", { current: questionIndex + 1, total: props.request.questions.length, header: currentQuestion.header })}
      accentColor={terminalUiTheme.colors.info}
      footer={footer}
    >
      <Text wrap="wrap">{currentQuestion.question}</Text>

      {previousAnswers.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={terminalUiTheme.colors.subtle}>{t("askUserQuestion.answeredSoFar")}</Text>
          {previousAnswers.map((entry) => (
            <Text key={entry.question} color={terminalUiTheme.colors.muted} wrap="truncate-end">
              {entry.question}
              {" -> "}
              {entry.answer}
            </Text>
          ))}
        </Box>
      ) : null}

      {inputMode === "browse" ? (
        <Box flexDirection="column" marginTop={1}>
          {currentQuestion.options.map((option, index) => {
            const isHighlighted = index === highlightedOptionIndex;
            const isSelected = currentSelections.includes(option.label);
            const prefix = currentQuestion.multiSelect ? (isSelected ? "[x]" : "[ ]") : "[ ]";
            return (
              <Text
                key={option.label}
                color={isHighlighted ? terminalUiTheme.colors.chrome : terminalUiTheme.colors.muted}
                backgroundColor={isHighlighted ? terminalUiTheme.colors.selection : undefined}
                wrap="truncate-end"
              >
                {isHighlighted ? ">" : " "} {prefix} {option.label} | {option.description}
              </Text>
            );
          })}
          <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
            {t("askUserQuestion.other")}: {currentCustomAnswer || t("askUserQuestion.none")}
          </Text>
          <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
            {t("askUserQuestion.note")}: {currentNote || t("askUserQuestion.none")}
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Text color={terminalUiTheme.colors.subtle}>
            {inputMode === "custom-answer"
              ? t("askUserQuestion.enterOtherAnswer")
              : t("askUserQuestion.addNote")}
          </Text>
          <TextInput
            value={textValue}
            onChange={setTextValue}
            onSubmit={(value) => {
              if (inputMode === "custom-answer") {
                saveCustomAnswer(value);
                return;
              }

              saveNote(value);
            }}
            focus
            multiline
            showCursor
            columns={80}
            maxVisibleLines={4}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            placeholder={
              inputMode === "custom-answer" ? t("askUserQuestion.placeholder.customAnswer") : t("askUserQuestion.placeholder.note")
            }
          />
        </Box>
      )}

      {hasPreview ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={terminalUiTheme.colors.subtle}>{t("askUserQuestion.preview")}</Text>
          {(highlightedOption?.preview?.split("\n") ?? []).map((line, index) => (
            <Text key={`preview-${index}`} color={terminalUiTheme.colors.info}>
              {line.length > 0 ? line : " "}
            </Text>
          ))}
        </Box>
      ) : null}

      {errorText ? (
        <Text color={terminalUiTheme.colors.warning} wrap="truncate-end">
          {errorText}
        </Text>
      ) : null}
    </Pane>
  );

  function finalizeCurrentQuestion(options: {
    nextSelectedLabelsByQuestion?: Record<string, string[]>;
    nextCustomAnswers?: Record<string, string>;
    nextPreviewByQuestion?: Record<string, string>;
    nextNotesByQuestion?: Record<string, string>;
  } = {}) {
    if (!props.request || !currentQuestion) {
      return;
    }

    const resolvedSelectedLabelsByQuestion =
      options.nextSelectedLabelsByQuestion ?? selectedLabelsByQuestion;
    const resolvedCustomAnswers = options.nextCustomAnswers ?? customAnswers;
    const resolvedPreviewByQuestion = options.nextPreviewByQuestion ?? previewByQuestion;
    const resolvedNotesByQuestion = options.nextNotesByQuestion ?? notesByQuestion;
    const nextQuestionIndex = questionIndex + 1;
    if (nextQuestionIndex >= props.request.questions.length) {
      props.onSubmit(
        buildResponse(
          props.request.questions,
          resolvedSelectedLabelsByQuestion,
          resolvedCustomAnswers,
          resolvedPreviewByQuestion,
          resolvedNotesByQuestion
        )
      );
      return;
    }

    setQuestionIndex(nextQuestionIndex);
    setHighlightedOptionIndex(0);
    setInputMode("browse");
    setTextValue("");
    setCursorOffset(0);
    setErrorText(null);
  }

  function saveCustomAnswer(rawValue: string) {
    if (!currentQuestion) {
      return;
    }

    const trimmedValue = rawValue.trim();
    if (!trimmedValue) {
      setErrorText(t("askUserQuestion.error.otherEmpty"));
      return;
    }

    const nextCustomAnswers = {
      ...customAnswers,
      [currentQuestionKey]: trimmedValue
    };

    setCustomAnswers(nextCustomAnswers);
    setErrorText(null);

    if (currentQuestion.multiSelect) {
      setInputMode("browse");
      setTextValue("");
      setCursorOffset(0);
      return;
    }

    const nextSelectedLabelsByQuestion = {
      ...selectedLabelsByQuestion,
      [currentQuestionKey]: []
    };
    const nextPreviewByQuestion = {
      ...previewByQuestion
    };
    delete nextPreviewByQuestion[currentQuestionKey];

    setSelectedLabelsByQuestion(nextSelectedLabelsByQuestion);
    setPreviewByQuestion(nextPreviewByQuestion);
    finalizeCurrentQuestion({
      nextSelectedLabelsByQuestion,
      nextCustomAnswers,
      nextPreviewByQuestion
    });
  }

  function saveNote(rawValue: string) {
    const trimmedValue = rawValue.trim();

    setNotesByQuestion((current) => {
      const next = { ...current };
      if (trimmedValue) {
        next[currentQuestionKey] = trimmedValue;
      } else {
        delete next[currentQuestionKey];
      }
      return next;
    });

    setInputMode("browse");
    setTextValue("");
    setCursorOffset(0);
    setErrorText(null);
  }

  function buildResponse(
    questions: AskUserQuestion[],
    selectedLabelsState: Record<string, string[]>,
    customAnswersState: Record<string, string>,
    previewState: Record<string, string>,
    notesState: Record<string, string>
  ): AskUserQuestionResponse {
    const answers: Record<string, string> = {};
    const annotations: Record<string, AskUserQuestionAnnotation> = {};

    for (const question of questions) {
      const questionKey = question.question;
      const answer = buildAnswerValue(
        question,
        selectedLabelsState[questionKey] ?? [],
        customAnswersState[questionKey] ?? ""
      );

      if (answer) {
        answers[questionKey] = answer;
      }

      const annotation: AskUserQuestionAnnotation = {};
      const preview = previewState[questionKey];
      const note = notesState[questionKey];

      if (preview) {
        annotation.preview = preview;
      }
      if (note) {
        annotation.notes = note;
      }

      if (annotation.preview || annotation.notes) {
        annotations[questionKey] = annotation;
      }
    }

    return {
      answers,
      ...(Object.keys(annotations).length > 0 ? { annotations } : {})
    };
  }
}

function buildAnswerValue(
  question: AskUserQuestion,
  selectedLabels: string[],
  customAnswer: string
) {
  const normalizedCustomAnswer = customAnswer.trim();
  if (!question.multiSelect) {
    return normalizedCustomAnswer || selectedLabels[0] || "";
  }

  const parts = [...selectedLabels];
  if (normalizedCustomAnswer) {
    parts.push(normalizedCustomAnswer);
  }

  return parts.join(", ");
}

function toggleLabel(
  selectedLabelsByQuestion: Record<string, string[]>,
  questionKey: string,
  label: string
) {
  if (!label) {
    return selectedLabelsByQuestion;
  }

  const selectedLabels = selectedLabelsByQuestion[questionKey] ?? [];
  const exists = selectedLabels.includes(label);

  return {
    ...selectedLabelsByQuestion,
    [questionKey]: exists
      ? selectedLabels.filter((selectedLabel) => selectedLabel !== label)
      : [...selectedLabels, label]
  };
}
