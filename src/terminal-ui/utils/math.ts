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

export interface MarkdownMathMatch {
  raw: string;
  content: string;
  display: boolean;
}

const GREEK_COMMANDS: Record<string, string> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  varepsilon: "ϵ",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  vartheta: "ϑ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  varpi: "ϖ",
  rho: "ρ",
  varrho: "ϱ",
  sigma: "σ",
  varsigma: "ς",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  varphi: "ϕ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Upsilon: "Υ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω"
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
  partial: "∂",
  nabla: "∇",
  infty: "∞",
  sum: "∑",
  prod: "∏",
  int: "∫",
  iint: "∬",
  iiint: "∭",
  oint: "∮",
  cdot: "·",
  bullet: "•",
  ast: "*",
  star: "⋆",
  times: "×",
  div: "÷",
  pm: "±",
  mp: "∓",
  neq: "≠",
  ne: "≠",
  le: "≤",
  leq: "≤",
  ge: "≥",
  geq: "≥",
  approx: "≈",
  sim: "∼",
  simeq: "≃",
  equiv: "≡",
  propto: "∝",
  to: "→",
  gets: "←",
  leftarrow: "←",
  rightarrow: "→",
  Leftarrow: "⇐",
  Rightarrow: "⇒",
  leftrightarrow: "↔",
  Leftrightarrow: "⇔",
  mapsto: "↦",
  imply: "⇒",
  implies: "⇒",
  iff: "⇔",
  forall: "∀",
  exists: "∃",
  neg: "¬",
  land: "∧",
  wedge: "∧",
  lor: "∨",
  vee: "∨",
  in: "∈",
  notin: "∉",
  ni: "∋",
  subset: "⊂",
  subseteq: "⊆",
  supset: "⊃",
  supseteq: "⊇",
  cup: "∪",
  cap: "∩",
  setminus: "∖",
  emptyset: "∅",
  varnothing: "∅",
  ldots: "…",
  cdots: "⋯",
  dots: "…",
  vdots: "⋮",
  ddots: "⋱",
  perp: "⊥",
  parallel: "∥",
  angle: "∠",
  triangle: "△"
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
  "limits",
  "nolimits",
  "left",
  "right",
  "big",
  "Big",
  "bigg",
  "Bigg"
]);

const SUPERSCRIPT_CHARS: Record<string, string> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "+": "⁺",
  "-": "⁻",
  "=": "⁼",
  "(": "⁽",
  ")": "⁾",
  n: "ⁿ",
  i: "ⁱ"
};

const SUBSCRIPT_CHARS: Record<string, string> = {
  "0": "₀",
  "1": "₁",
  "2": "₂",
  "3": "₃",
  "4": "₄",
  "5": "₅",
  "6": "₆",
  "7": "₇",
  "8": "₈",
  "9": "₉",
  "+": "₊",
  "-": "₋",
  "=": "₌",
  "(": "₍",
  ")": "₎",
  a: "ₐ",
  e: "ₑ",
  h: "ₕ",
  i: "ᵢ",
  j: "ⱼ",
  k: "ₖ",
  l: "ₗ",
  m: "ₘ",
  n: "ₙ",
  o: "ₒ",
  p: "ₚ",
  r: "ᵣ",
  s: "ₛ",
  t: "ₜ",
  u: "ᵤ",
  v: "ᵥ",
  x: "ₓ"
};

const MATRIX_ENVIRONMENTS = new Set([
  "matrix",
  "pmatrix",
  "bmatrix",
  "Bmatrix",
  "vmatrix",
  "Vmatrix",
  "smallmatrix",
  "array"
]);

const ALIGN_ENVIRONMENTS = new Set([
  "align",
  "align*",
  "aligned",
  "alignedat",
  "eqnarray",
  "eqnarray*",
  "equation",
  "equation*",
  "gather",
  "gather*",
  "split"
]);

