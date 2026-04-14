import type { KeybindingBlock, ParsedBinding, ParsedKeystroke } from "./types.js";

function normalizeKeyName(name: string) {
  const normalized = name.trim().toLowerCase();

  switch (normalized) {
    case "return":
      return "enter";
    case "pgup":
      return "pageup";
    case "pgdn":
      return "pagedown";
    case "esc":
      return "escape";
    default:
      return normalized;
  }
}

export function parseKeystroke(binding: string): ParsedKeystroke {
  const keystroke: ParsedKeystroke = {
    key: "",
    ctrl: false,
    shift: false,
    meta: false
  };

  for (const part of binding.split("+")) {
    const normalized = normalizeKeyName(part);

    switch (normalized) {
      case "ctrl":
      case "control":
        keystroke.ctrl = true;
        break;
      case "shift":
        keystroke.shift = true;
        break;
      case "meta":
      case "alt":
      case "option":
        keystroke.meta = true;
        break;
      default:
        keystroke.key = normalized;
        break;
    }
  }

  if (!keystroke.key) {
    throw new Error(`Invalid keybinding: "${binding}"`);
  }

  return keystroke;
}

export function parseChord(binding: string): ParsedKeystroke[] {
  return binding
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((segment) => parseKeystroke(segment));
}

export function parseBindingBlocks(blocks: KeybindingBlock[]): ParsedBinding[] {
  const parsed: ParsedBinding[] = [];

  for (const block of blocks) {
    for (const [binding, action] of Object.entries(block.bindings)) {
      parsed.push({
        context: block.context,
        action,
        chord: parseChord(binding)
      });
    }
  }

  return parsed;
}

export function chordToString(chord: ParsedKeystroke[]) {
  return chord
    .map((keystroke) => {
      const parts: string[] = [];
      if (keystroke.ctrl) {
        parts.push("ctrl");
      }
      if (keystroke.shift) {
        parts.push("shift");
      }
      if (keystroke.meta) {
        parts.push("meta");
      }
      parts.push(keystroke.key);
      return parts.join("+");
    })
    .join(" ");
}
