import React, { useInsertionEffect } from "react";
import Box from "./vendor/ink/components/Box.js";
import useStdout from "./vendor/ink/hooks/use-stdout.js";
import inkInstances from "./vendor/ink/instances.js";

const ENABLE_MOUSE_TRACKING =
  "\u001B[?1000h" +
  "\u001B[?1002h" +
  "\u001B[?1003h" +
  "\u001B[?1006h";
const DISABLE_MOUSE_TRACKING =
  "\u001B[?1006l" +
  "\u001B[?1003l" +
  "\u001B[?1002l" +
  "\u001B[?1000l";

type InkRenderInstance = {
  enterAlternateScreen?: () => void;
  exitAlternateScreen?: () => void;
};

export function AlternateScreen(props: { children: React.ReactNode }) {
  const { stdout } = useStdout();

  useInsertionEffect(() => {
    const instance = inkInstances.get(stdout as NodeJS.WriteStream) as InkRenderInstance | undefined;
    instance?.enterAlternateScreen?.();
    if (stdout.isTTY) {
      stdout.write(ENABLE_MOUSE_TRACKING);
    }

    return () => {
      if (stdout.isTTY) {
        stdout.write(DISABLE_MOUSE_TRACKING);
      }
      const currentInstance = inkInstances.get(stdout as NodeJS.WriteStream) as InkRenderInstance | undefined;
      currentInstance?.exitAlternateScreen?.();
    };
  }, [stdout]);

  return (
    <Box flexDirection="column" width="100%" height={stdout.rows || 24} flexShrink={0}>
      {props.children}
    </Box>
  );
}
