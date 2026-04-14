import { useMemo, useRef } from "react";
import { useTerminalInput } from "../runtime/input.js";
import { DEFAULT_PARSED_BINDINGS } from "./defaultBindings.js";
import { resolveKeyWithChordState } from "./resolver.js";
import type { KeybindingContextName, ParsedBinding, ParsedKeystroke, TerminalUiAction } from "./types.js";

type HandlerResult = void | false | Promise<void>;

type HandlerMap = Partial<Record<TerminalUiAction, () => HandlerResult>>;

export function useKeybindings(
  handlers: HandlerMap,
  options: {
    contexts: KeybindingContextName[];
    isActive?: boolean;
    bindings?: ParsedBinding[];
  }
) {
  const pendingChordRef = useRef<ParsedKeystroke[] | null>(null);
  const bindings = options.bindings ?? DEFAULT_PARSED_BINDINGS;
  const contexts = useMemo(() => [...options.contexts], [options.contexts]);

  useTerminalInput((input, key) => {
    const result = resolveKeyWithChordState(
      input,
      key,
      contexts,
      bindings,
      pendingChordRef.current
    );

    switch (result.type) {
      case "match": {
        pendingChordRef.current = null;
        const handler = handlers[result.action as TerminalUiAction];
        if (handler) {
          void handler();
        }
        break;
      }
      case "chord_started":
        pendingChordRef.current = result.pending;
        break;
      case "chord_cancelled":
      case "unbound":
        pendingChordRef.current = null;
        break;
      case "none":
        break;
    }
  }, { isActive: options.isActive });
}
