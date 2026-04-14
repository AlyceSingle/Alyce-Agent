import { DEFAULT_PARSED_BINDINGS } from "./defaultBindings.js";
import { chordToString } from "./parser.js";
import type { KeybindingContextName, ParsedBinding, TerminalUiAction } from "./types.js";

const KEY_LABELS: Record<string, string> = {
  ctrl: "Ctrl",
  shift: "Shift",
  meta: "Alt",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  pageup: "PgUp",
  pagedown: "PgDn",
  home: "Home",
  end: "End",
  enter: "Enter",
  escape: "Esc",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  space: "Space"
};

function formatChord(chord: string) {
  return chord
    .split(" ")
    .map((stroke) =>
      stroke
        .split("+")
        .map((part) => KEY_LABELS[part] ?? part.toUpperCase())
        .join("+")
    )
    .join(" ");
}

export function getBindingDisplayText(
  action: TerminalUiAction,
  context: KeybindingContextName,
  bindings: ParsedBinding[] = DEFAULT_PARSED_BINDINGS
) {
  const binding = [...bindings].reverse().find((item) => item.action === action && item.context === context);
  if (!binding) {
    return undefined;
  }

  return formatChord(chordToString(binding.chord));
}
