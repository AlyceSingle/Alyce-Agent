import type { TerminalKey } from "../runtime/input.js";
import type { ParsedBinding, ParsedKeystroke } from "./types.js";

function getInkModifiers(key: TerminalKey) {
  return {
    ctrl: key.ctrl,
    shift: key.shift,
    meta: key.meta
  };
}

export function getKeyName(input: string, key: TerminalKey): string | null {
  if (key.escape) {
    return "escape";
  }
  if (key.return) {
    return "enter";
  }
  if (key.tab) {
    return "tab";
  }
  if (key.backspace) {
    return "backspace";
  }
  if (key.delete) {
    return "delete";
  }
  if (key.upArrow) {
    return "up";
  }
  if (key.downArrow) {
    return "down";
  }
  if (key.leftArrow) {
    return "left";
  }
  if (key.rightArrow) {
    return "right";
  }
  if (key.pageUp) {
    return "pageup";
  }
  if (key.pageDown) {
    return "pagedown";
  }
  if (key.home) {
    return "home";
  }
  if (key.end) {
    return "end";
  }
  if (key.space) {
    return "space";
  }
  if (input.length === 1) {
    return input.toLowerCase();
  }

  return null;
}

function modifiersMatch(
  inkMods: ReturnType<typeof getInkModifiers>,
  target: ParsedKeystroke
) {
  return (
    inkMods.ctrl === target.ctrl &&
    inkMods.shift === target.shift &&
    inkMods.meta === target.meta
  );
}

export function matchesKeystroke(
  input: string,
  key: TerminalKey,
  target: ParsedKeystroke
) {
  const keyName = getKeyName(input, key);
  if (keyName !== target.key) {
    return false;
  }

  const modifiers = getInkModifiers(key);
  if (key.escape) {
    return modifiersMatch({ ...modifiers, meta: false }, target);
  }

  return modifiersMatch(modifiers, target);
}

export function matchesBinding(
  input: string,
  key: TerminalKey,
  binding: ParsedBinding
) {
  if (binding.chord.length !== 1) {
    return false;
  }

  const keystroke = binding.chord[0];
  if (!keystroke) {
    return false;
  }

  return matchesKeystroke(input, key, keystroke);
}
