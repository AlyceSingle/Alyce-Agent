import inkInstances from "./ink-runtime/instances.js";

type InkRenderInstance = {
  invalidatePrevFrame?: () => void;
};

export function invalidateInkPrevFrame(stdout: NodeJS.WriteStream) {
  const instance = inkInstances.get(stdout) as InkRenderInstance | undefined;
  instance?.invalidatePrevFrame?.();
}

export default inkInstances;
