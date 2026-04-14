import { Buffer } from "node:buffer";

type ParsedKeypress = {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  option: boolean;
  sequence: string;
  raw: string | undefined;
  code?: string;
};

const META_KEY_CODE_RE = /^(?:\x1b)([a-zA-Z0-9])$/;
const FUNCTION_KEY_RE = /^(?:\x1b+)(O|N|\[|\[\[)(?:(\d+)(?:;(\d+))?([~^$])|(?:1;)?(\d+)?([a-zA-Z]))/;

const keyNameMap: Record<string, string> = {
  OP: "f1",
  OQ: "f2",
  OR: "f3",
  OS: "f4",
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

export const nonAlphanumericKeys = [...Object.values(keyNameMap), "backspace"];

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

export function parseKeypress(value: Buffer | string = ""): ParsedKeypress {
  let parts: RegExpExecArray | null;
  let input = value;

  if (Buffer.isBuffer(input)) {
    if (input[0] && input[0] > 127 && input[1] === undefined) {
      input[0] -= 128;
      input = "\x1b" + String(input);
    } else {
      input = String(input);
    }
  } else if (input !== undefined && typeof input !== "string") {
    input = String(input);
  } else if (!input) {
    input = "";
  }

  const keypress: ParsedKeypress = {
    name: "",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    sequence: input,
    raw: input
  };

  if (input === "\r") {
    keypress.raw = undefined;
    keypress.name = "return";
  } else if (input === "\n") {
    keypress.name = "enter";
  } else if (input === "\t") {
    keypress.name = "tab";
  } else if (input === "\b" || input === "\x1b\b") {
    keypress.name = "backspace";
    keypress.meta = input.charAt(0) === "\x1b";
  } else if (input === "\x7f" || input === "\x1b\x7f") {
    keypress.name = "delete";
    keypress.meta = input.charAt(0) === "\x1b";
  } else if (input === "\x1b" || input === "\x1b\x1b") {
    keypress.name = "escape";
    keypress.meta = input.length === 2;
  } else if (input === " " || input === "\x1b ") {
    keypress.name = "space";
    keypress.meta = input.length === 2;
  } else if (input.length === 1 && input <= "\x1a") {
    keypress.name = String.fromCharCode(input.charCodeAt(0) + "a".charCodeAt(0) - 1);
    keypress.ctrl = true;
  } else if (input.length === 1 && input >= "0" && input <= "9") {
    keypress.name = "number";
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
    keypress.meta = Boolean(modifier & 10);
    keypress.shift = Boolean(modifier & 1);
    keypress.code = code;
    keypress.name = keyNameMap[code] ?? "";
    keypress.shift = isShiftKey(code) || keypress.shift;
    keypress.ctrl = isCtrlKey(code) || keypress.ctrl;
  }

  return keypress;
}
