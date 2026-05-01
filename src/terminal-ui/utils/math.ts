export type MarkdownMathSegment =
  | {
      type: "text";
      content: string;
    }
  | {
      type: "math";
      content: string;
      display: boolean;
    };

const GREEK_COMMANDS: Record<string, string> = {
  alpha: "alpha",
  beta: "beta",
  gamma: "gamma",
  delta: "delta",
  epsilon: "epsilon",
  varepsilon: "epsilon",
  zeta: "zeta",
  eta: "eta",
  theta: "theta",
  vartheta: "theta",
  iota: "iota",
  kappa: "kappa",
  lambda: "lambda",
  mu: "mu",
  nu: "nu",
  xi: "xi",
  pi: "pi",
  varpi: "pi",
  rho: "rho",
  varrho: "rho",
  sigma: "sigma",
  varsigma: "sigma",
  tau: "tau",
  upsilon: "upsilon",
  phi: "phi",
  varphi: "phi",
  chi: "chi",
  psi: "psi",
  omega: "omega",
  Gamma: "Gamma",
  Delta: "Delta",
 Theta: "Theta",
 Lambda: "Lambda",
 Xi: "Xi",
 Pi: "Pi",
 Sigma: "Sigma",
 Upsilon: "Upsilon",
 Phi: "Phi",
 Psi: "Psi",
 Omega: "Omega"
};

const SIMPLE_COMMANDS: Record<string, string> = {
  sin: "sin",
  cos: "cos",
  tan: "tan",
  cot: "cot",
  sec: "sec",
  csc: "csc",
  arcsin: "arcsin",
  arccos: "arccos",
  arctan: "arctan",
  sinh: "sinh",
  cosh: "cosh",
  tanh: "tanh",
  log: "log",
  ln: "ln",
  exp: "exp",
  lim: "lim",
  min: "min",
  max: "max",
  sup: "sup",
  inf: "inf",
  det: "det",
  dim: "dim",
  gcd: "gcd",
  deg: "deg",
  partial: "partial",
  nabla: "nabla",
  infty: "infinity",
  cdot: "*",
  times: "*",
  div: "/",
  pm: "+/-",
  mp: "-/+",
  neq: "!=",
  ne: "!=",
  le: "<=",
  leq: "<=",
  ge: ">=",
  geq: ">=",
  approx: "~",
  sim: "~",
  equiv: "==",
  to: "->",
  gets: "<-",
  leftarrow: "<-",
  rightarrow: "->",
  leftrightarrow: "<->",
  mapsto: "->",
  imply: "=>",
  implies: "=>",
  forall: "forall",
  exists: "exists",
  in: "in",
  notin: "not in",
  subset: "subset",
  subseteq: "subseteq",
  supset: "supset",
  supseteq: "supseteq",
  cup: "union",
  cap: "intersect",
  emptyset: "empty",
  varnothing: "empty",
  ldots: "...",
  cdots: "...",
  dots: "...",
  perp: "perp",
  parallel: "parallel",
  angle: "angle",
  triangle: "triangle"
};

const SPACING_COMMANDS = new Set([
  ",",
  ":",
  ";",
  "!",
  " ",
  "quad",
  "qquad",
  "enspace",
  "thinspace",
  "medspace",
  "thickspace",
  "displaystyle",
  "textstyle",
  "scriptstyle",
  "scriptscriptstyle",
  "left",
  "right",
  "big",
  "Big",
  "bigg",
  "Bigg"
]);

