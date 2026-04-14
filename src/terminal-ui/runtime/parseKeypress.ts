import { Buffer } from "node:buffer";

type ParsedKeypress = {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  option: boolean;
  super: boolean;
  sequence: string;
  raw: string | undefined;
  code?: string;
};

export type KeyParseState = {
  pending: string;
  inPaste: boolean;
  pasteBuffer: string;
};

export const INITIAL_KEY_PARSE_STATE: KeyParseState = {
  pending: "",
  inPaste: false,
  pasteBuffer: ""
};

const META_KEY_CODE_RE = /^(?:\x1b)([a-zA-Z0-9])$/;
const FUNCTION_KEY_RE = /^(?:\x1b+)(O|N|\[|\[\[)(?:(\d+)(?:;(\d+))?([~^$])|(?:1;)?(\d+)?([a-zA-Z]))/;
const CSI_U_RE = /^\x1b\[(\d+)(?:;(\d+))?u/;
const MODIFY_OTHER_KEYS_RE = /^\x1b\[27;(\d+);(\d+)~/;
const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const keyNameMap: Record<string, string> = {
  OP: "f1",
  OQ: "f2",
  OR: "f3",
  OS: "f4",
  Op: "0",
  Oq: "1",
  Or: "2",
  Os: "3",
  Ot: "4",
  Ou: "5",
  Ov: "6",
  Ow: "7",
  Ox: "8",
  Oy: "9",
  Oj: "*",
  Ok: "+",
  Ol: ",",
  Om: "-",
  On: ".",
  Oo: "/",
  OM: "return",
  "[11~": "f1",
  "[12~": "f2",
  "[13~": "f3",
  "[14~": "f4",
  "[[A": "f1",
  "[[B": "f2",
  "[[C": "f3",
  "[[D": "f4",
  "[[E": "f5",
  "[15~": "f5",
  "[17~": "f6",
  "[18~": "f7",
  "[19~": "f8",
  "[20~": "f9",
  "[21~": "f10",
  "[23~": "f11",
  "[24~": "f12",
  "[A": "up",
  "[B": "down",
  "[C": "right",
  "[D": "left",
  "[E": "clear",
  "[F": "end",
  "[H": "home",
  OA: "up",
  OB: "down",
  OC: "right",
  OD: "left",
  OE: "clear",
  OF: "end",
  OH: "home",
  "[1~": "home",
  "[2~": "insert",
  "[3~": "delete",
  "[4~": "end",
  "[5~": "pageup",
  "[6~": "pagedown",
  "[[5~": "pageup",
  "[[6~": "pagedown",
  "[7~": "home",
  "[8~": "end",
  "[a": "up",
  "[b": "down",
  "[c": "right",
  "[d": "left",
  "[e": "clear",
  "[2$": "insert",
  "[3$": "delete",
  "[5$": "pageup",
  "[6$": "pagedown",
  "[7$": "home",
  "[8$": "end",
  Oa: "up",
  Ob: "down",
  Oc: "right",
  Od: "left",
  Oe: "clear",
  "[2^": "insert",
  "[3^": "delete",
  "[5^": "pageup",
  "[6^": "pagedown",
  "[7^": "home",
  "[8^": "end",
  "[Z": "tab"
};

export const nonAlphanumericKeys = [
  ...Object.values(keyNameMap).filter((value) => value.length > 1),
  "escape",
  "backspace",
  "wheelup",
  "wheeldown",
  "mouse"
];

function isShiftKey(code: string) {
  return [
    "[a",
    "[b",
    "[c",
    "[d",
    "[e",
    "[2$",
    "[3$",
    "[5$",
    "[6$",
    "[7$",
    "[8$",
    "[Z"
  ].includes(code);
}

function isCtrlKey(code: string) {
  return [
    "Oa",
    "Ob",
    "Oc",
    "Od",
    "Oe",
    "[2^",
    "[3^",
    "[5^",
    "[6^",
    "[7^",
    "[8^"
  ].includes(code);
}

function decodeModifier(modifier: number) {
  const bitmask = modifier - 1;
  return {
    shift: Boolean(bitmask & 1),
    meta: Boolean(bitmask & 2),
    ctrl: Boolean(bitmask & 4),
    super: Boolean(bitmask & 8)
  };
}

function keycodeToName(keycode: number): string | undefined {
  switch (keycode) {
    case 9:
      return "tab";
    case 13:
      return "return";
    case 27:
      return "escape";
    case 32:
      return "space";
    case 48:
      return "0";
    case 49:
      return "1";
    case 50:
      return "2";
    case 51:
      return "3";
    case 52:
      return "4";
    case 53:
      return "5";
    case 54:
      return "6";
    case 55:
      return "7";
    case 56:
      return "8";
    case 57:
      return "9";
    case 127:
      return "backspace";
    default:
      if (keycode >= 33 && keycode <= 126) {
        return String.fromCharCode(keycode).toLowerCase();
      }

      return undefined;
  }
}

function normalizeInput(value: Buffer | string | null = "") {
  if (value === null) {
    return "";
  }

  let input = value;
  if (Buffer.isBuffer(input)) {
    if (input[0] && input[0] > 127 && input[1] === undefined) {
      input[0] -= 128;
      return "\x1b" + String(input);
    }

    return String(input);
  }

  if (input !== undefined && typeof input !== "string") {
    return String(input);
  }

  return input || "";
}

function createNavKey(input: string, name: string, ctrl = false): ParsedKeypress {
  return {
    name,
    ctrl,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: input,
    raw: input
  };
}

function matchEscapeSequenceLength(input: string) {
  if (!input.startsWith("\x1b")) {
    return 0;
  }

  if (input.startsWith(PASTE_START)) {
    return PASTE_START.length;
  }

  if (input.startsWith(PASTE_END)) {
    return PASTE_END.length;
  }

  if (input.startsWith("\x1b[M")) {
    return input.length >= 6 ? 6 : 0;
  }

  const regexes = [
    MODIFY_OTHER_KEYS_RE,
    CSI_U_RE,
    SGR_MOUSE_RE,
    FUNCTION_KEY_RE,
    META_KEY_CODE_RE
  ];

  for (const regex of regexes) {
    const match = regex.exec(input);
    if (match) {
      return match[0].length;
    }
  }

  if (
    input.startsWith("\x1b\b") ||
    input.startsWith("\x1b\x7f") ||
    input.startsWith("\x1b ") ||
    input.startsWith("\x1b\r") ||
    input.startsWith("\x1b\n") ||
    input.startsWith("\x1b\x1b")
  ) {
    return input.length >= 2 ? 2 : 0;
  }

  if (input === "\x1b") {
    return 1;
  }

  if (input.startsWith("\x1b[")) {
    return 0;
  }

  return 1;
}

export function parseMultipleKeypresses(
  previousState: KeyParseState,
  value: Buffer | string | null = ""
): [string[], KeyParseState] {
  const isFlush = value === null;
  const data = previousState.pending + normalizeInput(value);
  const tokens: string[] = [];
  let pending = "";
  let inPaste = previousState.inPaste;
  let pasteBuffer = previousState.pasteBuffer;
  let textBuffer = "";
  let index = 0;

  const flushText = () => {
    if (textBuffer.length > 0) {
      tokens.push(textBuffer);
      textBuffer = "";
    }
  };

  while (index < data.length) {
    if (inPaste) {
      const pasteEndIndex = data.indexOf(PASTE_END, index);
      if (pasteEndIndex === -1) {
        pasteBuffer += data.slice(index);
        index = data.length;
        break;
      }

      pasteBuffer += data.slice(index, pasteEndIndex);
      tokens.push(pasteBuffer);
      pasteBuffer = "";
      inPaste = false;
      index = pasteEndIndex + PASTE_END.length;
      continue;
    }

    if (data.startsWith(PASTE_START, index)) {
      flushText();
      inPaste = true;
      pasteBuffer = "";
      index += PASTE_START.length;
      continue;
    }

    if (data[index] !== "\x1b") {
      textBuffer += data[index] ?? "";
      index += 1;
      continue;
    }

    flushText();
    const remaining = data.slice(index);
    const tokenLength = matchEscapeSequenceLength(remaining);
    if (tokenLength === 0) {
      pending = remaining;
      index = data.length;
      break;
    }

    tokens.push(remaining.slice(0, tokenLength));
    index += tokenLength;
  }

  flushText();

  if (isFlush) {
    if (pending) {
      tokens.push(pending);
      pending = "";
    }

    if (inPaste && pasteBuffer) {
      tokens.push(pasteBuffer);
      inPaste = false;
      pasteBuffer = "";
    }
  }

  return [tokens, {
    pending,
    inPaste,
    pasteBuffer
  }];
}

export function parseKeypress(value: Buffer | string = ""): ParsedKeypress {
  let parts: RegExpExecArray | null;
  const input = normalizeInput(value);

  if ((parts = CSI_U_RE.exec(input))) {
    const codepoint = Number(parts[1] ?? 0);
    const modifier = Number(parts[2] ?? 1);
    const modifiers = decodeModifier(modifier);
    const name = keycodeToName(codepoint) ?? "";

    return {
      name,
      ctrl: modifiers.ctrl,
      meta: modifiers.meta,
      shift: modifiers.shift,
      option: false,
      super: modifiers.super,
      sequence: input,
      raw: input
    };
  }

  if ((parts = MODIFY_OTHER_KEYS_RE.exec(input))) {
    const modifiers = decodeModifier(Number(parts[1] ?? 1));
    const name = keycodeToName(Number(parts[2] ?? 0)) ?? "";

    return {
      name,
      ctrl: modifiers.ctrl,
      meta: modifiers.meta,
      shift: modifiers.shift,
      option: false,
      super: modifiers.super,
      sequence: input,
      raw: input
    };
  }

  if ((parts = SGR_MOUSE_RE.exec(input))) {
    const button = Number(parts[1] ?? 0);
    if ((button & 0x43) === 0x40) {
      return createNavKey(input, "wheelup");
    }

    if ((button & 0x43) === 0x41) {
      return createNavKey(input, "wheeldown");
    }

    return createNavKey(input, "mouse");
  }

  if (input.length === 6 && input.startsWith("\x1b[M")) {
    const button = input.charCodeAt(3) - 32;
    if ((button & 0x43) === 0x40) {
      return createNavKey(input, "wheelup");
    }

    if ((button & 0x43) === 0x41) {
      return createNavKey(input, "wheeldown");
    }

    return createNavKey(input, "mouse");
  }

  const keypress: ParsedKeypress = {
    name: "",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: input,
    raw: input
  };

  if (input === "\r") {
    keypress.raw = undefined;
    keypress.name = "return";
  } else if (input === "\x00") {
    keypress.name = "0";
    keypress.ctrl = true;
  } else if (input === "\n") {
    keypress.name = "enter";
  } else if (input === "\t") {
    keypress.name = "tab";
  } else if (input === "\b" || input === "\x1b\b") {
    keypress.name = "backspace";
    keypress.meta = input.charAt(0) === "\x1b";
  } else if (input === "\x7f" || input === "\x1b\x7f") {
    keypress.name = "backspace";
    keypress.meta = input.charAt(0) === "\x1b";
  } else if (input === "\x1b" || input === "\x1b\x1b") {
    keypress.name = "escape";
    keypress.meta = input.length === 2;
  } else if (input === "\x1b\r" || input === "\x1b\n") {
    keypress.name = "return";
    keypress.meta = true;
  } else if (input === " " || input === "\x1b ") {
    keypress.name = "space";
    keypress.meta = input.length === 2;
  } else if (input === "\x1f") {
    keypress.name = "_";
    keypress.ctrl = true;
  } else if (input.length === 1 && input <= "\x1a") {
    keypress.name = String.fromCharCode(input.charCodeAt(0) + "a".charCodeAt(0) - 1);
    keypress.ctrl = true;
  } else if (input.length === 1 && input >= "0" && input <= "9") {
    keypress.name = input;
  } else if (input.length === 1 && input >= "a" && input <= "z") {
    keypress.name = input;
  } else if (input.length === 1 && input >= "A" && input <= "Z") {
    keypress.name = input.toLowerCase();
    keypress.shift = true;
  } else if ((parts = META_KEY_CODE_RE.exec(input))) {
    keypress.name = parts[1]?.toLowerCase() ?? "";
    keypress.meta = true;
    keypress.shift = /^[A-Z]$/.test(parts[1] ?? "");
  } else if ((parts = FUNCTION_KEY_RE.exec(input))) {
    const segments = [...input];
    if (segments[0] === "\u001b" && segments[1] === "\u001b") {
      keypress.option = true;
    }

    const code = [parts[1], parts[2], parts[4], parts[6]].filter(Boolean).join("");
    const modifier = Number(parts[3] || parts[5] || 1) - 1;
    keypress.ctrl = Boolean(modifier & 4);
    keypress.meta = Boolean(modifier & 2);
    keypress.super = Boolean(modifier & 8);
    keypress.shift = Boolean(modifier & 1);
    keypress.code = code;
    keypress.name = keyNameMap[code] ?? "";
    keypress.shift = isShiftKey(code) || keypress.shift;
    keypress.ctrl = isCtrlKey(code) || keypress.ctrl;
  }

  switch (input) {
    case "\u001b[1;5D":
      return createNavKey(input, "left", true);
    case "\u001b[1;5C":
      return createNavKey(input, "right", true);
    default:
      return keypress;
  }
}
