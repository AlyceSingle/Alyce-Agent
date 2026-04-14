import type { TerminalKey } from "../runtime/input.js";
import { getKeyName, matchesBinding } from "./match.js";
import type { KeybindingContextName, ParsedBinding, ParsedKeystroke } from "./types.js";

export type ResolveResult =
  | { type: "match"; action: string }
  | { type: "none" }
  | { type: "unbound" }
  | { type: "chord_started"; pending: ParsedKeystroke[] }
  | { type: "chord_cancelled" };

function buildKeystroke(input: string, key: TerminalKey): ParsedKeystroke | null {
  const keyName = getKeyName(input, key);
  if (!keyName) {
    return null;
  }

  return {
    key: keyName,
    ctrl: key.ctrl,
    shift: key.shift,
    meta: key.escape ? false : key.meta
  };
}

function keystrokesEqual(a: ParsedKeystroke, b: ParsedKeystroke) {
  return (
    a.key === b.key &&
    a.ctrl === b.ctrl &&
    a.shift === b.shift &&
    a.meta === b.meta
  );
}

function chordPrefixMatches(prefix: ParsedKeystroke[], binding: ParsedBinding) {
  if (prefix.length >= binding.chord.length) {
    return false;
  }

  for (let index = 0; index < prefix.length; index += 1) {
    const prefixKey = prefix[index];
    const bindingKey = binding.chord[index];
    if (!prefixKey || !bindingKey || !keystrokesEqual(prefixKey, bindingKey)) {
      return false;
    }
  }

  return true;
}

function chordExactlyMatches(chord: ParsedKeystroke[], binding: ParsedBinding) {
  if (chord.length !== binding.chord.length) {
    return false;
  }

  for (let index = 0; index < chord.length; index += 1) {
    const chordKey = chord[index];
    const bindingKey = binding.chord[index];
    if (!chordKey || !bindingKey || !keystrokesEqual(chordKey, bindingKey)) {
      return false;
    }
  }

  return true;
}

function getContextBindings(
  activeContexts: KeybindingContextName[],
  bindings: ParsedBinding[]
) {
  const orderedBindings: ParsedBinding[] = [];

  for (const context of activeContexts) {
    for (const binding of bindings) {
      if (binding.context === context) {
        orderedBindings.push(binding);
      }
    }
  }

  return orderedBindings;
}

export function resolveKey(
  input: string,
  key: TerminalKey,
  activeContexts: KeybindingContextName[],
  bindings: ParsedBinding[]
) {
  for (const context of activeContexts) {
    let contextMatch: ParsedBinding | undefined;

    for (const binding of bindings) {
      if (binding.context !== context) {
        continue;
      }

      if (matchesBinding(input, key, binding)) {
        contextMatch = binding;
      }
    }

    if (!contextMatch) {
      continue;
    }

    if (contextMatch.action === null) {
      return { type: "unbound" } satisfies ResolveResult;
    }

    return { type: "match", action: contextMatch.action } satisfies ResolveResult;
  }

  return { type: "none" } satisfies ResolveResult;
}

export function resolveKeyWithChordState(
  input: string,
  key: TerminalKey,
  activeContexts: KeybindingContextName[],
  bindings: ParsedBinding[],
  pending: ParsedKeystroke[] | null
): ResolveResult {
  if (key.escape && pending !== null) {
    return { type: "chord_cancelled" };
  }

  const currentKeystroke = buildKeystroke(input, key);
  if (!currentKeystroke) {
    return pending !== null ? { type: "chord_cancelled" } : { type: "none" };
  }

  const testChord = pending ? [...pending, currentKeystroke] : [currentKeystroke];
  const contextBindings = getContextBindings(activeContexts, bindings);

  let hasLongerChord = false;
  for (const binding of contextBindings) {
    if (binding.chord.length > testChord.length && chordPrefixMatches(testChord, binding)) {
      hasLongerChord = true;
      break;
    }
  }

  if (hasLongerChord) {
    return {
      type: "chord_started",
      pending: testChord
    };
  }

  for (const binding of contextBindings) {
    if (!chordExactlyMatches(testChord, binding)) {
      continue;
    }

    if (binding.action === null) {
      return { type: "unbound" };
    }

    return {
      type: "match",
      action: binding.action
    };
  }

  return pending !== null ? { type: "chord_cancelled" } : { type: "none" };
}
