import { parseBindingBlocks } from "./parser.js";
import type { KeybindingBlock } from "./types.js";

export const DEFAULT_BINDINGS: KeybindingBlock[] = [
  {
    context: "Global",
    bindings: {
      "ctrl+q": "app:quit",
      "ctrl+x": "app:openSettings",
      "ctrl+o": "conversation:openDetail",
      escape: "app:escape"
    }
  },
  {
    context: "Conversation",
    bindings: {
      up: "conversation:previousMessage",
      down: "conversation:nextMessage",
      pageup: "conversation:pageUp",
      pagedown: "conversation:pageDown",
      home: "conversation:firstMessage",
      end: "conversation:lastMessage"
    }
  }
];

export const DEFAULT_PARSED_BINDINGS = parseBindingBlocks(DEFAULT_BINDINGS);
