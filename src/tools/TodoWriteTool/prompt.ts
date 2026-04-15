export const TODO_WRITE_TOOL_DESCRIPTION = `Maintain a structured task list for the current session.

Use this tool for complex multi-step work so the user can see progress and you can track what remains.

Guidelines:
- Use it when the task has several meaningful steps or the user gave multiple requirements.
- Do not use it for a single trivial change or purely conversational questions.
- Each task must include:
  - content: the imperative form, for example "Run tests"
  - activeForm: the in-progress form, for example "Running tests"
- At most one task may be in_progress at a time.
- If any task is still pending or in_progress, exactly one task must be in_progress.
- When every task is completed, the visible todo list is cleared.`;