export function splitMarkdownMathSegments(input: string): MarkdownMathSegment[] {
  const segments: MarkdownMathSegment[] = [];
  let buffer = "";
  let index = 0;

  while (index < input.length) {
    if (input[index] === "\\" && input[index + 1] === "$") {
      buffer += "$";
      index += 2;
      continue;
    }

    if (input[index] !== "$") {
      buffer += input[index] ?? "";
      index += 1;
      continue;
    }

    const display = input[index + 1] === "$";
    const delimiterLength = display ? 2 : 1;
    const closingIndex = findClosingMathDelimiter(input, index + delimiterLength, display);
    if (closingIndex < 0) {
      buffer += input.slice(index, index + delimiterLength);
      index += delimiterLength;
      continue;
    }

    const rawContent = input.slice(index + delimiterLength, closingIndex);
    const mathContent = display ? rawContent.trim() : rawContent;
    if (!isValidMathSegment(mathContent, display)) {
      buffer += input.slice(index, closingIndex + delimiterLength);
      index = closingIndex + delimiterLength;
      continue;
    }

    if (buffer.length > 0) {
      segments.push({
        type: "text",
        content: buffer
      });
      buffer = "";
    }

    segments.push({
      type: "math",
      content: mathContent,
      display
    });
    index = closingIndex + delimiterLength;
  }

  if (buffer.length > 0 || segments.length === 0) {
    segments.push({
      type: "text",
      content: buffer
    });
  }

  return segments;
}

export function renderLatexMathToText(input: string): string {
  const normalized = normalizeMathWhitespace(input);
  if (!normalized) {
    return "";
  }

  const parsed = parseMathExpression(normalized, 0, null);
  return cleanupMathText(parsed.text);
}

function findClosingMathDelimiter(input: string, startIndex: number, display: boolean): number {
  let index = startIndex;

  while (index < input.length) {
    if (input[index] === "\\" && input[index + 1] === "$") {
      index += 2;
      continue;
    }

    if (display) {
      if (input[index] === "$" && input[index + 1] === "$") {
        return index;
      }
      index += 1;
      continue;
    }

    if (input[index] === "$") {
      return index;
    }
    index += 1;
  }

  return -1;
}

function isValidMathSegment(content: string, display: boolean): boolean {
  if (!content.trim()) {
    return false;
  }

  if (display) {
    return true;
  }

  return content === content.trim();
}

