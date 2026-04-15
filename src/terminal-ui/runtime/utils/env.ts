export type RuntimeEnv = {
  terminal: string | undefined;
};

function detectTerminal(): string | undefined {
  if (process.env.TERM_PROGRAM) {
    return process.env.TERM_PROGRAM;
  }

  if (process.env.WT_SESSION) {
    return "windows-terminal";
  }

  if (process.env.TMUX) {
    return "tmux";
  }

  if (process.env.KITTY_WINDOW_ID || process.env.TERM?.includes("kitty")) {
    return "kitty";
  }

  if (process.env.TERM === "xterm-ghostty") {
    return "ghostty";
  }

  return undefined;
}

export const env: RuntimeEnv = {
  terminal: detectTerminal()
};
