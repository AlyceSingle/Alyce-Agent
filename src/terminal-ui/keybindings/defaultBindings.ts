import { parseBindingBlocks } from "./parser.js";
import type { KeybindingBlock } from "./types.js";

export const DEFAULT_BINDINGS: KeybindingBlock[] = [
  {
    context: "Global",
    bindings: {
      "ctrl+q": "app:quit",
      "ctrl+x": "app:openSettings",
      escape: "app:escape"
    }
  },
  {
    context: "Conversation",
    bindings: {
      up: "conversation:previousMessage",
      down: "conversation:nextMessage"
    }
  },
  {
    context: "Scroll",
    bindings: {
      wheelup: "scroll:lineUp",
      wheeldown: "scroll:lineDown",
      pageup: "scroll:pageUp",
      pagedown: "scroll:pageDown",
      home: "scroll:top",
      end: "scroll:bottom",
      "ctrl+0": "scroll:top",
      "ctrl+home": "scroll:top",
      "ctrl+end": "scroll:bottom"
    }
  }
];

export const DEFAULT_PARSED_BINDINGS = parseBindingBlocks(DEFAULT_BINDINGS);
