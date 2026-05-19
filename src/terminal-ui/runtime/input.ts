import { useEffect, useLayoutEffect, useRef } from "react";
import { useStdin } from "./ink.js";

type InkInputEvent = {
  input: string;
  key: BaseInkKey & {
    home: boolean;
    end: boolean;
  };
  keypress?: {
    name?: string;
    raw?: string;
    sequence?: string;
  };
};

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
  wheelUp: boolean;
  wheelDown: boolean;
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
  const isActive = options.isActive !== false;
  const inputHandlerRef = useRef(inputHandler);
  const isActiveRef = useRef(isActive);
  const exitOnCtrlCRef = useRef(internal_exitOnCtrlC);

  useLayoutEffect(() => {
    inputHandlerRef.current = inputHandler;
    isActiveRef.current = isActive;
    exitOnCtrlCRef.current = internal_exitOnCtrlC;
  });

  useLayoutEffect(() => {
    if (!isActive) {
      return;
    }

    setRawMode(true);
    return () => {
      setRawMode(false);
    };
  }, [isActive, setRawMode]);

  useEffect(() => {
    const handleData = (event: InkInputEvent) => {
      if (!isActiveRef.current) {
        return;
      }

      const keypress = event.keypress;
      const parsedKey = event.key;
      const key: TerminalKey = {
        upArrow: parsedKey.upArrow,
        downArrow: parsedKey.downArrow,
        leftArrow: parsedKey.leftArrow,
        rightArrow: parsedKey.rightArrow,
        pageDown: parsedKey.pageDown,
        pageUp: parsedKey.pageUp,
        return: parsedKey.return,
        escape: parsedKey.escape,
        ctrl: parsedKey.ctrl,
        shift: parsedKey.shift,
        tab: parsedKey.tab,
        backspace: parsedKey.backspace,
        delete: parsedKey.delete,
        meta: parsedKey.meta,
        home: parsedKey.home,
        end: parsedKey.end,
        space: event.input === " ",
        wheelUp: parsedKey.wheelUp,
        wheelDown: parsedKey.wheelDown,
        name: keypress?.name ?? "",
        raw: keypress?.raw,
        sequence: keypress?.sequence ?? event.input
      };

      const input = event.input;

      if (!(input === "c" && key.ctrl) || !exitOnCtrlCRef.current) {
        inputHandlerRef.current(input, key);
      }
    };

    internal_eventEmitter.on("input", handleData);
    return () => {
      internal_eventEmitter.removeListener("input", handleData);
    };
  }, [internal_eventEmitter]);
}
