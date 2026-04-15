import { z } from "zod";
import type {
  AskUserQuestionAnnotation,
  AskUserQuestionResponse,
  ToolExecutionContext
} from "../types.js";
import {
  ASK_USER_QUESTION_TOOL_DESCRIPTION,
  ASK_USER_QUESTION_TOOL_HEADER_MAX_CHARS,
  ASK_USER_QUESTION_TOOL_NAME
} from "./prompt.js";

const QuestionOptionSchema = z
  .object({
    label: z.string().min(1).describe("Short user-facing label for the option."),
    description: z.string().min(1).describe("Explain what this option means or what will happen."),
    preview: z
      .string()
      .min(1)
      .optional()
      .describe("Optional plain-text preview for comparing concrete outputs.")
  })
  .strict();

const QuestionSchema = z
  .object({
    question: z.string().min(1).describe("Question text shown to the user."),
    header: z
      .string()
      .min(1)
      .max(ASK_USER_QUESTION_TOOL_HEADER_MAX_CHARS)
      .describe("Short label shown in the dialog header."),
    options: z
      .array(QuestionOptionSchema)
      .min(2)
      .max(4)
      .describe("Two to four meaningful options for the user to choose from."),
    multiSelect: z
      .boolean()
      .default(false)
      .describe("Allow choosing multiple options instead of exactly one.")
  })
  .strict()
  .superRefine((value, context) => {
    const labels = value.options.map((option) => option.label);
    if (labels.length !== new Set(labels).size) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Option labels must be unique within each question."
      });
    }

    if (value.multiSelect && value.options.some((option) => option.preview)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Preview is only supported for single-select questions."
      });
    }
  });

const AnnotationSchema = z
  .object({
    preview: z.string().min(1).optional(),
    notes: z.string().min(1).optional()
  })
  .strict();

export const AskUserQuestionInputSchema = z
  .object({
    questions: z
      .array(QuestionSchema)
      .min(1)
      .max(4)
      .describe("Questions to ask the user."),
    answers: z
      .record(z.string())
      .optional()
      .describe("Optional prefilled answers keyed by question text."),
    annotations: z
      .record(AnnotationSchema)
      .optional()
      .describe("Optional prefilled annotations keyed by question text."),
    metadata: z
      .object({
        source: z.string().min(1).optional()
      })
      .strict()
      .optional()
      .describe("Optional metadata for analytics or tracing.")
  })
  .strict()
  .superRefine((value, context) => {
    const questionTexts = value.questions.map((question) => question.question);
    if (questionTexts.length !== new Set(questionTexts).size) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Question texts must be unique."
      });
    }
  });

export const AskUserQuestionOutputSchema = z
  .object({
    questions: z.array(QuestionSchema),
    answers: z.record(z.string()),
    annotations: z.record(AnnotationSchema).optional()
  })
  .strict();

export type AskUserQuestionInput = z.infer<typeof AskUserQuestionInputSchema>;
export type AskUserQuestionOutput = z.infer<typeof AskUserQuestionOutputSchema>;

export { ASK_USER_QUESTION_TOOL_DESCRIPTION, ASK_USER_QUESTION_TOOL_NAME };

export async function executeAskUserQuestionTool(
  input: AskUserQuestionInput,
  context: ToolExecutionContext
): Promise<AskUserQuestionOutput> {
  const normalizedQuestions = normalizeQuestions(input.questions);

  if (hasCompletePrefilledAnswers(input)) {
    return buildResult(normalizedQuestions, input.answers, input.annotations);
  }

  const response = await context.askUserQuestions(
    {
      toolName: ASK_USER_QUESTION_TOOL_NAME,
      title: "Answer Alyce's questions",
      questions: normalizedQuestions,
      metadata: input.metadata
    },
    {
      signal: context.abortSignal
    }
  );

  return buildResult(normalizedQuestions, response.answers, response.annotations);
}

function hasCompletePrefilledAnswers(
  input: AskUserQuestionInput
): input is AskUserQuestionInput & {
  answers: Record<string, string>;
} {
  if (!input.answers) {
    return false;
  }

  return input.questions.every((question) => {
    const answer = input.answers?.[question.question];
    return typeof answer === "string" && answer.trim().length > 0;
  });
}

function buildResult(
  questions: AskUserQuestionOutput["questions"],
  answers: Record<string, string>,
  annotations?: Record<string, AskUserQuestionAnnotation>
): AskUserQuestionOutput {
  const normalizedAnswers: Record<string, string> = {};

  for (const question of questions) {
    const answer = answers[question.question];
    if (typeof answer !== "string" || answer.trim().length === 0) {
      throw new Error(`AskUserQuestion is missing an answer for "${question.question}"`);
    }

    normalizedAnswers[question.question] = answer.trim();
  }

  const normalizedAnnotations = normalizeAnnotations(questions, annotations);

  return {
    questions,
    answers: normalizedAnswers,
    ...(normalizedAnnotations ? { annotations: normalizedAnnotations } : {})
  };
}

function normalizeAnnotations(
  questions: AskUserQuestionOutput["questions"],
  annotations?: Record<string, AskUserQuestionAnnotation>
) {
  if (!annotations) {
    return undefined;
  }

  const normalizedEntries = questions
    .map((question) => {
      const annotation = annotations[question.question];
      if (!annotation) {
        return null;
      }

      const nextAnnotation: AskUserQuestionAnnotation = {};
      if (annotation.preview?.trim()) {
        nextAnnotation.preview = annotation.preview.trim();
      }
      if (annotation.notes?.trim()) {
        nextAnnotation.notes = annotation.notes.trim();
      }

      if (!nextAnnotation.preview && !nextAnnotation.notes) {
        return null;
      }

      return [question.question, nextAnnotation] as const;
    })
    .filter((entry): entry is readonly [string, AskUserQuestionAnnotation] => entry !== null);

  if (normalizedEntries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(normalizedEntries);
}

function normalizeQuestions(
  questions: AskUserQuestionInput["questions"]
): AskUserQuestionOutput["questions"] {
  return questions.map((question) => ({
    ...question,
    multiSelect: question.multiSelect ?? false
  }));
}