function normalizeMathWhitespace(input: string): string {
  return input
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMathExpression(
  input: string,
  startIndex: number,
  stopChar: string | null
): { text: string; index: number } {
  let index = startIndex;
  let text = "";

  while (index < input.length) {
    const character = input[index] ?? "";
    if (stopChar && character === stopChar) {
      break;
    }

    if (character === "\\") {
      const command = parseLatexCommand(input, index);
      text += command.text;
      index = command.index;
      continue;
    }

    if (character === "^" || character === "_") {
      const script = parseScriptArgument(input, index + 1);
      text += formatScript(script.text, character === "^");
      index = script.index;
      continue;
    }

    if (character === "{") {
      const group = parseMathExpression(input, index + 1, "}");
      text += group.text;
      index = group.index;
      if (input[index] === "}") {
        index += 1;
      }
      continue;
    }

    if (character === "}") {
      break;
    }

    if (character === "~") {
      text += " ";
      index += 1;
      continue;
    }

    text += character;
    index += 1;
  }

  return {
    text,
    index
  };
}

function parseLatexCommand(input: string, startIndex: number): { text: string; index: number } {
  let index = startIndex + 1;
  if (index >= input.length) {
    return {
      text: "\\",
      index
    };
  }

  const symbol = input[index] ?? "";
  if (!/[A-Za-z]/.test(symbol)) {
    return {
      text: parseSingleCharacterCommand(symbol),
      index: index + 1
    };
  }

  while (index < input.length && /[A-Za-z]/.test(input[index] ?? "")) {
    index += 1;
  }

  const name = input.slice(startIndex + 1, index);
  if (SPACING_COMMANDS.has(name)) {
    return {
      text: name === "!" ? "" : " ",
      index
    };
  }

  if (name === "frac") {
    const numerator = parseMathArgument(input, index);
    const denominator = parseMathArgument(input, numerator.index);
    return {
      text: formatFraction(numerator.text, denominator.text),
      index: denominator.index
    };
  }

  if (name === "sqrt") {
    const rootIndex = parseOptionalBracketArgument(input, index);
    const radicand = parseMathArgument(input, rootIndex.index);
    return {
      text: formatSquareRoot(radicand.text, rootIndex.text),
      index: radicand.index
    };
  }

  if (
    name === "text" ||
    name === "mathrm" ||
    name === "mathbf" ||
    name === "mathit" ||
    name === "mathsf" ||
    name === "mathtt" ||
    name === "operatorname"
  ) {
    const argument = parseMathArgument(input, index);
    return {
      text: cleanupMathText(argument.text),
      index: argument.index
    };
  }

  if (name in SIMPLE_COMMANDS) {
    return {
      text: SIMPLE_COMMANDS[name] ?? name,
      index
    };
  }

  if (name in GREEK_COMMANDS) {
    return {
      text: GREEK_COMMANDS[name] ?? name,
      index
    };
  }

  return {
    text: name,
    index
  };
}

function parseSingleCharacterCommand(command: string): string {
  switch (command) {
    case "\\":
      return "\\";
    case "{":
      return "{";
    case "}":
      return "}";
    case "%":
      return "%";
    case "_":
      return "_";
    case "^":
      return "^";
    case "#":
      return "#";
    case "&":
      return "&";
    case "$":
      return "$";
    case ",":
    case ":":
    case ";":
    case " ":
      return " ";
    default:
      return command;
  }
}

function parseMathArgument(input: string, startIndex: number): { text: string; index: number } {
  const index = skipWhitespace(input, startIndex);
  if (index >= input.length) {
    return {
      text: "",
      index
    };
  }

  if (input[index] === "{") {
    const group = parseMathExpression(input, index + 1, "}");
    return {
      text: cleanupMathText(group.text),
      index: input[group.index] === "}" ? group.index + 1 : group.index
    };
  }

  if (input[index] === "\\") {
    return parseLatexCommand(input, index);
  }

  return {
    text: input[index] ?? "",
    index: index + 1
  };
}

function parseOptionalBracketArgument(
  input: string,
  startIndex: number
): { text: string | null; index: number } {
  const index = skipWhitespace(input, startIndex);
  if (input[index] !== "[") {
    return {
      text: null,
      index
    };
  }

  let cursor = index + 1;
  let text = "";
  while (cursor < input.length && input[cursor] !== "]") {
    text += input[cursor] ?? "";
    cursor += 1;
  }

  return {
    text: cleanupMathText(text),
    index: input[cursor] === "]" ? cursor + 1 : cursor
  };
}

function parseScriptArgument(input: string, startIndex: number): { text: string; index: number } {
  const argument = parseMathArgument(input, startIndex);
  return {
    text: cleanupMathText(argument.text),
    index: argument.index
  };
}

function skipWhitespace(input: string, startIndex: number): number {
  let index = startIndex;
  while (index < input.length && /\s/.test(input[index] ?? "")) {
    index += 1;
  }
  return index;
}

function formatFraction(numerator: string, denominator: string): string {
  const top = wrapMathGroup(cleanupMathText(numerator));
  const bottom = wrapMathGroup(cleanupMathText(denominator));
  return `${top}/${bottom}`;
}

function formatSquareRoot(radicand: string, rootIndex: string | null): string {
  const inner = wrapMathGroup(cleanupMathText(radicand));
  if (!rootIndex) {
    return `sqrt(${inner})`;
  }

  return `root(${cleanupMathText(rootIndex)}, ${inner})`;
}

function formatScript(text: string, superscript: boolean): string {
  if (!text) {
    return "";
  }

  if (isSimpleMathAtom(text)) {
    return `${superscript ? "^" : "_"}${text}`;
  }

  return `${superscript ? "^" : "_"}(${text})`;
}

function wrapMathGroup(value: string): string {
  if (!value) {
    return "";
  }

  return isSimpleMathAtom(value) ? value : `(${value})`;
}

function isSimpleMathAtom(value: string): boolean {
  return /^[A-Za-z0-9.+-]+$/.test(value);
}

function cleanupMathText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}