export function readMarkdownMathSegmentAtStart(input: string): MarkdownMathMatch | undefined {
  if (input[0] !== "$") {
    return undefined;
  }

  const display = input[1] === "$";
  const delimiterLength = display ? 2 : 1;
  const closingIndex = findClosingMathDelimiter(input, delimiterLength, display);
  if (closingIndex < 0) {
    return undefined;
  }

  const rawContent = input.slice(delimiterLength, closingIndex);
  const mathContent = display ? rawContent.trim() : rawContent;
  if (!isValidMathSegment(mathContent, display)) {
    return undefined;
  }

  return {
    raw: input.slice(0, closingIndex + delimiterLength),
    content: mathContent,
    display
  };
}

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
  return parsed.text.includes("\n")
    ? cleanupMathBlockText(parsed.text)
    : cleanupMathText(parsed.text);
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
  if (name === "left" || name === "right") {
    const delimiter = parseMathDelimiter(input, index);
    return {
      text: delimiter.text,
      index: delimiter.index
    };
  }

  if (name === "begin") {
    const environment = parseLatexEnvironment(input, index);
    if (environment) {
      return environment;
    }
  }

  if (SPACING_COMMANDS.has(name)) {
    return {
      text: name === "!" ? "" : " ",
      index
    };
  }

  if (name === "frac" || name === "dfrac" || name === "tfrac") {
    const numerator = parseMathArgument(input, index);
    const denominator = parseMathArgument(input, numerator.index);
    return {
      text: formatFraction(numerator.text, denominator.text),
      index: denominator.index
    };
  }

  if (name === "binom") {
    const top = parseMathArgument(input, index);
    const bottom = parseMathArgument(input, top.index);
    return {
      text: `(${cleanupMathText(top.text)} choose ${cleanupMathText(bottom.text)})`,
      index: bottom.index
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

  if (name === "overline" || name === "underline" || name === "hat" || name === "tilde" || name === "vec") {
    const argument = parseMathArgument(input, index);
    return {
      text: formatDecoratedMath(argument.text, name),
      index: argument.index
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

function parseMathDelimiter(input: string, startIndex: number): { text: string; index: number } {
  const index = skipWhitespace(input, startIndex);
  const delimiter = input[index] ?? "";
  if (!delimiter) {
    return {
      text: "",
      index
    };
  }

  if (delimiter === ".") {
    return {
      text: "",
      index: index + 1
    };
  }

  if (delimiter === "\\") {
    return parseLatexCommand(input, index);
  }

  return {
    text: delimiter,
    index: index + 1
  };
}

function parseLatexEnvironment(
  input: string,
  startIndex: number
): { text: string; index: number } | undefined {
  const environmentName = parseRawBraceArgument(input, startIndex);
  if (!environmentName) {
    return undefined;
  }

  let contentStart = environmentName.index;
  const name = environmentName.text.trim();
  if (name === "array") {
    const columnSpec = parseRawBraceArgument(input, contentStart);
    if (columnSpec) {
      contentStart = columnSpec.index;
    }
  }

  const environment = findEnvironmentContent(input, contentStart, name);
  if (!environment) {
    return undefined;
  }

  return {
    text: renderMathEnvironment(name, environment.content),
    index: environment.index
  };
}

function parseRawBraceArgument(
  input: string,
  startIndex: number
): { text: string; index: number } | undefined {
  const index = skipWhitespace(input, startIndex);
  if (input[index] !== "{") {
    return undefined;
  }

  let depth = 1;
  let cursor = index + 1;
  let text = "";
  while (cursor < input.length && depth > 0) {
    const character = input[cursor] ?? "";
    if (character === "\\") {
      text += input.slice(cursor, cursor + 2);
      cursor += 2;
      continue;
    }

    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          text,
          index: cursor + 1
        };
      }
    }

    text += character;
    cursor += 1;
  }

  return undefined;
}

function findEnvironmentContent(
  input: string,
  startIndex: number,
  name: string
): { content: string; index: number } | undefined {
  const endMarker = `\\end{${name}}`;
  const endIndex = input.indexOf(endMarker, startIndex);
  if (endIndex < 0) {
    return undefined;
  }

  return {
    content: input.slice(startIndex, endIndex),
    index: endIndex + endMarker.length
  };
}

function renderMathEnvironment(name: string, content: string): string {
  const rows = splitLatexRows(content)
    .map((row) => splitLatexCells(row).map(renderMathCell))
    .filter((row) => row.some((cell) => cell.length > 0));

  if (rows.length === 0) {
    return "";
  }

  if (name === "cases") {
    return renderCases(rows);
  }

  if (MATRIX_ENVIRONMENTS.has(name)) {
    return renderMatrix(name, rows);
  }

  if (ALIGN_ENVIRONMENTS.has(name)) {
    return rows.map((row) => row.filter(Boolean).join(" ")).join("\n");
  }

  return rows.map((row) => row.filter(Boolean).join(" ")).join("\n");
}

function splitLatexRows(content: string): string[] {
  const rows: string[] = [];
  let buffer = "";
  let index = 0;
  while (index < content.length) {
    if (content[index] === "\\" && content[index + 1] === "\\") {
      rows.push(buffer);
      buffer = "";
      index += 2;
      continue;
    }

    if (content[index] === "\\" && content.slice(index, index + 3) === "\\cr") {
      rows.push(buffer);
      buffer = "";
      index += 3;
      continue;
    }

    buffer += content[index] ?? "";
    index += 1;
  }

  rows.push(buffer);
  return rows;
}

function splitLatexCells(row: string): string[] {
  const cells: string[] = [];
  let buffer = "";
  let braceDepth = 0;
  let index = 0;
  while (index < row.length) {
    const character = row[index] ?? "";
    if (character === "\\") {
      buffer += row.slice(index, index + 2);
      index += 2;
      continue;
    }

    if (character === "{") {
      braceDepth += 1;
    } else if (character === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
    }

    if (character === "&" && braceDepth === 0) {
      cells.push(buffer);
      buffer = "";
      index += 1;
      continue;
    }

    buffer += character;
    index += 1;
  }

  cells.push(buffer);
  return cells;
}

function renderMathCell(cell: string): string {
  return cleanupMathText(parseMathExpression(cell.trim(), 0, null).text);
}

function renderCases(rows: string[][]): string {
  return rows
    .map((row) => {
      const expression = row[0] ?? "";
      const condition = row.slice(1).filter(Boolean).join(" ");
      return condition ? `{ ${expression}, ${condition}` : `{ ${expression}`;
    })
    .join("\n");
}

function renderMatrix(name: string, rows: string[][]): string {
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const widths = Array.from({ length: columnCount }, (_, columnIndex) =>
    rows.reduce((max, row) => Math.max(max, stringWidth(row[columnIndex] ?? "")), 0)
  );
  const [left, right] = getMatrixDelimiters(name);

  return rows
    .map((row) => {
      const paddedCells = widths.map((width, columnIndex) =>
        padEndByWidth(row[columnIndex] ?? "", width)
      );
      if (!left && !right) {
        return paddedCells.join("  ").trimEnd();
      }
      return `${left} ${paddedCells.join("  ").trimEnd()} ${right}`.trimEnd();
    })
    .join("\n");
}

function getMatrixDelimiters(name: string): [string, string] {
  switch (name) {
    case "pmatrix":
      return ["(", ")"];
    case "bmatrix":
      return ["[", "]"];
    case "Bmatrix":
      return ["{", "}"];
    case "vmatrix":
      return ["|", "|"];
    case "Vmatrix":
      return ["‖", "‖"];
    default:
      return ["", ""];
  }
}

function stringWidth(value: string): number {
  return Array.from(value).length;
}

function padEndByWidth(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - stringWidth(value)));
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
    return `√(${inner})`;
  }

  return `root(${cleanupMathText(rootIndex)}, ${inner})`;
}

