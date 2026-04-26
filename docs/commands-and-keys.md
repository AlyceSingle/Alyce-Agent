<p align="center">
  English | <a href="./zh-CN/commands-and-keys.md">简体中文</a>
</p>

# Commands and Keys

Alyce speaking. This page only documents controls that are actually wired into the current runtime.

## Slash Commands

### Core Commands

- `/help`
- `/settings`
- `/setup`
- `/clear`
- `/exit`

### Memory Commands

- `/remember <text>`
- `/remember --session <text>`
- `/memory`
- `/memory clear`
- `/memory clear --all`

### Context and Model

- `/context`
- `/context <text>`
- `/model <name>`

### Directory Scope

- `/add-dir <path>`
- `/add-dir --save <path>`

## Global Shortcuts

- `Ctrl+Q`
  Quit the app
- `Ctrl+X`
  Open settings
- `Ctrl+O`
  Open the current message detail view
- `Esc`
  Close dialogs, leave detail view, or trigger some recovery flows

## Interrupt Behavior

- `Ctrl+C`
  Clear current input or interrupt the active request

If a turn is interrupted and still restorable, the controller can prompt for recovery using `Esc`.

## Conversation Navigation

- `Up`
- `Down`

These move through conversation messages.

## Scroll Navigation

- mouse wheel up / down
- `PageUp`
- `PageDown`
- `Home`
- `End`
- `Ctrl+0`
- `Ctrl+Home`
- `Ctrl+End`

## Settings Dialog Controls

### Common

- `Left / Right`
  Switch between connection and session tabs
- `Up / Down`
  Move through fields
- `Enter`
  Edit the current field, or toggle / cycle compatible fields
- `S`
  Save
- `Esc`
  Close

### Connection-Only

- `P`
  Switch the connection save target between project and user scope

## Field Notes

- Text fields support `\n` as a line-break escape
- Number fields are normalized to positive integers
- Toggle fields display as `on` / `off`
