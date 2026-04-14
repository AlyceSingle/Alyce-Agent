import { useEffect } from "react";
import { useStdin } from "./ink.js";
import { nonAlphanumericKeys, parseKeypress } from "./parseKeypress.js";

type BaseInkKey = {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  pageDown: boolean;
  pageUp: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  shift: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  meta: boolean;
};

export type TerminalKey = BaseInkKey & {
  home: boolean;
  end: boolean;
  space: boolean;
  name: string;
  raw?: string;
  sequence: string;
};

type InputHandler = (input: string, key: TerminalKey) => void;

type Options = {
  isActive?: boolean;
};

export function useTerminalInput(inputHandler: InputHandler, options: Options = {}) {
  const { setRawMode, internal_eventEmitter, internal_exitOnCtrlC } = useStdin();

  useEffect(() => {
    if (options.isActive === false) {
      return;
    }

    setRawMode(true);
    return () => {
      setRawMode(false);
    };
  }, [options.isActive, setRawMode]);

  useEffect(() => {
    if (options.isActive === false) {
      return;
    }

    const handleData = (data: Buffer | string) => {
      const keypress = parseKeypress(data);
      const key: TerminalKey = {
        upArrow: keypress.name === "up",
        downArrow: keypress.name === "down",
        leftArrow: keypress.name === "left",
        rightArrow: keypress.name === "right",
        pageDown: keypress.name === "pagedown",
        pageUp: keypress.name === "pageup",
        return: keypress.name === "return",
        escape: keypress.name === "escape",
        ctrl: keypress.ctrl,
        shift: keypress.shift,
        tab: keypress.name === "tab",
        backspace: keypress.name === "backspace",
        delete: keypress.name === "delete",
        meta: keypress.meta || keypress.name === "escape" || keypress.option,
        home: keypress.name === "home",
        end: keypress.name === "end",
        space: keypress.name === "space",
        name: keypress.name,
        raw: keypress.raw,
        sequence: keypress.sequence
      };

      let input = keypress.ctrl ? keypress.name : keypress.sequence;
      if (nonAlphanumericKeys.includes(keypress.name)) {
        input = "";
      }

      if (input.startsWith("\u001B")) {
        input = input.slice(1);
      }

      if (input.length === 1 && /[A-Z]/.test(input)) {
        key.shift = true;
      }

      if (!(input === "c" && key.ctrl) || !internal_exitOnCtrlC) {
        inputHandler(input, key);
      }
    };

    internal_eventEmitter.on("input", handleData);
    return () => {
      internal_eventEmitter.removeListener("input", handleData);
    };
  }, [internal_eventEmitter, internal_exitOnCtrlC, inputHandler, options.isActive]);
}