function formatDecoratedMath(text: string, command: string): string {
  const cleaned = cleanupMathText(text);
  switch (command) {
    case "hat":
      return `${cleaned}̂`;
    case "tilde":
      return `${cleaned}̃`;
    case "vec":
      return `${cleaned}⃗`;
    case "underline":
      return `_${cleaned}_`;
    case "overline":
    default:
      return `${cleaned}̅`;
  }
}

function formatScript(text: string, superscript: boolean): string {
  if (!text) {
    return "";
  }

  const mapped = mapScriptText(text, superscript);
  if (mapped) {
    return mapped;
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
  return /^[\p{L}\p{N}.+\-*/|=<>≤≥≠≈∈∉⊂⊃⊆⊇]+$/u.test(value);
}

function cleanupMathText(value: string): string {
  return value
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .split("\n")
    .map((line) =>
      line
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .replace(/\s+([,.;:!?，。；：！？])/g, "$1")
        .trim()
    )
    .join("\n")
    .trim();
}

function cleanupMathBlockText(value: string): string {
  return value
    .replace(/[ \t\f\v]+\n/g, "\n")
    .replace(/\n[ \t\f\v]+/g, "\n")
    .split("\n")
    .map((line) =>
      line
        .replace(/\s+([,.;:!?，。；：！？])/g, "$1")
        .trimEnd()
    )
    .join("\n")
    .trim();
}

function mapScriptText(text: string, superscript: boolean): string | undefined {
  const source = cleanupMathText(text);
  if (!source) {
    return undefined;
  }

  const map = superscript ? SUPERSCRIPT_CHARS : SUBSCRIPT_CHARS;
  let result = "";
  for (const character of Array.from(source)) {
    const mapped = map[character];
    if (!mapped) {
      return undefined;
    }
    result += mapped;
  }

  return result;
}
