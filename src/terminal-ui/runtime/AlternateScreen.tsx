import React, { useInsertionEffect } from "react";
import Box from "./vendor/ink/components/Box.js";
import useStdout from "./vendor/ink/hooks/use-stdout.js";
import inkInstances from "./vendor/ink/instances.js";

type InkRenderInstance = {
  enterAlternateScreen?: () => void;
  exitAlternateScreen?: () => void;
};

export function AlternateScreen(props: { children: React.ReactNode }) {
  const { stdout } = useStdout();

  useInsertionEffect(() => {
    const instance = inkInstances.get(stdout as NodeJS.WriteStream) as InkRenderInstance | undefined;
    instance?.enterAlternateScreen?.();

    return () => {
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
